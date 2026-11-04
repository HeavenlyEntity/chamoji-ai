import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type RepoStep,
} from '../../core/test/helpers/fixture-repo.js';
import {run, type GhRunner} from '../src/run.js';
import {recordingFace} from './helpers/recording-face.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

const RELEASE = {
	schema: 1,
	shape: 'apps',
	units: {
		web: {path: 'apps/web', tag: 'web/v{version}'},
		mobile: {path: 'apps/mobile', tag: 'mobile/v{version}'},
	},
	exclude: ['apps/dev-tool'],
};

const uses = {'@gearz/supabase': 'workspace:*'};

/** An app monorepo: web and mobile on a shared supabase package, plus a dev tool. Null `release` writes no config. */
function appFiles(release: unknown = RELEASE): Record<string, string> {
	return {
		'package.json': json({name: 'gearz', private: true}),
		'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
		...(release === null ? {} : {'chamoji.config.json': json({release})}),
		'apps/web/package.json': json({
			name: '@gearz/web',
			version: '0.1.0',
			private: true,
			dependencies: uses,
		}),
		'apps/mobile/package.json': json({
			name: '@gearz/mobile',
			version: '1.0.0',
			private: true,
			dependencies: uses,
		}),
		'apps/dev-tool/package.json': json({
			name: '@gearz/dev-tool',
			private: true,
		}),
		'packages/supabase/package.json': json({
			name: '@gearz/supabase',
			version: '0.0.0',
			private: true,
		}),
	};
}

const WEB_FEATURE: RepoStep = {
	commit: '✨ Add the dashboard',
	files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
};
const MOBILE_FIX: RepoStep = {
	commit: '🐛 Fix the camera crash',
	files: {'apps/mobile/src/camera.ts': 'camera\n'},
};
const SHARED_FIX: RepoStep = {
	commit: '🐛 Fix the session refresh',
	files: {'packages/supabase/src/session.ts': 'refresh\n'},
};
const SHARED_FEATURE: RepoStep = {
	commit: '✨ Add session timeouts',
	files: {'packages/supabase/src/timeout.ts': 'timeout\n'},
};
const TAGGED: RepoStep[] = [
	{tag: 'web/v0.1.0', annotated: true},
	{tag: 'mobile/v1.0.0', annotated: true},
];

async function appRepo(
	steps: RepoStep[],
	release: unknown = RELEASE,
): Promise<string> {
	const repo = await createRepo([
		{commit: '🎉 Start the gearz monorepo', files: appFiles(release)},
		...steps,
	]);
	cleanups.push(repo.cleanup);
	await gitOutput(repo.dir, ['config', 'user.name', 'Dev']);
	await gitOutput(repo.dir, ['config', 'user.email', 'dev@example.com']);
	return repo.dir;
}

async function chamoji(
	argv: string[],
	cwd: string,
	options: {gh?: GhRunner; env?: Record<string, string>} = {},
) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-11-04',
		fetchTags: false,
		gh: options.gh,
		env: options.env ?? {},
	});
	return {code, stdout, stderr};
}

async function withRemote(dir: string): Promise<string> {
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare']);
	await gitOutput(dir, ['remote', 'add', 'origin', remote]);
	return remote;
}

test('dry-run lists each unit', async () => {
	const dir = await appRepo([WEB_FEATURE, MOBILE_FIX]);
	const before = await gitOutput(dir, ['rev-parse', 'HEAD']);
	const {code, stdout} = await chamoji(['release', '--dry-run'], dir);
	expect(code).toBe(0);
	const lines = stdout.split('\n');
	expect(lines.slice(0, 3)).toEqual([
		'Would release:',
		'web  0.1.0 → 0.1.0  first  2 own, 0 shared',
		'mobile  1.0.0 → 1.0.0  first  2 own, 0 shared',
	]);
	expect(stdout).toContain(
		'files: apps/web/CHANGELOG.md, apps/web/package.json, apps/mobile/CHANGELOG.md, apps/mobile/package.json',
	);
	expect(stdout).toContain('## web/v0.1.0\n');
	expect(stdout).toContain('## mobile/v1.0.0\n');
	expect(stdout).toContain('Add the dashboard');
	expect(stdout).toContain('Fix the camera crash');
	expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(before);
	expect((await gitOutput(dir, ['tag', '--list'])).trim()).toBe('');
});

