import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import {
	applyRelease,
	bumpManifest,
	insertSection,
	planRelease,
	pushRelease,
	releaseSubject,
	tagPrefix,
	type ReleaseOptions,
} from '../src/release.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
	type RepoStep,
} from './helpers/fixture-repo.js';

const SECTION =
	'## [v1.3.0](https://x/compare/v1.2.0...v1.3.0) - 2026-10-28\n\n### Added\n\n- ✨ Add export';

test('insertSection puts the new release above the last one and keeps the rest byte for byte', () => {
	const old =
		'## [v1.2.0](https://x) - 2026-09-02\n\n### Fixed\n\n- 🐛 Fix a crash\n';
	const changelog = `# Changelog\n\n${old}`;
	expect(insertSection(changelog, SECTION)).toBe(
		`# Changelog\n\n${SECTION}\n\n${old}`,
	);
});

test('insertSection keeps an Unreleased section above the new release', () => {
	const changelog =
		'# Changelog\n\n## [Unreleased]\n\n- Draft note\n\n## [2.0.1] - 2026-08-30\n\n- Old\n';
	const result = insertSection(changelog, '## [2.0.2] - 2026-10-28\n\n- New');
	expect(result.indexOf('## [Unreleased]')).toBeLessThan(
		result.indexOf('## [2.0.2]'),
	);
	expect(result.indexOf('## [2.0.2]')).toBeLessThan(
		result.indexOf('## [2.0.1]'),
	);
	expect(result).toContain('- Draft note');
	expect(result.endsWith('## [2.0.1] - 2026-08-30\n\n- Old\n')).toBe(true);
});

test('insertSection appends below the title when there is no release yet', () => {
	expect(insertSection('# Changelog\n', SECTION)).toBe(
		`# Changelog\n\n${SECTION}\n`,
	);
});

test('bumpManifest changes only the top-level version of package.json', () => {
	const text =
		'{\n\t"name": "@acme/widgets",\n\t"version": "1.2.0",\n\t"dependencies": {\n\t\t"left-pad": "1.2.0"\n\t}\n}\n';
	expect(bumpManifest('package.json', text, '1.2.0', '1.3.0')).toBe(
		text.replace('"version": "1.2.0"', '"version": "1.3.0"'),
	);
});

test('bumpManifest changes only the root entries of package-lock.json', () => {
	const lock = JSON.stringify(
		{
			name: 'widgets',
			version: '1.2.0',
			lockfileVersion: 3,
			packages: {
				'': {name: 'widgets', version: '1.2.0'},
				'node_modules/left-pad': {version: '1.2.0'},
			},
		},
		null,
		2,
	);
	const bumped = JSON.parse(
		bumpManifest('package-lock.json', lock, '1.2.0', '1.3.0')!,
	);
	expect(bumped.version).toBe('1.3.0');
	expect(bumped.packages[''].version).toBe('1.3.0');
	expect(bumped.packages['node_modules/left-pad'].version).toBe('1.2.0');
});

test('bumpManifest handles pyproject.toml and Cargo.toml', () => {
	expect(
		bumpManifest(
			'pyproject.toml',
			'[project]\nname = "ledger"\nversion = "2.0.1"\n',
			'2.0.1',
			'2.0.2',
		),
	).toBe('[project]\nname = "ledger"\nversion = "2.0.2"\n');
	expect(
		bumpManifest(
			'crates/core/Cargo.toml',
			'[package]\nname = "core"\nversion = "0.3.0"\n\n[dependencies]\nserde = { version = "0.3.0" }\n',
			'0.3.0',
			'0.4.0',
		),
	).toBe(
		'[package]\nname = "core"\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "0.3.0" }\n',
	);
});

test('bumpManifest leaves files that carry another version alone', () => {
	expect(
		bumpManifest('package.json', '{"version": "9.9.9"}', '1.2.0', '1.3.0'),
	).toBeNull();
	expect(
		bumpManifest('package.json', '{"name": "x"}', '1.2.0', '1.3.0'),
	).toBeNull();
});

test('bumpManifest sets any version on a first release, unless it already matches', () => {
	expect(
		bumpManifest('package.json', '{"version": "0.0.0"}', null, '0.1.0'),
	).toBe('{"version": "0.1.0"}');
	expect(
		bumpManifest('package.json', '{"version": "0.1.0"}', null, '0.1.0'),
	).toBeNull();
});

test('releaseSubject follows the repo commit style', () => {
	const gitmoji = Array.from({length: 30}, (_, i) =>
		i % 2 ? '✨ Add a thing' : '🐛 Fix a thing',
	);
	expect(releaseSubject(gitmoji, 'v1.3.0')).toBe('🔖 Release v1.3.0');
	expect(
		releaseSubject(
			[
				'fix: keep currency symbol',
				'feat: initial ledger',
				'docs: explain --strict',
			],
			'2.0.2',
		),
	).toBe('chore(release): 🔖 2.0.2');
	expect(
		releaseSubject(['Add search', 'Fix the login form', 'Tidy up'], 'v1.0.0'),
	).toBe('Release v1.0.0');
});

