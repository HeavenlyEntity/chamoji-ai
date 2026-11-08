import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MEMORY_FETCH_REFSPEC, snapshotWorkstream} from '@chamoji/core';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
	type RepoStep,
} from '../../core/test/helpers/fixture-repo.js';
import {fakeSsh} from '../../core/test/helpers/fake-ssh.js';
import type {JevClient} from '../src/jev-classifier.js';
import {run, type GhRunner} from '../src/run.js';
import {recordingFace} from './helpers/recording-face.js';
import {
	chamojiPublishing,
	fakeTools,
	has,
	TOKEN,
} from './helpers/release-publish.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

const history: RepoStep[] = [
	{commit: '🎉 Init'},
	{tag: 'v1.0.0', annotated: true},
	{commit: '✨ Add search'},
];

async function repoFrom(steps: RepoStep[]): Promise<FixtureRepo> {
	const repo = await createRepo(steps);
	cleanups.push(async () => repo.cleanup());
	await gitOutput(repo.dir, ['config', 'user.name', 'Dev']);
	await gitOutput(repo.dir, ['config', 'user.email', 'dev@example.com']);
	return repo;
}

async function chamoji(argv: string[], cwd: string, gh?: GhRunner) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-10-28',
		fetchTags: false,
		gh,
	});
	return {code, stdout, stderr};
}

const tagsOf = async (dir: string) =>
	(await gitOutput(dir, ['tag', '--list'])).trim().split('\n');

test('release cuts the release and reports it', async () => {
	const repo = await repoFrom(history);
	const {code, stdout} = await chamoji(['release'], repo.dir);
	expect(code).toBe(0);
	expect(stdout.split('\n')[0]).toBe('Released v1.1.0 (minor, from v1.0.0).');
	expect(stdout).toContain('pushed: no; to ship: git push origin HEAD v1.1.0');
	expect(stdout).toContain('## v1.1.0 - 2026-10-28');
	expect(await tagsOf(repo.dir)).toContain('v1.1.0');
});

test('release --dry-run changes nothing', async () => {
	const repo = await repoFrom(history);
	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	const {code, stdout} = await chamoji(['release', '--dry-run'], repo.dir);
	expect(code).toBe(0);
	expect(stdout.startsWith('Would release v1.1.0 (minor, from v1.0.0).')).toBe(
		true,
	);
	expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);
	expect(await tagsOf(repo.dir)).toEqual(['v1.0.0']);
});

test('release exits 3 when nothing needs releasing', async () => {
	const repo = await repoFrom([
		{commit: '🎉 Init'},
		{tag: 'v1.0.0'},
		{commit: '📝 Fix a typo'},
	]);
	const {code, stdout} = await chamoji(['release'], repo.dir);
	expect(code).toBe(3);
	expect(stdout).toContain('Nothing to release');
	expect(stdout).toContain('- 📝 Fix a typo');
});

test('release exits 2 on a dirty tree, and for a version that is not newer', async () => {
	const repo = await repoFrom(history);
	await writeFile(path.join(repo.dir, 'scratch.txt'), 'wip');
	const dirty = await chamoji(['release'], repo.dir);
	expect(dirty.code).toBe(2);
	expect(dirty.stderr).toContain('uncommitted changes');
	await rm(path.join(repo.dir, 'scratch.txt'));
	expect((await chamoji(['release', '1.0.0'], repo.dir)).code).toBe(2);
});