test('dry-run names excluded apps that have commits', async () => {
	const dir = await appRepo([
		...TAGGED,
		WEB_FEATURE,
		{
			commit: '✨ Add a seed command',
			files: {'apps/dev-tool/seed.ts': 'seed\n'},
		},
		{
			commit: '🐛 Fix the seed command',
			files: {'apps/dev-tool/seed.ts': 'seed!\n'},
		},
	]);
	const {code, stdout} = await chamoji(['release', '--dry-run'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('web  0.1.0 → 0.2.0  minor  1 own, 0 shared\n');
	expect(stdout).toContain(
		'apps/dev-tool: 2 commits not released (excluded)\n',
	);
});

test('dry-run notes a version file that disagreed with the last tag', async () => {
	const dir = await appRepo([
		...TAGGED,
		{
			commit: '🔧 Set the web version by hand',
			files: {
				'apps/web/package.json': json({
					name: '@gearz/web',
					version: '0.1.5',
					private: true,
					dependencies: uses,
				}),
			},
		},
		WEB_FEATURE,
	]);
	const {code, stdout} = await chamoji(['release', '--dry-run'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain(
		'note: apps/web/package.json had a version other than 0.1.0 (web/v0.1.0); it now says 0.2.0\n',
	);
});

test('json has units and keeps nothing-status shape', async () => {
	const dir = await appRepo([...TAGGED, SHARED_FIX]);
	const {code, stdout} = await chamoji(['release', '--json'], dir);
	expect(code).toBe(3);
	expect(JSON.parse(stdout)).toEqual({
		status: 'nothing',
		pending: [
			{unit: 'web', own: 0, shared: 1},
			{unit: 'mobile', own: 0, shared: 1},
		],
	});

	const text = await chamoji(['release'], dir);
	expect(text.code).toBe(3);
	expect(text.stdout).toBe(
		[
			'Nothing to release: no unit has a commit of its own that implies a version bump.',
			'web: no changes of its own; 1 shared change rides along with its next release',
			'mobile: no changes of its own; 1 shared change rides along with its next release',
			'',
		].join('\n'),
	);

	const ready = await appRepo([...TAGGED, WEB_FEATURE, SHARED_FIX]);
	const dry = await chamoji(['release', '--dry-run', '--json'], ready);
	expect(dry.code).toBe(0);
	const parsed = JSON.parse(dry.stdout) as Record<string, unknown>;
	expect(Object.keys(parsed)).toEqual([
		'status',
		'units',
		'files',
		'warnings',
		'pending',
	]);
	expect(parsed).toMatchObject({
		status: 'dry-run',
		units: [
			{
				unit: 'web',
				version: '0.2.0',
				tag: 'web/v0.2.0',
				from: '0.1.0',
				bump: 'minor',
				own: 1,
				shared: 1,
			},
		],
		files: ['apps/web/CHANGELOG.md', 'apps/web/package.json'],
		warnings: [],
		pending: [{unit: 'mobile', own: 0, shared: 1}],
	});
});

test('a version needs one --unit', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	const bare = await chamoji(['release', '2.0.0'], dir);
	expect(bare.code).toBe(1);
	expect(bare.stderr).toBe(
		'chamoji: give --unit with a version, for example: chamoji release 2.0.0 --unit mobile\n',
	);
	const two = await chamoji(
		['release', '2.0.0', '--unit', 'web', '--unit', 'mobile'],
		dir,
	);
	expect(two.code).toBe(1);

	const {code, stdout} = await chamoji(
		['release', '2.0.0', '--unit', 'mobile', '--dry-run', '--json'],
		dir,
	);
	expect(code).toBe(0);
	const {units} = JSON.parse(stdout) as {units: Array<{unit: string}>};
	expect(units).toMatchObject([
		{unit: 'mobile', version: '2.0.0', tag: 'mobile/v2.0.0', bump: 'major'},
	]);
});

test('a unit left out by --unit says so, not that it needs no release', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX, SHARED_FIX]);
	const left =
		'mobile: left out by --unit (1 change of its own, 1 shared waiting)\n';
	const dry = await chamoji(['release', '--unit', 'web', '--dry-run'], dir);
	expect(dry.code).toBe(0);
	expect(dry.stdout).toContain(left);
	expect(dry.stdout).not.toContain('no release needed');

	const released = await chamoji(['release', '--unit', 'web'], dir);
	expect(released.code).toBe(0);
	expect(released.stdout.split('\n')[0]).toBe('Released web/v0.2.0.');
	expect(released.stdout).toContain(left);
});

