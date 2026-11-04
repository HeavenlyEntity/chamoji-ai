import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {loadConfig} from '../../src/config.js';
import {
	applyUnitReleases,
	planUnitReleases,
	pushUnitReleases,
	type UnitReleaseOptions,
	type UnitReleasePlan,
} from '../../src/units/plan.js';
import {createRepo, type RepoStep} from '../helpers/fixture-repo.js';

const execFileAsync = promisify(execFile);
const TODAY = '2026-11-04';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

/** The spec's gearz example, without `upstream.since`: this fixture has no template. */
const GEARZ_CONFIG = {
	release: {
		schema: 1,
		shape: 'apps',
		units: {
			web: {path: 'apps/web', tag: 'web/v{version}'},
			mobile: {
				path: 'apps/mobile',
				tag: 'mobile/v{version}',
				versionFiles: ['apps/mobile/app.config.ts'],
				buildNumber: 'untouched',
			},
		},
		exclude: ['apps/e2e', 'apps/dev-tool', 'tooling/*'],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		zeroMajor: 'minor',
		upstream: {remote: 'upstream', name: 'Makerkit'},
		tags: {
			ignore: ['^\\d+\\.\\d+\\.\\d+$', '^v\\d+\\.\\d+\\.\\d+-\\d+$', '^wip/'],
		},
	},
};

function appFiles(
	webVersion = '0.1.0',
	config: unknown = GEARZ_CONFIG,
): Record<string, string> {
	const uses = {'@gearz/supabase': 'workspace:*'};
	return {
		'package.json': json({name: 'gearz', private: true}),
		'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
		'chamoji.config.json': json(config),
		'apps/web/package.json': json({
			name: '@gearz/web',
			version: webVersion,
			private: true,
			dependencies: uses,
		}),
		'apps/mobile/package.json': json({
			name: '@gearz/mobile',
			version: '1.0.0',
			private: true,
			dependencies: uses,
		}),
		'apps/mobile/app.config.ts':
			"export default {\n\tname: 'mobile',\n\tversion: '1.0.0',\n};\n",
		'apps/e2e/package.json': json({name: '@gearz/e2e', private: true}),
		'packages/supabase/package.json': json({
			name: '@gearz/supabase',
			version: '0.0.0',
			private: true,
		}),
		'packages/supabase/src/index.ts': 'export {};\n',
	};
}

const SHARED_FIX: RepoStep = {
	commit: '🐛 Fix the session refresh',
	files: {'packages/supabase/src/session.ts': 'refresh\n'},
};
const WEB_FEATURE: RepoStep = {
	commit: '✨ Add the dashboard',
	files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
};
const MOBILE_FIX: RepoStep = {
	commit: '🐛 Fix the camera crash',
	files: {'apps/mobile/src/camera.ts': 'camera\n'},
};

/** The gearz app monorepo, released once as web/v0.1.0 and mobile/v1.0.0, then `steps`. */
async function appRepo(
	steps: RepoStep[],
	options: {tags?: boolean; webVersion?: string; webTag?: string} = {},
) {
	const repo = await createRepo([
		{
			commit: '🎉 Start the gearz monorepo',
			files: appFiles(options.webVersion),
		},
		...(options.tags === false
			? []
			: [
					{tag: options.webTag ?? 'web/v0.1.0', annotated: true},
					{tag: 'mobile/v1.0.0', annotated: true},
				]),
		...steps,
	]);
	cleanups.push(repo.cleanup);
	return repo.dir;
}

async function plan(
	dir: string,
	extra: Partial<UnitReleaseOptions> = {},
): Promise<UnitReleasePlan> {
	return planUnitReleases({
		cwd: dir,
		config: await loadConfig(dir),
		today: TODAY,
		...extra,
	});
}

function ready(result: UnitReleasePlan) {
	if (result.status !== 'ready') {
		throw new Error(`expected a ready plan, got ${JSON.stringify(result)}`);
	}

	return result;
}

const unitOf = (result: UnitReleasePlan, name: string) => {
	const found = ready(result).units.find(unit => unit.unit === name);
	if (!found) throw new Error(`${name} isn't releasing`);
	return found;
};