test('release takes the version as an argument', async () => {
	const repo = await repoFrom(history);
	const {code, stdout} = await chamoji(['release', '2.0.0-rc.1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout.split('\n')[0]).toBe(
		'Released v2.0.0-rc.1 (prerelease, from v1.0.0).',
	);
});

test('release --json prints one object', async () => {
	const repo = await repoFrom(history);
	const {code, stdout} = await chamoji(['release', '--json'], repo.dir);
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({
		status: 'released',
		version: '1.1.0',
		tag: 'v1.1.0',
		bump: 'minor',
		files: ['CHANGELOG.md'],
		pushed: false,
		githubRelease: false,
	});
});

test('release --push pushes and creates the GitHub release', async () => {
	const repo = await repoFrom(history);
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare']);
	await gitOutput(repo.dir, ['remote', 'add', 'origin', remote]);
	const calls: string[][] = [];
	const gh: GhRunner = async args => {
		calls.push(args);
		return {ok: true, message: 'https://github.com/acme/x/releases/v1.1.0'};
	};

	const {code, stdout} = await chamoji(
		['release', '--push', '--json'],
		repo.dir,
		gh,
	);
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({pushed: true, githubRelease: true});
	expect(await gitOutput(remote, ['tag', '--list'])).toContain('v1.1.0');
	expect(calls[0]!.slice(0, 5)).toEqual([
		'release',
		'create',
		'v1.1.0',
		'--title',
		'v1.1.0',
	]);
	expect(calls[0]![5]).toBe('--notes-file');
});

/** A repo with something in memory, on a bare origin. */
async function rememberedOnOrigin() {
	const repo = await repoFrom([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml':
					'workstreams:\n  auth:\n    title: Auth\n    status: shipped\n',
			},
		},
		{tag: 'v1.0.0', annotated: true},
		{commit: '✨ Add search', body: 'Workstream: auth'},
	]);
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare']);
	await gitOutput(repo.dir, ['remote', 'add', 'origin', remote]);
	await snapshotWorkstream(repo.dir, 'auth');
	return {dir: repo.dir, remote};
}

/** The same, in a clone that ran `chamoji init`. */
async function sharedOnOrigin() {
	const shared = await rememberedOnOrigin();
	await gitOutput(shared.dir, [
		'config',
		'--add',
		'remote.origin.fetch',
		MEMORY_FETCH_REFSPEC,
	]);
	return shared;
}

const noGh: GhRunner = async () => ({ok: true, message: ''});

test('release --push syncs memory after chamoji init', async () => {
	const {dir, remote} = await sharedOnOrigin();
	const {code, stdout} = await chamoji(['release', '--push'], dir, noGh);
	expect(code).toBe(0);
	expect(stdout).toContain('memory: Synced memory with origin: 1 entry.');
	expect(await gitOutput(remote, ['rev-parse', 'refs/chamoji/memory'])).toBe(
		await gitOutput(dir, ['rev-parse', 'refs/chamoji/memory']),
	);
});

test('release --push publishes no memory without chamoji init, and says how', async () => {
	const {dir, remote} = await rememberedOnOrigin();
	const {code, stdout} = await chamoji(['release', '--push'], dir, noGh);
	expect(code).toBe(0);
	expect(stdout).toContain(
		'memory: not synced; run chamoji init to share it with origin',
	);
	expect(await gitOutput(remote, ['tag', '--list'])).toContain('v1.1.0');
	await expect(
		gitOutput(remote, ['rev-parse', '--verify', 'refs/chamoji/memory']),
	).rejects.toThrow();
});

test("a failed sync doesn't fail the release", async () => {
	const {dir, remote} = await sharedOnOrigin();
	await writeFile(
		path.join(remote, 'hooks/update'),
		'#!/bin/sh\ncase "$1" in refs/chamoji/*) exit 1;; esac\n',
		{mode: 0o755},
	);
	const {code, stdout} = await chamoji(
		['release', '--push', '--json'],
		dir,
		noGh,
	);
	expect(code).toBe(0);
	const printed = JSON.parse(stdout);
	expect(printed).toMatchObject({pushed: true, githubRelease: true});
	expect(printed.memory).toContain('not synced: Could not push memory');
	expect(await gitOutput(remote, ['tag', '--list'])).toContain('v1.1.0');
	const text = await chamoji(['changelog'], dir);
	expect(text.code).toBe(0);
});

test('release --push says nothing of memory in a repo that has none', async () => {
	const repo = await repoFrom(history);
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare']);
	await gitOutput(repo.dir, ['remote', 'add', 'origin', remote]);
	const {code, stdout} = await chamoji(['release', '--push'], repo.dir, noGh);
	expect(code).toBe(0);
	expect(stdout).not.toContain('memory:');
});