test('an unknown --unit exits 1 with the core error', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE]);
	const {code, stderr} = await chamoji(
		['release', '--unit', 'admin', '--dry-run'],
		dir,
	);
	expect(code).toBe(1);
	expect(stderr).toBe(
		'chamoji: unknown unit "admin"; the units are web, mobile\n',
	);
});

test('release commits once and tags each unit', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	const {code, stdout} = await chamoji(['release'], dir);
	expect(code).toBe(0);
	const lines = stdout.split('\n');
	expect(lines[0]).toBe('Released web/v0.2.0, mobile/v1.0.1.');
	expect(stdout).toContain('web  0.1.0 → 0.2.0  minor  1 own, 0 shared\n');
	expect(stdout).toContain('mobile  1.0.0 → 1.0.1  patch  1 own, 0 shared\n');
	expect(stdout).toContain('tags: web/v0.2.0, mobile/v1.0.1 (annotated)\n');
	expect(stdout).toContain(
		'pushed: no; to ship: git push origin HEAD web/v0.2.0 mobile/v1.0.1\n',
	);
	expect(stdout).toMatch(
		/undo before pushing: git tag -d web\/v0\.2\.0 mobile\/v1\.0\.1 && git reset --hard [0-9a-f]{7}\n/,
	);
	expect((await gitOutput(dir, ['tag', '--list'])).trim().split('\n')).toEqual([
		'mobile/v1.0.0',
		'mobile/v1.0.1',
		'web/v0.1.0',
		'web/v0.2.0',
	]);
});

test('push creates one GitHub release per unit tag', async () => {
	const dir = await appRepo([
		{tag: 'web/v0.1.0', annotated: true},
		WEB_FEATURE,
		MOBILE_FIX,
	]);
	const remote = await withRemote(dir);
	const calls: string[][] = [];
	const gh: GhRunner = async args => {
		calls.push(args);
		return {ok: true, message: 'https://github.com/acme/gearz/releases'};
	};

	const {code, stdout} = await chamoji(['release', '--push', '--json'], dir, {
		gh,
	});
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({
		status: 'released',
		pushed: true,
		githubRelease: true,
	});
	expect(calls.map(args => args.slice(0, 5))).toEqual([
		['release', 'create', 'web/v0.2.0', '--title', 'web/v0.2.0'],
		['release', 'create', 'mobile/v1.0.0', '--title', 'mobile/v1.0.0'],
	]);
	expect(
		(await gitOutput(remote, ['tag', '--list'])).trim().split('\n'),
	).toEqual(['mobile/v1.0.0', 'web/v0.2.0']);
});

test('push makes one combined GitHub release when asked to', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX], {
		...RELEASE,
		githubReleases: 'combined',
	});
	await withRemote(dir);
	const calls: string[][] = [];
	const notes: string[] = [];
	const gh: GhRunner = async args => {
		calls.push(args);
		const {readFile} = await import('node:fs/promises');
		notes.push(await readFile(args[args.indexOf('--notes-file') + 1]!, 'utf8'));
		return {ok: true, message: ''};
	};

	const {code, stdout} = await chamoji(['release', '--push'], dir, {gh});
	expect(code).toBe(0);
	expect(stdout).toContain(
		'pushed: yes (HEAD and web/v0.2.0, mobile/v1.0.1); GitHub release created\n',
	);
	expect(calls.map(args => args.slice(0, 5))).toEqual([
		['release', 'create', 'web/v0.2.0', '--title', 'web/v0.2.0, mobile/v1.0.1'],
	]);
	expect(notes[0]).toContain('## web/v0.2.0\n');
	expect(notes[0]).toContain('## mobile/v1.0.1\n');
});