test('tagPrefix follows the newest tag', () => {
	expect(tagPrefix(['v1.2.0', 'v1.1.0'])).toBe('v');
	expect(tagPrefix(['2.0.1'])).toBe('');
	expect(tagPrefix([])).toBe('v');
});

// --- planRelease, on throwaway repos ---

const plans: FixtureRepo[] = [];
afterEach(async () => {
	await Promise.all(plans.splice(0).map(async repo => repo.cleanup()));
});

async function repoWith(steps: RepoStep[], files: Record<string, string> = {}) {
	const repo = await createRepo(steps);
	plans.push(repo);
	for (const [file, text] of Object.entries(files)) {
		await writeFile(path.join(repo.dir, file), text);
	}

	if (Object.keys(files).length > 0) {
		await gitOutput(repo.dir, ['add', '-A']);
		await gitOutput(repo.dir, [
			'-c',
			'user.name=Dev',
			'-c',
			'user.email=dev@example.com',
			'commit',
			'-q',
			'-m',
			'🔧 Add manifests',
		]);
	}

	return repo;
}

const plan = async (cwd: string, extra: Partial<ReleaseOptions> = {}) =>
	planRelease({
		cwd,
		config: {groups: DEFAULT_GROUP_CONFIG},
		fetch: false,
		today: '2026-10-28',
		...extra,
	});

async function ready(cwd: string, extra: Partial<ReleaseOptions> = {}) {
	const result = await plan(cwd, extra);
	if (result.status !== 'ready') throw new Error('expected a release');
	return result;
}

const widgets: RepoStep[] = [
	{commit: '🎉 Start widgets'},
	{tag: 'v1.2.0', annotated: true},
	{commit: '✨ Add CSV export'},
	{commit: '🐛 Fix crash when a widget has no title'},
	{commit: '⬆️ Bump vite from 5.1.0 to 5.2.0'},
	{commit: '⬆️ Bump vitest from 1.3.0 to 1.4.0'},
	{commit: '⬆️ Bump typescript from 5.3.3 to 5.4.2'},
];

test('planRelease picks a minor bump and chamoji notes for a gitmoji repo', async () => {
	const repo = await repoWith(widgets, {
		'package.json': '{\n\t"name": "widgets",\n\t"version": "1.2.0"\n}\n',
	});
	const result = await ready(repo.dir);
	expect(result).toMatchObject({
		version: '1.3.0',
		tag: 'v1.3.0',
		lastTag: 'v1.2.0',
		bump: 'minor',
		subject: '🔖 Release v1.3.0',
	});
	expect(result.notes.startsWith('## v1.3.0 - 2026-10-28')).toBe(true);
	expect(result.notes).toContain('Add CSV export');
	expect(result.notes.match(/dependency updates/g)).toHaveLength(1);
	expect(result.changes.map(change => change.file)).toEqual([
		'CHANGELOG.md',
		'package.json',
	]);
	expect(result.changes[1]!.text).toContain('"version": "1.3.0"');
});

test('planRelease follows tags without a v and Conventional subjects', async () => {
	const repo = await repoWith([
		{commit: 'feat: initial ledger'},
		{tag: '2.0.1', annotated: true},
		{commit: 'fix: keep currency symbol when exporting to PDF'},
		{commit: 'fix(cli): exit non-zero when the ledger file is missing'},
	]);
	const result = await ready(repo.dir);
	expect(result.tag).toBe('2.0.2');
	expect(result.subject).toBe('chore(release): 🔖 2.0.2');
});

test('planRelease reports nothing to release, with the unreleased subjects', async () => {
	const repo = await repoWith([
		{commit: '✨ Add notes'},
		{tag: 'v0.3.0'},
		{commit: '📝 Fix typos in the README'},
		{commit: '✅ Cover the empty-note case'},
	]);
	expect(await plan(repo.dir)).toEqual({
		status: 'nothing',
		lastTag: 'v0.3.0',
		unreleased: ['✅ Cover the empty-note case', '📝 Fix typos in the README'],
	});
});

test('planRelease needs a version for the first release', async () => {
	const repo = await repoWith([{commit: '✨ Start'}]);
	await expect(plan(repo.dir)).rejects.toMatchObject({code: 'first-release'});
	const result = await ready(repo.dir, {version: '0.1.0'});
	expect(result).toMatchObject({tag: 'v0.1.0', bump: 'first', lastTag: null});
	expect(result.changes[0]!.how).toContain('full history');
});

test('planRelease rejects bad and old versions', async () => {
	const repo = await repoWith(widgets);
	await expect(plan(repo.dir, {version: 'banana'})).rejects.toMatchObject({
		code: 'invalid-version',
	});
	await expect(plan(repo.dir, {version: '1.0.0'})).rejects.toMatchObject({
		code: 'not-newer',
	});
});

