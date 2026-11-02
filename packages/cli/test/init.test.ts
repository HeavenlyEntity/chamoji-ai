import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	MEMORY_FETCH_REFSPEC,
	MEMORY_REF,
	MEMORY_REMOTE_REF,
	listMemory,
	snapshotWorkstream,
	syncMemory,
} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

async function chamoji(argv: string[], cwd: string) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
	});
	return {code, stdout, stderr};
}

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-init-'));
	cleanups.push(async () => rm(dir, {recursive: true, force: true}));
	return dir;
}

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    status: shipped',
		'  billing:',
		'    title: Billing',
		'    status: shipped',
		'',
	].join('\n'),
};

async function repoFrom(
	steps: Parameters<typeof createRepo>[0],
): Promise<FixtureRepo> {
	const repo = await createRepo(steps);
	cleanups.push(async () => repo.cleanup());
	return repo;
}

/** A repo with main on a bare origin that has no memory, and a clone of it. */
async function withOrigin() {
	const remote = await tempDir();
	await gitOutput(remote, ['init', '-q', '--bare', '-b', 'main']);
	const {dir} = await repoFrom([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nWorkstream: auth',
		},
	]);
	await gitOutput(dir, ['remote', 'add', 'origin', remote]);
	await gitOutput(dir, ['push', '-q', '-u', 'origin', 'main']);
	const clone = path.join(await tempDir(), 'clone');
	await gitOutput(path.dirname(clone), ['clone', '-q', remote, clone]);
	await gitOutput(clone, ['config', 'user.name', 'Dev']);
	await gitOutput(clone, ['config', 'user.email', 'dev@example.com']);
	return {remote, dir, clone};
}

const fetchLines = async (dir: string) =>
	(await gitOutput(dir, ['config', '--get-all', 'remote.origin.fetch']))
		.trim()
		.split('\n');

test('init adds the wildcard fetch refspec once', async () => {
	const {clone} = await withOrigin();
	const first = await chamoji(['init'], clone);
	expect(first.stderr).toBe('');
	expect(first.code).toBe(0);
	expect(first.stdout).toContain('origin now fetches chamoji memory');
	const again = await chamoji(['init'], clone);
	expect(again.code).toBe(0);
	expect(again.stdout).toContain('origin already fetches chamoji memory');
	expect(await fetchLines(clone)).toEqual([
		'+refs/heads/*:refs/remotes/origin/*',
		MEMORY_FETCH_REFSPEC,
	]);
	expect(MEMORY_FETCH_REFSPEC).toBe(
		'+refs/chamoji/*:refs/chamoji/remotes/origin/*',
	);
});

test('init leaves remote.origin.push unset', async () => {
	const {clone} = await withOrigin();
	await chamoji(['init'], clone);
	await expect(
		gitOutput(clone, ['config', '--get-all', 'remote.origin.push']),
	).rejects.toThrow();
});

test('plain git fetch and git pull work after init on a remote with no memory', async () => {
	const {remote, dir, clone} = await withOrigin();
	await chamoji(['init'], clone);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', '🐛 Next']);
	await gitOutput(dir, ['push', '-q', 'origin', 'main']);

	await gitOutput(clone, ['fetch']);
	await gitOutput(clone, ['pull', '-q']);
	expect(await gitOutput(clone, ['rev-parse', 'HEAD'])).toBe(
		await gitOutput(remote, ['rev-parse', 'main']),
	);
});

test('plain git fetch and git pull work after init on a remote with memory', async () => {
	const {remote, dir, clone} = await withOrigin();
	await chamoji(['init'], clone);
	await snapshotWorkstream(dir, 'auth');
	await syncMemory(dir);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', '🐛 Next']);
	await gitOutput(dir, ['push', '-q', 'origin', 'main']);

	await gitOutput(clone, ['fetch']);
	await gitOutput(clone, ['pull', '-q']);
	expect(await gitOutput(clone, ['rev-parse', 'HEAD'])).toBe(
		await gitOutput(remote, ['rev-parse', 'main']),
	);
	// Plain fetch keeps the remote's copy beside the local ref, not on it.
	expect(await gitOutput(clone, ['rev-parse', MEMORY_REMOTE_REF])).toBe(
		await gitOutput(remote, ['rev-parse', MEMORY_REF]),
	);
	await expect(
		gitOutput(clone, ['rev-parse', '--verify', MEMORY_REF]),
	).rejects.toThrow();
});