test('a failed GitHub release is reported per tag and keeps the release', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	await withRemote(dir);
	const gh: GhRunner = async args =>
		args[2] === 'mobile/v1.0.1'
			? {ok: false, message: 'gh: not logged in'}
			: {ok: true, message: ''};
	const {code, stdout} = await chamoji(['release', '--push'], dir, {gh});
	expect(code).toBe(0);
	expect(stdout).toContain(
		'pushed: yes (HEAD and web/v0.2.0, mobile/v1.0.1); GitHub release not created for mobile/v1.0.1: gh: not logged in\n',
	);
});

test('a GitHub release that fails before gh runs keeps the push a success', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	await withRemote(dir);
	const gitDir = (
		await gitOutput(dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	// The notes file can't be written where a folder has its name.
	await mkdir(path.join(gitDir, 'chamoji-release-notes.md'));
	const calls: string[][] = [];
	const gh: GhRunner = async args => {
		calls.push(args);
		return {ok: true, message: ''};
	};
	const {code, stdout} = await chamoji(['release', '--push', '--json'], dir, {
		gh,
	});
	expect(code).toBe(0);
	const result = JSON.parse(stdout) as Record<string, unknown>;
	expect(result).toMatchObject({pushed: true, githubRelease: false});
	expect(result).not.toHaveProperty('error');
	expect(calls).toEqual([]);
});

test('push shows each step on the face, one GitHub release step per tag', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	await withRemote(dir);
	const {face, calls} = recordingFace();
	const gh: GhRunner = async args =>
		args[2] === 'mobile/v1.0.1'
			? {ok: false, message: 'gh: not logged in'}
			: {ok: true, message: ''};
	const code = await run(['release', '--push'], {
		cwd: dir,
		stdout() {},
		stderr() {},
		today: '2026-11-04',
		fetchTags: false,
		gh,
		env: {},
		face,
	});
	expect(code).toBe(0);
	expect(calls).toEqual([
		['step', 'Planning the release'],
		['end', 'ok', 'Ready to release web/v0.2.0, mobile/v1.0.1'],
		['step', 'Pushing HEAD and web/v0.2.0, mobile/v1.0.1'],
		['end', 'ok', 'Pushed HEAD and web/v0.2.0, mobile/v1.0.1'],
		['step', 'Creating the GitHub release for web/v0.2.0'],
		['end', 'ok', 'Created the GitHub release for web/v0.2.0'],
		['step', 'Creating the GitHub release for mobile/v1.0.1'],
		['end', 'warn', 'GitHub release for mobile/v1.0.1 not created'],
		['stop'],
	]);
});

test('next-version prints per unit, including riders', async () => {
	const dir = await appRepo([
		...TAGGED,
		WEB_FEATURE,
		SHARED_FIX,
		SHARED_FEATURE,
	]);
	const {code, stdout} = await chamoji(['next-version'], dir);
	expect(code).toBe(0);
	expect(stdout).toBe(
		'web: 0.2.0\nmobile: no changes of its own; 2 shared changes ride along with its next release\n',
	);

	const asJson = await chamoji(['next-version', '--json'], dir);
	expect(asJson.code).toBe(0);
	expect(JSON.parse(asJson.stdout)).toEqual({
		units: [
			{unit: 'web', version: '0.2.0', own: 1, shared: 2},
			{unit: 'mobile', version: null, own: 0, shared: 2},
		],
	});

	const quiet = await appRepo([...TAGGED, SHARED_FIX]);
	const none = await chamoji(['next-version'], quiet);
	expect(none.code).toBe(3);
	expect(none.stdout).toBe(
		'web: no changes of its own; 1 shared change rides along with its next release\nmobile: no changes of its own; 1 shared change rides along with its next release\n',
	);

	const idle = await appRepo([...TAGGED, MOBILE_FIX]);
	const one = await chamoji(['next-version'], idle);
	expect(one.code).toBe(0);
	expect(one.stdout).toBe('web: nothing to release\nmobile: 1.0.1\n');
});