test('planRelease refuses a tag that already exists on another branch', async () => {
	const repo = await repoWith(widgets);
	const dev = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	await gitOutput(repo.dir, [
		...dev,
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'✨ Side',
	]);
	await gitOutput(repo.dir, ['tag', 'v1.3.0']);
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await expect(plan(repo.dir)).rejects.toMatchObject({code: 'tag-exists'});
});

test('planRelease stops on a dirty tree unless told otherwise', async () => {
	const repo = await repoWith(widgets);
	await writeFile(path.join(repo.dir, 'scratch.txt'), 'wip');
	await expect(plan(repo.dir)).rejects.toMatchObject({code: 'dirty'});
	await expect(plan(repo.dir, {allowDirty: true})).resolves.toMatchObject({
		status: 'ready',
	});
});

test('planRelease stops off the default branch unless told otherwise', async () => {
	const repo = await repoWith(widgets);
	const head = (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim();
	await gitOutput(repo.dir, ['update-ref', 'refs/remotes/origin/trunk', head]);
	await gitOutput(repo.dir, [
		'symbolic-ref',
		'refs/remotes/origin/HEAD',
		'refs/remotes/origin/trunk',
	]);
	await expect(plan(repo.dir)).rejects.toMatchObject({code: 'branch'});
	await expect(plan(repo.dir, {anyBranch: true})).resolves.toMatchObject({
		status: 'ready',
	});
});

// --- applyRelease and pushRelease ---

async function releasable(files: Record<string, string> = {}) {
	const repo = await repoWith(widgets, files);
	await gitOutput(repo.dir, ['config', 'user.name', 'Dev']);
	await gitOutput(repo.dir, ['config', 'user.email', 'dev@example.com']);
	return repo;
}

const head = async (dir: string, format = '%s') =>
	(await gitOutput(dir, ['log', '-1', `--format=${format}`])).trim();

test('applyRelease writes, commits and tags the release', async () => {
	const repo = await releasable({
		'package.json': '{\n\t"version": "1.2.0"\n}\n',
	});
	const result = await ready(repo.dir);
	const {commit} = await applyRelease(result);
	expect(await head(repo.dir)).toBe('🔖 Release v1.3.0');
	expect(commit).toBe(await head(repo.dir, '%h'));
	expect((await gitOutput(repo.dir, ['cat-file', '-t', 'v1.3.0'])).trim()).toBe(
		'tag',
	);
	expect(
		(await gitOutput(repo.dir, ['rev-list', '-n1', 'v1.3.0'])).trim(),
	).toBe(await head(repo.dir, '%H'));
	expect((await gitOutput(repo.dir, ['status', '--porcelain'])).trim()).toBe(
		'',
	);
	expect(await readFile(path.join(repo.dir, 'package.json'), 'utf8')).toContain(
		'"version": "1.3.0"',
	);
	expect(await readFile(path.join(repo.dir, 'CHANGELOG.md'), 'utf8')).toContain(
		'## v1.3.0 - 2026-10-28',
	);
});

test('applyRelease adds trailers to the release commit', async () => {
	const repo = await releasable();
	await applyRelease(await ready(repo.dir), {
		trailers: ['Co-Authored-By: A <a@example.com>'],
	});
	expect(await head(repo.dir, '%B')).toContain(
		'Co-Authored-By: A <a@example.com>',
	);
});

test('applyRelease rolls back when the commit fails', async () => {
	const repo = await releasable();
	const hook = path.join(repo.dir, '.git', 'hooks', 'pre-commit');
	await writeFile(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
	await chmod(hook, 0o755);
	const result = await ready(repo.dir);
	await expect(applyRelease(result)).rejects.toThrow(/rolled back/i);
	expect(await head(repo.dir, '%H')).toBe(result.start);
	expect((await gitOutput(repo.dir, ['tag', '--list', 'v1.3.0'])).trim()).toBe(
		'',
	);
	expect((await gitOutput(repo.dir, ['status', '--porcelain'])).trim()).toBe(
		'',
	);
});

test('pushRelease pushes HEAD and the tag, and a failed push keeps the release', async () => {
	const repo = await releasable();
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	try {
		await gitOutput(remote, ['init', '-q', '--bare']);
		await gitOutput(repo.dir, ['remote', 'add', 'origin', remote]);
		const result = await ready(repo.dir, {fetch: false});
		await applyRelease(result);
		await pushRelease(result);
		const refs = await gitOutput(remote, [
			'for-each-ref',
			'--format=%(refname)',
		]);
		expect(refs).toContain('refs/tags/v1.3.0');
		expect(refs).toContain('refs/heads/main');

		await gitOutput(repo.dir, [
			'remote',
			'set-url',
			'origin',
			`${remote}-missing`,
		]);
		await expect(pushRelease(result)).rejects.toThrow(/kept/);
		expect(
			(await gitOutput(repo.dir, ['tag', '--list', 'v1.3.0'])).trim(),
		).toBe('v1.3.0');
	} finally {
		await rm(remote, {recursive: true, force: true});
	}
});