test('release without --push leaves memory alone', async () => {
	const {dir, remote} = await rememberedOnOrigin();
	const {code, stdout} = await chamoji(['release'], dir);
	expect(code).toBe(0);
	expect(stdout).not.toContain('memory:');
	await expect(
		gitOutput(remote, ['rev-parse', '--verify', 'refs/chamoji/memory']),
	).rejects.toThrow();
});

async function withFace(
	argv: string[],
	cwd: string,
	options: {gh?: GhRunner; fetchTags?: boolean; jev?: JevClient} = {},
) {
	const {face, calls} = recordingFace();
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-10-28',
		fetchTags: options.fetchTags ?? false,
		gh: options.gh,
		jev: options.jev,
		face,
	});
	return {code, stdout, stderr, calls};
}

/**
 * The summary lines that don't name the release commit, which differs per
 * repo. On Windows the notes link to the temporary remote's path, so its
 * random suffix is masked too.
 */
const summary = (stdout: string) =>
	stdout
		.split('\n')
		.filter(line => !line.startsWith('commit: '))
		.map(line => line.replaceAll(/chamoji-remote-[^/\\]+/g, 'chamoji-remote'));

test('release --push reports each sub-step in order', async () => {
	const {dir} = await sharedOnOrigin();
	const twin = await sharedOnOrigin();
	const plain = await chamoji(['release', '--push'], twin.dir, noGh);
	const {code, stdout, stderr, calls} = await withFace(
		['release', '--push'],
		dir,
		{gh: noGh},
	);
	expect(code).toBe(0);
	expect(stderr).toBe(plain.stderr);
	expect(summary(stdout)).toEqual(summary(plain.stdout));
	expect(calls).toEqual([
		['step', 'Planning the release'],
		['end', 'ok', 'Ready to release v1.1.0'],
		['step', 'Pushing HEAD and v1.1.0'],
		['end', 'ok', 'Pushed HEAD and v1.1.0'],
		['step', 'Syncing memory with origin'],
		['update', "Fetching origin's memory"],
		['update', "Merging origin's memory into yours"],
		['update', 'Pushing memory to origin'],
		['end', 'ok', 'Synced memory with origin: 1 entry'],
		['step', 'Creating the GitHub release'],
		['end', 'ok', 'Created the GitHub release'],
		['stop'],
	]);
});

test('a GitHub release that is not created ends warn, and the summary is unchanged', async () => {
	const {dir} = await rememberedOnOrigin();
	const gh: GhRunner = async () => ({ok: false, message: 'gh: not logged in'});
	const {code, stdout, calls} = await withFace(['release', '--push'], dir, {
		gh,
	});
	expect(code).toBe(0);
	expect(stdout).toContain(
		'pushed: yes (HEAD and v1.1.0); GitHub release not created: gh: not logged in\n',
	);
	expect(calls.at(-2)).toEqual(['end', 'warn', 'GitHub release not created']);
});

test('a memory sync that fails in release --push ends warn', async () => {
	const {dir, remote} = await sharedOnOrigin();
	await writeFile(
		path.join(remote, 'hooks/update'),
		'#!/bin/sh\ncase "$1" in refs/chamoji/*) exit 1;; esac\n',
		{mode: 0o755},
	);
	const {code, stdout, calls} = await withFace(['release', '--push'], dir, {
		gh: noGh,
	});
	expect(code).toBe(0);
	expect(stdout).toContain('memory: not synced: Could not push memory');
	expect(calls).toContainEqual(['end', 'warn', 'Memory was not synced']);
	expect(calls).toContainEqual(['end', 'ok', 'Created the GitHub release']);
});

test('a push that fails ends warn and starts no later step', async () => {
	const repo = await repoFrom(history);
	await gitOutput(repo.dir, ['remote', 'add', 'origin', `${repo.dir}-missing`]);
	const {code, stdout, calls} = await withFace(
		['release', '--push'],
		repo.dir,
		{
			gh: noGh,
		},
	);
	expect(code).toBe(1);
	expect(stdout).toContain('pushed: failed: released v1.1.0 locally');
	expect(calls).toEqual([
		['step', 'Planning the release'],
		['end', 'ok', 'Ready to release v1.1.0'],
		['step', 'Pushing HEAD and v1.1.0'],
		['end', 'warn', 'The push failed; v1.1.0 is kept here'],
		['stop'],
	]);
});