test('next-version counts own commits that need no release', async () => {
	const webDocs: RepoStep = {
		commit: '📝 Document the dashboard',
		files: {'apps/web/README.md': 'dashboard\n'},
	};
	const dir = await appRepo([...TAGGED, webDocs, SHARED_FIX]);
	const text = await chamoji(['next-version'], dir);
	expect(text.code).toBe(3);
	expect(text.stdout).toBe(
		[
			"web: no release needed (1 change of its own doesn't need one); 1 shared change rides along with its next release",
			'mobile: no changes of its own; 1 shared change rides along with its next release',
			'',
		].join('\n'),
	);
	const asJson = await chamoji(['next-version', '--json'], dir);
	expect(asJson.code).toBe(3);
	expect(JSON.parse(asJson.stdout)).toEqual({
		units: [
			{unit: 'web', version: null, own: 1, shared: 1},
			{unit: 'mobile', version: null, own: 0, shared: 1},
		],
	});

	const docsOnly = await appRepo([
		...TAGGED,
		webDocs,
		{
			commit: '📝 Document the settings',
			files: {'apps/web/SETTINGS.md': 'settings\n'},
		},
	]);
	const only = await chamoji(['next-version'], docsOnly);
	expect(only.code).toBe(3);
	expect(only.stdout).toBe(
		"web: no release needed (2 changes of its own don't need one)\nmobile: nothing to release\n",
	);
	const release = await chamoji(['release', '--json'], docsOnly);
	expect(release.code).toBe(3);
	expect(JSON.parse(release.stdout)).toEqual({
		status: 'nothing',
		pending: [{unit: 'web', own: 2, shared: 0}],
	});
});

test('next-version --unit forces and shows only that unit', async () => {
	const dir = await appRepo([...TAGGED, SHARED_FIX]);
	const {code, stdout} = await chamoji(
		['next-version', '--unit', 'mobile'],
		dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe('mobile: 1.0.1\n');
});

test('--unit and --for-tag need a release section', async () => {
	const dir = await appRepo([WEB_FEATURE], null);
	const refused =
		'chamoji: --unit and --for-tag need release units; add them under release.units in chamoji.config.json\n';
	for (const argv of [
		['changelog', '--unit', 'web'],
		['changelog', '--for-tag', 'web/v0.1.0'],
		['release', '--unit', 'web', '--dry-run'],
		['next-version', '--for-tag', 'web/v0.1.0'],
	]) {
		const result = await chamoji(argv, dir, {env: {CI: 'true'}});
		expect(result, argv.join(' ')).toEqual({
			code: 1,
			stdout: '',
			stderr: refused,
		});
	}
});

test('changelog --unit renders the unit’s releases', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	expect((await chamoji(['release'], dir)).code).toBe(0);
	await gitOutput(dir, ['commit', '--allow-empty', '-q', '-m', '📝 Notes']);
	const {code, stdout} = await chamoji(['changelog', '--unit', 'web'], dir);
	expect(code).toBe(0);
	expect(stdout.startsWith('# Changelog\n')).toBe(true);
	expect(stdout).toContain('## 0.2.0 - ');
	expect(stdout).toContain('## 0.1.0 - ');
	expect(stdout).toContain('Add the dashboard');
	expect(stdout).not.toContain('Fix the camera crash');

	const asJson = await chamoji(
		['changelog', '--unit', 'mobile', '--format', 'json'],
		dir,
	);
	expect(asJson.code).toBe(0);
	const {releases} = JSON.parse(asJson.stdout) as {
		releases: Array<{tag: string}>;
	};
	expect(releases.map(release => release.tag)).toEqual([
		'mobile/v1.0.1',
		'mobile/v1.0.0',
	]);
});

test('changelog --for-tag prints one section', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE, MOBILE_FIX]);
	expect((await chamoji(['release'], dir)).code).toBe(0);
	const {code, stdout} = await chamoji(
		['changelog', '--for-tag', 'web/v0.2.0'],
		dir,
	);
	expect(code).toBe(0);
	expect(stdout.match(/^## /gm)).toHaveLength(1);
	expect(stdout).toContain('## 0.2.0 - ');
	expect(stdout).toContain('Add the dashboard');
	expect(stdout).not.toContain('camera');

	const other = await chamoji(['changelog', '--for-tag', 'v9.9.9'], dir);
	expect(other.code).toBe(1);
	expect(other.stderr).toBe("chamoji: no unit's tag format matches v9.9.9\n");
});

test('changelog in a repo with units needs --unit or --for-tag', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE]);
	const {code, stderr, stdout} = await chamoji(['changelog'], dir);
	expect(code).toBe(1);
	expect(stdout).toBe('');
	expect(stderr).toBe(
		'chamoji: this repo releases units (web, mobile); pass --unit <name> or --for-tag <tag>\n',
	);
	const unknown = await chamoji(['changelog', '--unit', 'admin'], dir);
	expect(unknown.code).toBe(1);
	expect(unknown.stderr).toBe(
		'chamoji: unknown unit "admin"; the units are web, mobile\n',
	);
});