const changeOf = (result: UnitReleasePlan, file: string) => {
	const found = ready(result).changes.find(change => change.file === file);
	if (!found) throw new Error(`${file} isn't changed`);
	return found.text;
};

let day = 400;
/** Runs git in `dir` isolated from the developer's config, one day later each time. */
async function git(dir: string, args: string[]): Promise<string> {
	const empty = path.join(tmpdir(), 'chamoji-plan-test.gitconfig');
	await writeFile(empty, '');
	const when = new Date(Date.UTC(2026, 0, 1) + day++ * 86_400_000);
	const {stdout} = await execFileAsync('git', args, {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: when.toISOString(),
			GIT_COMMITTER_DATE: when.toISOString(),
			GIT_CONFIG_GLOBAL: empty,
			GIT_CONFIG_NOSYSTEM: '1',
		},
	});
	return stdout.trim();
}

async function commitFiles(
	dir: string,
	message: string,
	files: Record<string, string>,
	body?: string,
) {
	for (const [name, text] of Object.entries(files)) {
		const file = path.join(dir, ...name.split('/'));
		await mkdir(path.dirname(file), {recursive: true});
		await writeFile(file, text);
		await git(dir, ['add', '--', name]);
	}

	await git(dir, [
		'commit',
		'-q',
		'-m',
		message,
		...(body ? ['-m', body] : []),
	]);
}

test('a shared-only commit releases nothing', async () => {
	const dir = await appRepo([SHARED_FIX]);
	expect(await plan(dir)).toEqual({
		status: 'nothing',
		pending: [
			{unit: 'web', own: 0, shared: 1},
			{unit: 'mobile', own: 0, shared: 1},
		],
	});
});

test('a unit with commits of its own that need no release is pending', async () => {
	const dir = await appRepo([
		{
			commit: '📝 Document the dashboard',
			files: {'apps/web/README.md': 'dashboard\n'},
		},
		SHARED_FIX,
	]);
	expect(await plan(dir)).toEqual({
		status: 'nothing',
		pending: [
			{unit: 'web', own: 1, shared: 1},
			{unit: 'mobile', own: 0, shared: 1},
		],
	});
	const docsOnly = await appRepo([
		{
			commit: '📝 Document the camera',
			files: {'apps/mobile/README.md': 'camera\n'},
		},
	]);
	expect(await plan(docsOnly)).toEqual({
		status: 'nothing',
		pending: [{unit: 'mobile', own: 1, shared: 0}],
	});
});