test('release with nothing to release ends ok Nothing to release, exit 3', async () => {
	const steps: RepoStep[] = [
		{commit: '🎉 Init'},
		{tag: 'v1.0.0'},
		{commit: '📝 Fix a typo'},
	];
	const plain = await chamoji(['release'], (await repoFrom(steps)).dir);
	const {code, stdout, stderr, calls} = await withFace(
		['release'],
		(await repoFrom(steps)).dir,
	);
	expect(code).toBe(3);
	expect(stdout).toBe(plain.stdout);
	expect(stderr).toBe(plain.stderr);
	expect(calls).toEqual([
		['step', 'Planning the release'],
		['end', 'ok', 'Nothing to release'],
		['stop'],
	]);
});

/** A Jev whose every request fails. */
const failingJev: JevClient = {
	async systemOne() {
		throw new Error('invalid key');
	},
};

test('release --ai ends the planning step warn when Jev left commits unsorted', async () => {
	const {dir} = await repoFrom([
		{commit: '🎉 Init'},
		{tag: 'v1.0.0'},
		{commit: 'Tidelift tasks'},
		{commit: '✨ Add search'},
	]);
	const {code, calls} = await withFace(['release', '--dry-run', '--ai'], dir, {
		jev: failingJev,
	});
	expect(code).toBe(0);
	// Jev runs on the planning step, which ends warn, not ok.
	expect(calls[0]).toEqual(['step', 'Planning the release']);
	expect(calls).toContainEqual(['update', 'Jev is sorting 0 of 1 commits']);
	expect(calls.filter(call => call[0] === 'step')).toHaveLength(1);
	expect(calls.slice(-2)).toEqual([
		['end', 'warn', 'Jev left 1 of 1 commits unsorted'],
		['stop'],
	]);
});

test('next-version --ai with nothing to release ends ok Nothing to release, exit 3', async () => {
	const steps: RepoStep[] = [
		{commit: '🎉 Init'},
		{tag: 'v1.0.0'},
		{commit: '📝 Fix a typo'},
	];
	let plainOut = '';
	let plainErr = '';
	const plainCode = await run(['next-version', '--ai'], {
		cwd: (await repoFrom(steps)).dir,
		stdout: text => (plainOut += text),
		stderr: text => (plainErr += text),
		jev: failingJev,
	});
	const {code, stdout, stderr, calls} = await withFace(
		['next-version', '--ai'],
		(await repoFrom(steps)).dir,
		{jev: failingJev},
	);
	expect(plainCode).toBe(3);
	expect(code).toBe(3);
	expect(stdout).toBe(plainOut);
	expect(stdout).toBe('');
	expect(stderr).toBe(plainErr);
	expect(calls[0]).toEqual(['step', 'Working out the next version']);
	expect(calls.slice(-2)).toEqual([
		['end', 'ok', 'Nothing to release'],
		['stop'],
	]);
});

test('next-version --ai ends ok with the version it prints', async () => {
	const {dir} = await repoFrom([
		{commit: '🎉 Init'},
		{tag: 'v1.0.0'},
		{commit: '✨ Add search'},
	]);
	const {code, stdout, calls} = await withFace(['next-version', '--ai'], dir, {
		jev: failingJev,
	});
	expect(code).toBe(0);
	expect(stdout).toBe('1.1.0\n');
	expect(calls.slice(-2)).toEqual([
		['end', 'ok', 'Next version is 1.1.0'],
		['stop'],
	]);
});