test('plain git push still pushes the branch after init', async () => {
	const {remote, dir} = await withOrigin();
	await chamoji(['init'], dir);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', '🐛 Next']);
	await gitOutput(dir, ['push', '-q']);
	expect(await gitOutput(remote, ['rev-parse', 'main'])).toBe(
		await gitOutput(dir, ['rev-parse', 'HEAD']),
	);
});

test('plain git push leaves memory behind after init', async () => {
	const {remote, dir} = await withOrigin();
	await chamoji(['init'], dir);
	await snapshotWorkstream(dir, 'auth');
	await gitOutput(dir, ['push', '-q']);
	await expect(
		gitOutput(remote, ['rev-parse', '--verify', MEMORY_REF]),
	).rejects.toThrow();
});

test('init with no origin says so and exits 0', async () => {
	const {dir} = await repoFrom([{commit: '🎉 Init'}]);
	const {code, stdout, stderr} = await chamoji(['init'], dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toContain('No remote named origin');
	await expect(
		gitOutput(dir, ['config', '--get-all', 'remote.origin.fetch']),
	).rejects.toThrow();
});

test('init brings remote memory in and pushes nothing', async () => {
	const {remote, dir, clone} = await withOrigin();
	await snapshotWorkstream(dir, 'auth');
	await syncMemory(dir);
	await gitOutput(clone, ['pull', '-q']);
	await snapshotWorkstream(clone, 'billing');
	const before = await gitOutput(remote, ['rev-parse', MEMORY_REF]);

	const {code, stdout} = await chamoji(['init'], clone);
	expect(code).toBe(0);
	expect(stdout).toContain('Took in memory from origin: 2 entries.');
	expect((await listMemory(clone)).map(entry => entry.slug)).toEqual([
		'auth',
		'billing',
	]);
	expect(await gitOutput(remote, ['rev-parse', MEMORY_REF])).toBe(before);
});

test('init on a remote with no memory says there is none yet', async () => {
	const {clone} = await withOrigin();
	const {stdout} = await chamoji(['init'], clone);
	expect(stdout).toContain('No memory on origin yet.');
});

test('init keeps its setup when origin cannot be reached', async () => {
	const {dir} = await withOrigin();
	await gitOutput(dir, ['remote', 'set-url', 'origin', `${dir}-missing`]);
	const {code, stdout, stderr} = await chamoji(['init'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('origin now fetches chamoji memory');
	expect(stderr).toContain('chamoji: Could not fetch memory');
	expect(await fetchLines(dir)).toContain(MEMORY_FETCH_REFSPEC);
});

test('init after a local purge gives the force-push step', async () => {
	const {dir} = await withOrigin();
	await snapshotWorkstream(dir, 'auth');
	await snapshotWorkstream(dir, 'billing');
	await syncMemory(dir);
	await chamoji(['memory', 'archive', 'auth', '--purge'], dir);
	const {code, stdout} = await chamoji(['init'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('git push --force origin refs/chamoji/memory');
});

test('init works from a subdirectory', async () => {
	const {clone} = await withOrigin();
	const {code} = await chamoji(['init'], path.join(clone, '.chamoji'));
	expect(code).toBe(0);
	expect(await fetchLines(clone)).toContain(MEMORY_FETCH_REFSPEC);
});

test('init outside a repo reports it plainly', async () => {
	const {code, stderr} = await chamoji(['init'], await tempDir());
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: Not a git repository');
});