const HINT =
	'chamoji: this looks like a monorepo with several apps; chamoji setup can version each one (coming in 0.14), or add a release section by hand: see the readme\n';

test('the monorepo hint prints once, never under --json or CI', async () => {
	const dir = await appRepo([WEB_FEATURE], null);
	const ci = await chamoji(['next-version'], dir, {env: {CI: 'true'}});
	expect(ci.stdout).toBe('0.1.0\n');
	expect(ci.stderr).toBe('');
	const json = await chamoji(['release', '0.1.0', '--dry-run', '--json'], dir);
	expect(json.code).toBe(0);
	expect(json.stderr).not.toContain('monorepo');

	const first = await chamoji(['next-version'], dir);
	expect(first.code).toBe(0);
	expect(first.stdout).toBe('0.1.0\n');
	expect(first.stderr).toBe(HINT);
	const gitDir = (
		await gitOutput(dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	expect(existsSync(path.join(gitDir, 'chamoji', 'monorepo-hint'))).toBe(true);

	const again = await chamoji(['release', '0.1.0', '--dry-run'], dir);
	expect(again.code).toBe(0);
	expect(again.stderr).toBe('');
});

test('shape "single" runs the old path, with no hint', async () => {
	const single = await appRepo([WEB_FEATURE], {schema: 1, shape: 'single'});
	const result = await chamoji(['next-version'], single);
	expect(result).toEqual({code: 0, stdout: '0.1.0\n', stderr: ''});
	const changelog = await chamoji(['changelog'], single);
	expect(changelog.code).toBe(0);
	expect(changelog.stdout).toContain('## Unreleased');
});

test('the help lists --unit and --for-tag', async () => {
	const {stdout} = await chamoji(['--help'], tmpdir());
	expect(stdout).toContain('  --unit');
	expect(stdout).toContain('  --for-tag');
});

test('a first release notes a version file that disagrees with the manifest', async () => {
	const dir = await appRepo(
		[
			{
				commit: '🔧 Add the app config',
				files: {'apps/web/app.json': '{"expo": {"version": "0.3.0"}}\n'},
			},
			WEB_FEATURE,
		],
		{
			...RELEASE,
			units: {
				web: {
					path: 'apps/web',
					tag: 'web/v{version}',
					versionFiles: ['apps/web/package.json', 'apps/web/app.json'],
				},
			},
		},
	);
	const {code, stdout} = await chamoji(['release', '--dry-run'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain(
		'note: apps/web/app.json had a version other than 0.1.0 (its package.json version); it now says 0.1.0\n',
	);
});

test('a missing upstream remote is a warning in text and JSON', async () => {
	const dir = await appRepo([...TAGGED, WEB_FEATURE], {
		...RELEASE,
		upstream: {remote: 'upstream', name: 'Makerkit'},
	});
	const warning =
		'upstream remote "upstream" has no fetched branches here, so template history is recognised only by ignored version tags; run git remote add upstream <url> && git fetch upstream before chamoji';
	const text = await chamoji(['release', '--dry-run'], dir);
	expect(text.stdout).toContain(`warning: ${warning}\n`);
	const asJson = await chamoji(['release', '--dry-run', '--json'], dir);
	expect(JSON.parse(asJson.stdout)).toMatchObject({warnings: [warning]});
});

test('a first release notes a version file that disagrees with the manifest', async () => {
	const dir = await appRepo(
		[
			{
				commit: '🔧 Add the app config',
				files: {'apps/web/app.json': '{"expo": {"version": "0.3.0"}}\n'},
			},
			WEB_FEATURE,
		],
		{
			...RELEASE,
			units: {
				web: {
					path: 'apps/web',
					tag: 'web/v{version}',
					versionFiles: ['apps/web/package.json', 'apps/web/app.json'],
				},
			},
		},
	);
	const {code, stdout} = await chamoji(['release', '--dry-run'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain(
		'note: apps/web/app.json had a version other than 0.1.0 (its package.json version); it now says 0.1.0\n',
	);
});