test('release --dry-run is one step and prints what it printed before', async () => {
	const plain = await chamoji(
		['release', '--dry-run'],
		(await repoFrom(history)).dir,
	);
	const {code, stdout, calls} = await withFace(
		['release', '--dry-run'],
		(await repoFrom(history)).dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe(plain.stdout);
	expect(calls).toEqual([
		['step', 'Planning the release'],
		['end', 'ok', 'Ready to release v1.1.0'],
		['stop'],
	]);
});

test('release says when it fetches tags', async () => {
	const repo = await repoFrom(history);
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare']);
	await gitOutput(repo.dir, ['remote', 'add', 'origin', remote]);
	const {calls} = await withFace(['release', '--dry-run'], repo.dir, {
		fetchTags: true,
	});
	expect(calls.slice(0, 2)).toEqual([
		['step', 'Planning the release'],
		['update', 'Fetching tags from origin'],
	]);
});

test('a release that fails its checks ends fail, and says why once', async () => {
	const repo = await repoFrom(history);
	await writeFile(path.join(repo.dir, 'untracked.txt'), 'dirty\n');
	const {code, stderr, calls} = await withFace(['release'], repo.dir);
	expect(code).toBe(2);
	expect(stderr.match(/chamoji: /g)).toHaveLength(1);
	expect(calls).toEqual([
		['step', 'Planning the release'],
		['end', 'fail', 'Planning the release'],
		['stop'],
	]);
});

test.skipIf(process.platform === 'win32')(
	'a tag fetch that needs credentials ends the step warn before git asks',
	async () => {
		const repo = await repoFrom([...history, {commit: '🐛 Fix search'}]);
		const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
		cleanups.push(async () => rm(remote, {recursive: true, force: true}));
		await gitOutput(remote, ['init', '-q', '--bare']);
		await gitOutput(repo.dir, ['push', '-q', remote, 'HEAD:refs/heads/main']);
		// A tag only origin has, so the output shows the second fetch got it.
		await gitOutput(remote, ['tag', 'v1.0.5', 'main~1']);
		await gitOutput(repo.dir, [
			'remote',
			'add',
			'origin',
			`ssh://localhost${remote}`,
		]);
		const ssh = await fakeSsh();
		cleanups.push(ssh.cleanup);
		for (const [key, value] of Object.entries(ssh.env)) vi.stubEnv(key, value);
		cleanups.push(async () => {
			vi.unstubAllEnvs();
		});

		const {code, stdout, calls} = await withFace(
			['release', '--dry-run'],
			repo.dir,
			{fetchTags: true},
		);
		expect(code).toBe(0);
		expect(stdout).toContain('from v1.0.5');
		expect(stdout).not.toContain('could not fetch tags');
		expect(calls.slice(0, 4)).toEqual([
			['step', 'Planning the release'],
			['update', 'Fetching tags from origin'],
			['end', 'warn', 'git needs your credentials'],
			['release'],
		]);
	},
);

/** A single repo whose root package is a public library, released as v1.0.0, on a bare origin. */
async function libraryOnOrigin(publish: unknown = true) {
	const repo = await repoFrom([
		{
			commit: '🎉 Init',
			files: {
				'package.json': `${JSON.stringify({name: 'acme-lib', version: '1.0.0', main: 'index.js'}, null, '\t')}\n`,
				'index.js': 'export {};\n',
				'chamoji.config.json': `${JSON.stringify({release: {schema: 2, shape: 'single', publish}}, null, '\t')}\n`,
			},
		},
		{tag: 'v1.0.0', annotated: true},
		{commit: '✨ Add search', files: {'search.js': 'export {};\n'}},
	]);
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-remote-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare']);
	await gitOutput(repo.dir, ['remote', 'add', 'origin', remote]);
	return {dir: repo.dir, remote};
}

const statusOf = async (dir: string) =>
	gitOutput(dir, ['status', '--porcelain']);

describe.skipIf(!has('npm'))('release --publish', () => {
	test('release --publish runs checks before the commit', async () => {
		const {dir, remote} = await libraryOnOrigin({check: 'exit 1'});
		const before = await gitOutput(dir, ['rev-parse', 'HEAD']);
		const tools = fakeTools();
		const {code, stderr} = await chamojiPublishing(
			['release', '--publish'],
			dir,
			tools,
		);

		expect(code).toBe(2);
		expect(stderr).toContain('publish.check `exit 1` failed');
		expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(before);
		expect(await tagsOf(dir)).toEqual(['v1.0.0']);
		// The bumped package.json is put back and the new CHANGELOG.md removed.
		expect(await statusOf(dir)).toBe('');
		expect(tools.published()).toEqual([]);
		expect(tools.releases()).toEqual([]);
		expect(await gitOutput(remote, ['tag', '--list'])).toBe('');
	});

	test('release --publish publishes after an atomic push, then makes the GitHub release', async () => {
		const {dir, remote} = await libraryOnOrigin();
		let remoteTagsAtPublish = '';
		const tools = fakeTools({
			async onPublish() {
				remoteTagsAtPublish = await gitOutput(remote, ['tag', '--list']);
			},
		});
		const {code, stdout, stderr} = await chamojiPublishing(
			['release', '--publish', '--json'],
			dir,
			tools,
		);

		expect(code).toBe(0);
		const result = JSON.parse(stdout) as Record<string, unknown>;
		expect(result).toMatchObject({
			status: 'released',
			tag: 'v1.1.0',
			pushed: true,
			githubRelease: true,
			published: [
				{
					name: 'acme-lib',
					version: '1.1.0',
					distTag: 'latest',
					status: 'published',
				},
			],
		});
		expect(remoteTagsAtPublish).toContain('v1.1.0');
		// The tarball the checks packed, at the new version.
		expect(tools.published()).toHaveLength(1);
		expect(tools.published()[0]).toContain('./acme-lib-1.1.0.tgz');
		expect(tools.releases()).toEqual(['gh release create v1.1.0']);
		const publishedAt = tools.log.findIndex(line =>
			line.startsWith('npm publish'),
		);
		const releasedAt = tools.log.indexOf('gh release create v1.1.0');
		expect(publishedAt).toBeGreaterThan(-1);
		expect(releasedAt).toBeGreaterThan(publishedAt);
		expect(await statusOf(dir)).toBe('');
		expect(stdout + stderr).not.toContain(TOKEN);
	});

	test('a failed publish after the push exits 1 with the message and no GitHub release', async () => {
		const {dir, remote} = await libraryOnOrigin();
		const tools = fakeTools({failPublish: true});
		const {code, stdout, stderr} = await chamojiPublishing(
			['release', '--publish'],
			dir,
			tools,
		);

		expect(code).toBe(1);
		expect(stderr).toContain(
			"chamoji: v1.1.0 is tagged and pushed; acme-lib 1.1.0 isn't on npm. Run `chamoji publish --from v1.1.0` to publish it.\n",
		);
		expect(stdout).toContain(
			'pushed: yes (HEAD and v1.1.0); no GitHub release, since the publish failed\nnpm: acme-lib 1.1.0 → latest: failed\n',
		);
		expect(tools.releases()).toEqual([]);
		expect(await gitOutput(remote, ['tag', '--list'])).toContain('v1.1.0');
		expect(stdout + stderr).not.toContain(TOKEN);
	});

	test('a lost push race publishes nothing', async () => {
		const {dir, remote} = await libraryOnOrigin();
		const branch = (await gitOutput(dir, ['branch', '--show-current'])).trim();
		await gitOutput(dir, ['push', '-q', 'origin', 'HEAD', '--tags']);
		// Someone else moves the remote branch; this clone doesn't know.
		const other = await mkdtemp(path.join(tmpdir(), 'chamoji-other-'));
		cleanups.push(async () => rm(other, {recursive: true, force: true}));
		await gitOutput(other, ['clone', '-q', '-b', branch, remote, '.']);
		await gitOutput(other, ['config', 'user.name', 'Other']);
		await gitOutput(other, ['config', 'user.email', 'other@example.com']);
		await gitOutput(other, ['commit', '-q', '--allow-empty', '-m', 'Moved on']);
		await gitOutput(other, ['push', '-q', 'origin', `HEAD:${branch}`]);

		const tools = fakeTools();
		const {code, stdout} = await chamojiPublishing(
			['release', '--publish', '--json'],
			dir,
			tools,
		);

		expect(code).toBe(1);
		const result = JSON.parse(stdout) as Record<string, unknown>;
		expect(result).toMatchObject({pushed: false, published: []});
		expect(result['error']).toMatch(
			/^the default branch moved during the release; .*the release commit and tag are kept/s,
		);
		expect(tools.published()).toEqual([]);
		expect(tools.releases()).toEqual([]);
		// The local release is kept, as a plain --push keeps it.
		expect(await tagsOf(dir)).toContain('v1.1.0');
		expect(await gitOutput(remote, ['tag', '--list'])).not.toContain('v1.1.0');
	});

	test('--push with publish configured defers the GitHub release', async () => {
		const {dir} = await libraryOnOrigin();
		const tools = fakeTools();
		const {code, stdout} = await chamojiPublishing(
			['release', '--push'],
			dir,
			tools,
		);

		expect(code).toBe(0);
		expect(stdout).toContain(
			'pushed: yes (HEAD and v1.1.0); the GitHub release is created after the publish\n',
		);
		expect(tools.releases()).toEqual([]);
		expect(tools.published()).toEqual([]);

		const json = await libraryOnOrigin();
		const again = await chamojiPublishing(
			['release', '--push', '--json'],
			json.dir,
			tools,
		);
		expect(again.code).toBe(0);
		expect(JSON.parse(again.stdout)).toMatchObject({
			pushed: true,
			githubRelease: 'deferred',
		});
		expect(tools.releases()).toEqual([]);
	});

	test('--push with publishing turned off makes the GitHub release at once', async () => {
		const {dir} = await libraryOnOrigin();
		const tools = fakeTools();
		const {code, stdout} = await chamojiPublishing(
			['release', '--push', '--json'],
			dir,
			tools,
			undefined,
			{CHAMOJI_PUBLISH: 'false'},
		);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			pushed: true,
			githubRelease: true,
		});
		expect(tools.releases()).toEqual(['gh release create v1.1.0']);
		expect(tools.published()).toEqual([]);
	});

	test('a first version that trusted publishing skips gets no GitHub release, and exits 1', async () => {
		const {dir, remote} = await libraryOnOrigin();
		const tools = fakeTools();
		const {code, stdout, stderr} = await chamojiPublishing(
			['release', '--publish', '--json'],
			dir,
			tools,
			undefined,
			{
				CI: 'true',
				CHAMOJI_NPM_TOKEN: undefined,
				ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/token?x=1',
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
			},
		);

		expect(code).toBe(1);
		const result = JSON.parse(stdout) as Record<string, unknown>;
		expect(result).toMatchObject({
			pushed: true,
			githubRelease: false,
			published: [{name: 'acme-lib', status: 'skipped'}],
		});
		expect(result['error']).toBe(
			"v1.1.0 is tagged and pushed; acme-lib 1.1.0 isn't on npm: trusted publishing can't publish a package's first version. Publish it from your machine with `chamoji publish --from v1.1.0`, or with an npm token, then add the trusted publisher on npmjs.com.",
		);
		expect(stderr).toContain(String(result['error']));
		expect(tools.published()).toEqual([]);
		expect(tools.releases()).toEqual([]);
		expect(await gitOutput(remote, ['tag', '--list'])).toContain('v1.1.0');
		expect(stdout + stderr).not.toContain('request-secret');
	});

	test('--publish --tag publishes a hotfix below latest under that dist-tag', async () => {
		const below = await libraryOnOrigin();
		const refused = await chamojiPublishing(
			['release', '--publish'],
			below.dir,
			fakeTools({versions: ['1.0.0', '2.0.0']}),
		);
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain('is lower than latest (2.0.0)');
		expect(await tagsOf(below.dir)).toEqual(['v1.0.0']);

		const {dir} = await libraryOnOrigin();
		const tools = fakeTools({versions: ['1.0.0', '2.0.0']});
		const {code, stdout} = await chamojiPublishing(
			['release', '--publish', '--tag', 'release-1', '--json'],
			dir,
			tools,
		);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			tag: 'v1.1.0',
			published: [
				{name: 'acme-lib', distTag: 'release-1', status: 'published'},
			],
		});
		expect(tools.published()[0]).toContain('--tag=release-1');
	});

	test('--dry-run --publish shows the release and what it would publish, and changes nothing', async () => {
		const {dir, remote} = await libraryOnOrigin();
		const before = await gitOutput(dir, ['rev-parse', 'HEAD']);
		const tools = fakeTools();
		const {code, stdout} = await chamojiPublishing(
			['release', '--dry-run', '--publish'],
			dir,
			tools,
		);

		expect(code).toBe(0);
		expect(
			stdout.startsWith('Would release v1.1.0 (minor, from v1.0.0).'),
		).toBe(true);
		expect(stdout).toContain(
			'\nWould publish:\nacme-lib 1.1.0 → latest: would publish\n',
		);
		expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(before);
		expect(await tagsOf(dir)).toEqual(['v1.0.0']);
		expect(await statusOf(dir)).toBe('');
		expect(tools.published()).toEqual([]);
		expect(tools.releases()).toEqual([]);
		expect(await gitOutput(remote, ['tag', '--list'])).toBe('');
	});
});

