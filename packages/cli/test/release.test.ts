import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
	type RepoStep,
} from '../../core/test/helpers/fixture-repo.js';
import {run, type GhRunner} from '../src/run.js';

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
