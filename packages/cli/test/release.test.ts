import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MEMORY_FETCH_REFSPEC, snapshotWorkstream} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
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
			['stop'],
		]);
	},
);