describe('release --on-merge', () => {
	const config = (release: object) => ({
		'package.json': `${JSON.stringify({name: 'acme-lib', version: '1.0.0'}, null, '\t')}\n`,
		'chamoji.config.json': `${JSON.stringify({release: {schema: 2, shape: 'single', ...release}}, null, '\t')}\n`,
	});
	const steps = (release: object, commit: string): RepoStep[] => [
		{commit: '🎉 Init', files: config(release)},
		{tag: 'v1.0.0', annotated: true},
		{commit, files: {'change.js': 'export {};\n'}},
	];

	test('with trigger manual exits 3 with the message', async () => {
		const repo = await repoFrom(steps({trigger: 'manual'}, '✨ Add search'));
		const {code, stderr} = await chamoji(['release', '--on-merge'], repo.dir);
		expect(code).toBe(3);
		expect(stderr).toContain('releases are manual here (release.trigger)');
		expect(await tagsOf(repo.dir)).not.toContain('v1.1.0');
	});

	test('with no release section exits 3 too', async () => {
		const repo = await repoFrom(history);
		const {code, stderr} = await chamoji(['release', '--on-merge'], repo.dir);
		expect(code).toBe(3);
		expect(stderr).toContain('releases are manual here (release.trigger)');
	});

	test('holds a major and names the package', async () => {
		const repo = await repoFrom(
			steps({trigger: 'merge', majors: 'manual'}, '💥 Drop the old API'),
		);
		const {code, stdout, stderr} = await chamoji(
			['release', '--on-merge', '--json'],
			repo.dir,
		);
		expect(code).toBe(3);
		expect(stderr).toContain(
			'acme-lib has a breaking change and waits for a manual release (release.majors)',
		);
		expect(JSON.parse(stdout)).toMatchObject({
			status: 'nothing',
			held: ['acme-lib'],
		});
		expect(await tagsOf(repo.dir)).not.toContain('v2.0.0');
	});

	test('releases a minor under majors manual', async () => {
		const repo = await repoFrom(
			steps({trigger: 'merge', majors: 'manual'}, '✨ Add search'),
		);
		const {code, stdout} = await chamoji(
			['release', '--on-merge', '--json'],
			repo.dir,
		);
		expect(code).toBe(0);
		const result = JSON.parse(stdout) as {held?: string[]; tag: string};
		expect(result.tag).toBe('v1.1.0');
		expect(result.held).toBeUndefined();
	});

	test('without --on-merge, majors manual still releases a major', async () => {
		const repo = await repoFrom(
			steps({trigger: 'merge', majors: 'manual'}, '💥 Drop the old API'),
		);
		const {code, stdout} = await chamoji(['release', '--json'], repo.dir);
		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			status: 'released',
			tag: 'v2.0.0',
		});
	});
});