test("web's release carries the shared commit once", async () => {
	const dir = await appRepo([SHARED_FIX, WEB_FEATURE]);
	const result = ready(await plan(dir));
	expect(result.units.map(unit => unit.unit)).toEqual(['web']);
	const web = unitOf(result, 'web');
	expect(web).toMatchObject({
		version: '0.2.0',
		tag: 'web/v0.2.0',
		lastTag: 'web/v0.1.0',
		bump: 'minor',
		own: 1,
		shared: 1,
		forced: false,
		disagreed: [],
		files: ['apps/web/CHANGELOG.md', 'apps/web/package.json'],
	});
	expect(web.notes).toMatch(/^## 0\.2\.0 - 2026-11-04\n/);
	expect(web.notes).toContain('✨ Add the dashboard');
	const shared = web.notes
		.split('\n')
		.filter(line => line.includes('Fix the session refresh'));
	expect(shared).toHaveLength(1);
	expect(shared[0]).toContain('(via `packages/supabase`)');

	expect(result.pending).toEqual([{unit: 'mobile', own: 0, shared: 1}]);
	expect(result.changes.map(change => change.file)).toEqual([
		'apps/web/CHANGELOG.md',
		'apps/web/package.json',
	]);
	expect(changeOf(result, 'apps/web/CHANGELOG.md')).toBe(
		`# Changelog\n\n${web.notes}\n`,
	);
	expect(changeOf(result, 'apps/web/package.json')).toContain(
		'"version": "0.2.0"',
	);
	expect(result.subject).toBe('🔖 Release web/v0.2.0');
	expect(result.start).toBe(await git(dir, ['rev-parse', 'HEAD']));
});

test("mobile's first later release carries it once, web's next does not", async () => {
	const dir = await appRepo([SHARED_FIX, WEB_FEATURE]);
	const first = ready(await plan(dir));
	await applyUnitReleases(first);
	expect(await git(dir, ['tag', '--points-at', 'HEAD'])).toBe('web/v0.2.0');
	expect(await git(dir, ['log', '-1', '--format=%s'])).toBe(
		'🔖 Release web/v0.2.0',
	);

	await commitFiles(dir, '🐛 Fix the camera crash', {
		'apps/mobile/src/camera.ts': 'camera\n',
	});
	await commitFiles(dir, '🐛 Fix the dashboard total', {
		'apps/web/src/dashboard.ts': 'total\n',
	});
	const second = ready(await plan(dir));
	expect(second.units.map(unit => unit.unit)).toEqual(['web', 'mobile']);
	const web = unitOf(second, 'web');
	const mobile = unitOf(second, 'mobile');
	expect(web).toMatchObject({version: '0.2.1', own: 1, shared: 0});
	expect(mobile).toMatchObject({version: '1.0.1', own: 1, shared: 1});
	expect(mobile.notes).toContain('Fix the session refresh');
	expect(mobile.notes).toContain('Fix the camera crash');
	expect(web.notes).not.toContain('Fix the session refresh');
	expect(mobile.files).toEqual([
		'apps/mobile/CHANGELOG.md',
		'apps/mobile/package.json',
		'apps/mobile/app.config.ts',
	]);
	expect(changeOf(second, 'apps/mobile/app.config.ts')).toContain(
		"version: '1.0.1'",
	);
	expect(second.subject).toBe('🔖 Release web/v0.2.1, mobile/v1.0.1');
});

test('e2e never releases', async () => {
	const e2e: RepoStep = {
		commit: '✨ Add the checkout test',
		files: {'apps/e2e/checkout.spec.ts': 'test\n'},
	};
	expect(await plan(await appRepo([e2e]))).toEqual({
		status: 'nothing',
		pending: [],
	});

	const result = ready(await plan(await appRepo([e2e, WEB_FEATURE])));
	expect(result.units.map(unit => unit.unit)).toEqual(['web']);
	expect(unitOf(result, 'web').notes).not.toContain('checkout');
	expect(unitOf(result, 'web').own).toBe(1);
	expect(result.excludedNote).toBe(
		'apps/e2e: 1 commit not released (excluded)',
	);
});

test('Release: mobile forces a release', async () => {
	const dir = await appRepo([{...SHARED_FIX, body: 'Release: mobile'}]);
	const result = ready(await plan(dir));
	expect(result.units.map(unit => unit.unit)).toEqual(['mobile']);
	expect(unitOf(result, 'mobile')).toMatchObject({
		version: '1.0.1',
		bump: 'patch',
		own: 0,
		shared: 1,
		forced: true,
	});
	expect(result.pending).toEqual([{unit: 'web', own: 0, shared: 1}]);
});

test('--unit filters', async () => {
	const dir = await appRepo([WEB_FEATURE, MOBILE_FIX]);
	expect(ready(await plan(dir)).units.map(unit => unit.unit)).toEqual([
		'web',
		'mobile',
	]);
	const result = ready(await plan(dir, {units: ['web']}));
	expect(result.units.map(unit => unit.unit)).toEqual(['web']);
	expect(
		result.changes.every(change => change.file.startsWith('apps/web/')),
	).toBe(true);
	await expect(plan(dir, {units: ['desktop']})).rejects.toThrow(
		'unknown unit "desktop"; the units are web, mobile',
	);
});

test('--unit with only shared commits forces a patch release', async () => {
	const dir = await appRepo([SHARED_FIX]);
	const result = ready(await plan(dir, {units: ['web']}));
	expect(result.units.map(unit => unit.unit)).toEqual(['web']);
	expect(unitOf(result, 'web')).toMatchObject({
		version: '0.1.1',
		forced: true,
		own: 0,
		shared: 1,
	});
});

test('apply makes one commit and one tag per unit, and rolls back on failure', async () => {
	const dir = await appRepo([WEB_FEATURE, MOBILE_FIX], {tags: false});
	const result = ready(await plan(dir));
	expect(result.units.map(unit => [unit.unit, unit.tag, unit.bump])).toEqual([
		['web', 'web/v0.1.0', 'first'],
		['mobile', 'mobile/v1.0.0', 'first'],
	]);

	// Someone tags web/v0.1.0 on another commit after the plan was made.
	const other = await git(dir, ['rev-parse', 'HEAD~1']);
	await git(dir, ['tag', '-a', '-m', 'web/v0.1.0', 'web/v0.1.0', other]);
	await expect(applyUnitReleases(result)).rejects.toThrow(
		/Rolled back to [0-9a-f]{7}; nothing was released\./,
	);
	expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(result.start);
	expect(await git(dir, ['status', '--porcelain'])).toBe('');
	// The tag that was already there is never touched; none of ours is left.
	expect(await git(dir, ['tag', '--list'])).toBe('web/v0.1.0');
	expect(await git(dir, ['rev-parse', 'web/v0.1.0^{commit}'])).toBe(other);
});

test('a failed second tag removes the first', async () => {
	const dir = await appRepo([WEB_FEATURE, MOBILE_FIX], {tags: false});
	const result = ready(await plan(dir));
	const other = await git(dir, ['rev-parse', 'HEAD~1']);
	await git(dir, ['tag', 'mobile/v1.0.0', other]);
	await expect(applyUnitReleases(result)).rejects.toThrow(/Rolled back/);
	expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(result.start);
	expect(await git(dir, ['tag', '--list'])).toBe('mobile/v1.0.0');
	expect(await git(dir, ['status', '--porcelain'])).toBe('');
});

test('apply then push sends HEAD and every tag', async () => {
	const dir = await appRepo([WEB_FEATURE, MOBILE_FIX], {tags: false});
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-origin-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await git(remote, ['init', '-q', '--bare']);
	await git(dir, ['remote', 'add', 'origin', remote]);

	const result = ready(await plan(dir, {fetch: false}));
	const {commit} = await applyUnitReleases(result, {
		trailers: ['Workstream: releases'],
	});
	expect(await git(dir, ['rev-parse', '--short', 'HEAD'])).toBe(commit);
	expect(await git(dir, ['rev-list', '--count', `${result.start}..HEAD`])).toBe(
		'1',
	);
	expect(
		(await git(dir, ['tag', '--points-at', 'HEAD'])).split('\n').sort(),
	).toEqual(['mobile/v1.0.0', 'web/v0.1.0']);
	expect(await git(dir, ['cat-file', '-t', 'web/v0.1.0'])).toBe('tag');
	expect(await git(dir, ['log', '-1', '--format=%(trailers:only)'])).toBe(
		'Workstream: releases',
	);
	expect(
		await readFile(path.join(dir, 'apps', 'web', 'CHANGELOG.md'), 'utf8'),
	).toBe(changeOf(result, 'apps/web/CHANGELOG.md'));

	await pushUnitReleases(result);
	const head = await git(dir, ['rev-parse', 'HEAD']);
	expect(await git(remote, ['rev-parse', 'main'])).toBe(head);
	expect((await git(remote, ['tag', '--list'])).split('\n').sort()).toEqual([
		'mobile/v1.0.0',
		'web/v0.1.0',
	]);
});

/** acme: core and types in a fixed group, cli and plugin depending on core, and an internal utils package that core uses. */
async function libraryRepo(steps: RepoStep[]) {
	const files = {
		'package.json': json({name: 'acme', private: true}),
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'chamoji.config.json': json({
			release: {
				schema: 1,
				shape: 'libraries',
				units: {
					core: {path: 'packages/core'},
					types: {path: 'packages/types'},
					cli: {path: 'packages/cli'},
					plugin: {path: 'packages/plugin'},
				},
				fixed: [['core', 'types']],
			},
		}),
		'packages/cli/package.json': json({
			name: '@acme/cli',
			version: '1.0.0',
			dependencies: {'@acme/core': '^1.0.0', '@acme/types': 'workspace:^'},
		}),
		'packages/core/package.json': json({
			name: '@acme/core',
			version: '1.0.0',
			dependencies: {'@acme/utils': 'workspace:*'},
		}),
		'packages/plugin/package.json': json({
			name: '@acme/plugin',
			version: '2.0.0',
			peerDependencies: {'@acme/core': '^1.0.0'},
		}),
		'packages/types/package.json': json({
			name: '@acme/types',
			version: '1.0.0',
		}),
		'packages/utils/package.json': json({
			name: '@acme/utils',
			version: '0.0.0',
			private: true,
		}),
	};
	const repo = await createRepo([
		{commit: '🎉 Start acme', files},
		{tag: '@acme/core@1.0.0', annotated: true},
		{tag: '@acme/types@1.0.0', annotated: true},
		{tag: '@acme/cli@1.0.0', annotated: true},
		{tag: '@acme/plugin@2.0.0', annotated: true},
		...steps,
	]);
	cleanups.push(repo.cleanup);
	return repo.dir;
}

const ACME_RELEASES = [
	['core', '@acme/core@1.0.1', '1.0.1', 'patch'],
	['types', '@acme/types@1.0.1', '1.0.1', 'fixed'],
	['cli', '@acme/cli@1.0.1', '1.0.1', 'patch'],
	['plugin', '@acme/plugin@2.0.1', '2.0.1', 'patch'],
];

test('libraries: fixed groups and ranges', async () => {
	const dir = await libraryRepo([
		{
			commit: '🐛 Fix the parser',
			files: {'packages/core/src/parse.ts': 'parse\n'},
		},
	]);
	const result = ready(await plan(dir));
	expect(
		result.units.map(unit => [unit.unit, unit.tag, unit.version, unit.bump]),
	).toEqual(ACME_RELEASES);
	// A fixed-group member with no commits says what it released with.
	expect(unitOf(result, 'types').notes).toBe(
		"## 1.0.1 - 2026-11-04\n\n### Changed\n\n- Released with core at the group's version",
	);
	const cli = unitOf(result, 'cli');
	expect(cli.notes).toContain('### Dependencies');
	expect(cli.notes).toContain('@acme/core');
	expect(cli.files).toEqual([
		'packages/cli/CHANGELOG.md',
		'packages/cli/package.json',
	]);
	const manifest = changeOf(result, 'packages/cli/package.json');
	expect(manifest).toContain('"version": "1.0.1"');
	expect(manifest).toContain('"@acme/core": "^1.0.1"');
	expect(manifest).toContain('"@acme/types": "workspace:^"');
	expect(unitOf(result, 'core').notes).toContain('Fix the parser');
	// A peer range is left as written; the release still names the dependency.
	expect(unitOf(result, 'plugin').notes).toContain('@acme/core');
	const plugin = changeOf(result, 'packages/plugin/package.json');
	expect(plugin).toContain('"version": "2.0.1"');
	expect(plugin).toContain('"@acme/core": "^1.0.0"');
	expect(result.subject).toBe(
		'🔖 Release @acme/core@1.0.1, @acme/types@1.0.1, @acme/cli@1.0.1, @acme/plugin@2.0.1',
	);
});

test('release-dependents: shared commits release a unit only when they imply a bump', async () => {
	const docs: RepoStep = {
		commit: '📝 Document the date helpers',
		files: {'packages/utils/README.md': 'dates\n'},
	};
	expect(await plan(await libraryRepo([docs]))).toEqual({
		status: 'nothing',
		pending: [{unit: 'core', own: 0, shared: 1}],
	});

	const dir = await libraryRepo([
		docs,
		{
			commit: '🐛 Fix the date helper',
			files: {'packages/utils/date.ts': 'date\n'},
		},
	]);
	const result = ready(await plan(dir));
	expect(
		result.units.map(unit => [unit.unit, unit.tag, unit.version, unit.bump]),
	).toEqual(ACME_RELEASES);
	expect(unitOf(result, 'core')).toMatchObject({
		own: 0,
		shared: 2,
		forced: false,
	});
	expect(unitOf(result, 'core').notes).toContain('Fix the date helper (');
	expect(unitOf(result, 'core').notes).toContain('(via `packages/utils`)');
});

test("upstream: a fork's first release leaves the template out", async () => {
	const template: RepoStep[] = [
		{
			commit: '🎉 Start the template',
			files: {
				'package.json': json({name: 'template', private: true}),
				'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
				'apps/web/package.json': json({name: '@kit/web', version: '0.1.0'}),
				'apps/admin/package.json': json({
					name: '@kit/admin',
					version: '0.1.0',
					dependencies: {'@kit/ui': 'workspace:*'},
				}),
				'packages/ui/package.json': json({name: '@kit/ui', version: '0.0.0'}),
				'apps/web/x.ts': 'x\n',
			},
		},
	];
	for (let i = 2; i <= 30; i++) {
		template.push({
			commit: `✨ Upstream change ${i}`,
			files: {[`apps/web/u${i}.ts`]: `${i}\n`},
		});
		if (i === 10) template.push({tag: '4.0.1', annotated: true});
		if (i === 30) template.push({tag: '4.0.2', annotated: true});
	}

	const upstream = await createRepo(template);
	cleanups.push(upstream.cleanup);
	const parent = await mkdtemp(path.join(tmpdir(), 'chamoji-fork-'));
	cleanups.push(async () => rm(parent, {recursive: true, force: true}));
	const dir = path.join(parent, 'app');
	await git(parent, ['clone', '-q', upstream.dir, 'app']);
	await git(dir, ['remote', 'rename', 'origin', 'upstream']);
	for (const [key, value] of [
		['user.name', 'Dev'],
		['user.email', 'dev@example.com'],
		['commit.gpgsign', 'false'],
		['tag.gpgsign', 'false'],
	] as const) {
		await git(dir, ['config', key, value]);
	}

	await commitFiles(dir, '🔧 Configure chamoji', {
		'chamoji.config.json': json({
			release: {
				schema: 1,
				shape: 'apps',
				units: {web: {path: 'apps/web'}, admin: {path: 'apps/admin'}},
				upstream: {remote: 'upstream', name: 'Makerkit'},
				tags: {ignore: ['^\\d+\\.\\d+\\.\\d+$']},
			},
		}),
	});
	await commitFiles(dir, '✨ Add the dashboard', {'apps/web/a.ts': 'a\n'});
	await commitFiles(dir, '🐛 Fix the dashboard', {'apps/web/b.ts': 'b\n'});
	await commitFiles(dir, '🐛 Fix the button', {'packages/ui/button.ts': 'b\n'});

	await commitFiles(upstream.dir, '✨ Upstream change 31', {
		'src/u31.ts': '31\n',
	});
	await commitFiles(upstream.dir, '✨ Upstream change 32', {
		'src/u32.ts': '32\n',
	});
	await commitFiles(upstream.dir, '✨ Upstream change 33', {
		'apps/web/x.ts': '33\n',
	});
	await git(upstream.dir, ['tag', '-a', '4.0.3', '-m', '4.0.3']);
	await git(dir, ['fetch', '-q', 'upstream', '--tags']);
	await git(dir, [
		'merge',
		'--no-ff',
		'-q',
		'-m',
		'Merge upstream/main',
		'upstream/main',
	]);

	const result = ready(await plan(dir));
	// The sync doesn't touch admin, so it is no own commit of admin's.
	expect(result.units.map(unit => unit.unit)).toEqual(['web']);
	expect(result.pending).toEqual([{unit: 'admin', own: 0, shared: 1}]);
	const web = unitOf(result, 'web');
	expect(web).toMatchObject({
		version: '0.1.0',
		tag: 'web/v0.1.0',
		lastTag: null,
		bump: 'first',
		own: 3,
		shared: 0,
	});
	expect(web.notes).not.toContain('Upstream change');
	expect(web.notes).toContain('Add the dashboard');
	expect(web.notes).toContain('Fix the dashboard');
	expect(web.notes.match(/Updated the Makerkit base to 4\.0\.3/g)).toHaveLength(
		1,
	);
	expect(web.notes).not.toContain('Configure chamoji');
});

test('tag versus manifest', async () => {
	const dir = await appRepo(
		[{commit: '🐛 Fix the login', files: {'apps/web/login.ts': 'login\n'}}],
		{webTag: 'web/v1.2.0'},
	);
	const web = unitOf(await plan(dir), 'web');
	expect(web).toMatchObject({
		version: '1.2.1',
		lastTag: 'web/v1.2.0',
		disagreed: ['apps/web/package.json'],
	});
});

test('a version override is checked as planRelease checks it', async () => {
	const dir = await appRepo([WEB_FEATURE]);
	const result = ready(await plan(dir, {versions: {web: '1.0.0'}}));
	expect(unitOf(result, 'web')).toMatchObject({
		version: '1.0.0',
		bump: 'major',
	});
	await expect(plan(dir, {versions: {web: '0.1.0'}})).rejects.toThrow(
		'0.1.0 is not newer than the last release, web/v0.1.0',
	);
	await expect(plan(dir, {versions: {web: 'next'}})).rejects.toThrow(
		'next is not a semver version',
	);
});

test('rootFiles note adds a Tooling and CI line, and a root changelog lists the releases', async () => {
	const config = structuredClone(GEARZ_CONFIG) as {
		release: Record<string, unknown>;
	};
	config.release.rootFiles = 'note';
	config.release.rootChangelog = true;
	const repo = await createRepo([
		{commit: '🎉 Start the gearz monorepo', files: appFiles('0.1.0', config)},
		{tag: 'web/v0.1.0', annotated: true},
		{tag: 'mobile/v1.0.0', annotated: true},
		{commit: '👷 Cache the build', files: {'.github/workflows/ci.yml': 'ci\n'}},
		{commit: '🔧 Tidy the root', files: {'turbo.json': '{}\n'}},
	]);
	cleanups.push(repo.cleanup);
	expect((await plan(repo.dir)).status).toBe('nothing');

	await commitFiles(repo.dir, '🐛 Fix the login', {'apps/web/login.ts': 'x\n'});
	const result = ready(await plan(repo.dir));
	expect(result.units.map(unit => unit.unit)).toEqual(['web']);
	expect(unitOf(result, 'web').notes).toContain('- Tooling and CI: 2 changes');
	expect(result.changes.at(-1)).toEqual({
		file: 'CHANGELOG.md',
		text: '# Changelog\n\n## 2026-11-04\n\n- web [0.1.1](apps/web/CHANGELOG.md)\n',
		how: 'created with this release',
	});
});

test('planning a dirty tree with allowDirty changes nothing', async () => {
	const dir = await appRepo([WEB_FEATURE]);
	await writeFile(path.join(dir, 'apps', 'web', 'package.json'), '{"x": 1}\n');
	await writeFile(path.join(dir, 'staged.ts'), 'staged\n');
	await git(dir, ['add', '--', 'staged.ts']);
	await writeFile(path.join(dir, 'untracked.ts'), 'untracked\n');
	const state = async () =>
		Promise.all([
			git(dir, ['status', '--porcelain', '--untracked-files=all']),
			git(dir, ['diff']),
			git(dir, ['diff', '--cached']),
			git(dir, ['rev-parse', 'HEAD']),
			git(dir, ['for-each-ref']),
		]);
	const before = await state();

	await expect(plan(dir)).rejects.toThrow(/uncommitted changes/);
	expect(ready(await plan(dir, {allowDirty: true})).units).toHaveLength(1);
	expect(await state()).toEqual(before);
});

test('a first release lists a version file that disagrees with the manifest', async () => {
	const dir = await appRepo(
		[
			{
				commit: '🔧 Set the app version by hand',
				files: {
					'apps/mobile/app.config.ts':
						"export default {\n\tname: 'mobile',\n\tversion: '1.2.0',\n};\n",
				},
			},
			MOBILE_FIX,
		],
		{tags: false},
	);
	const mobile = unitOf(await plan(dir), 'mobile');
	expect(mobile).toMatchObject({
		version: '1.0.0',
		from: '1.0.0',
		lastTag: null,
		disagreed: ['apps/mobile/app.config.ts'],
	});
});
