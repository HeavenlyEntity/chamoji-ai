import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {listMemory, snapshotWorkstream} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

let repo: FixtureRepo | undefined;
let loose: string | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
	if (loose) await rm(loose, {recursive: true, force: true});
	loose = undefined;
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

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    emoji: 🔐',
		'    status: shipped',
		'  billing:',
		'    title: "Billing \\e[31mred"',
		'    status: dropped',
		'',
	].join('\n'),
};

async function remembered(): Promise<string> {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nGotcha: order matters\nWorkstream: auth',
		},
		{commit: '🐛 Fix \u001B[31mbilling', body: 'Workstream: billing'},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	await snapshotWorkstream(repo.dir, 'billing');
	return repo.dir;
}

test('memory list prints each entry, with its status and commit count', async () => {
	const dir = await remembered();
	const {code, stdout, stderr} = await chamoji(['memory', 'list'], dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toMatch(/auth +shipped +1 commit +🔐 Auth revamp\n/);
	expect(stdout).toMatch(/billing +dropped +1 commit +Billing \[31mred\n/);
});

test('memory with no subcommand lists, and --json prints the entries', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(['memory', '--json'], dir);
	expect(code).toBe(0);
	expect(JSON.parse(stdout).map((item: {slug: string}) => item.slug)).toEqual([
		'auth',
		'billing',
	]);
});

test('memory list says how to start when there is nothing', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const {code, stdout} = await chamoji(['memory', 'list'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('Nothing in memory yet.');
});

test('memory show <slug> prints the entry and its cards', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(['memory', 'show', 'auth'], dir);
	expect(code).toBe(0);
	expect(stdout).toMatch(/^🔐 Auth revamp \(auth\)\n/);
	expect(stdout).toContain('shipped, updated ');
	expect(stdout).toMatch(/[0-9a-f]{7} ✨ Add login, 2026-01-02\n/);
	expect(stdout).toContain('  Why: the old form leaked\n');
	expect(stdout).toContain('  Gotcha: order matters\n');
});

test('memory show strips terminal escapes', async () => {
	const dir = await remembered();
	const {stdout} = await chamoji(['memory', 'show', 'billing'], dir);
	expect(stdout).toContain('Billing [31mred');
	expect(stdout).toContain('Fix [31mbilling');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('memory show --json prints the MemoryEntry', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(
		['memory', 'show', 'auth', '--json'],
		dir,
	);
	expect(code).toBe(0);
	const entry = JSON.parse(stdout);
	expect(entry).toMatchObject({version: 1, slug: 'auth', archived: false});
	expect(entry.commits[0].card.why).toEqual(['the old form leaked']);
});

test('memory show of an unknown slug exits 1', async () => {
	const dir = await remembered();
	const {code, stderr} = await chamoji(['memory', 'show', 'nope'], dir);
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: No memory for "nope"');
});

test('memory archive <slug> hides the entry and show still finds it', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(['memory', 'archive', 'auth'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('Archived auth.');
	expect((await listMemory(dir)).map(item => item.slug)).toEqual(['billing']);
	expect((await chamoji(['memory', 'list'], dir)).stdout).not.toContain(
		'Auth revamp',
	);
	const shown = await chamoji(['memory', 'show', 'auth'], dir);
	expect(shown.stdout).toContain('Auth revamp');
	expect(shown.stdout).toContain('archived');
});

test('memory archive <slug> --purge prints the force-push step', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(
		['memory', 'archive', 'auth', '--purge'],
		dir,
	);
	expect(code).toBe(0);
	expect(stdout).toContain('Purged auth');
	expect(stdout).toContain('git push --force origin refs/chamoji/memory');
	expect(
		await gitOutput(dir, ['log', '-p', 'refs/chamoji/memory']),
	).not.toContain('the old form leaked');
	const again = await chamoji(['memory', 'show', 'auth'], dir);
	expect(again.code).toBe(1);
});

test('memory archive with no slug or several is a usage error', async () => {
	const dir = await remembered();
	expect((await chamoji(['memory', 'archive'], dir)).code).toBe(2);
	expect((await chamoji(['memory', 'archive', 'a', 'b'], dir)).code).toBe(2);
	expect((await chamoji(['memory', 'show'], dir)).code).toBe(2);
});

test('an unknown subcommand is a usage error', async () => {
	const dir = await remembered();
	const {code, stderr} = await chamoji(['memory', 'nope'], dir);
	expect(code).toBe(2);
	expect(stderr).toContain('memory needs list, show, archive or sync');
});

async function bareOrigin(dir: string): Promise<string> {
	loose = await mkdtemp(path.join(tmpdir(), 'chamoji-memory-'));
	await gitOutput(loose, ['init', '-q', '--bare']);
	await gitOutput(dir, ['remote', 'add', 'origin', loose]);
	return loose;
}

test('memory sync pushes and says what it did', async () => {
	const dir = await remembered();
	const remote = await bareOrigin(dir);
	const {code, stdout} = await chamoji(['memory', 'sync'], dir);
	expect(code).toBe(0);
	expect(stdout).toBe('Synced memory with origin: 2 entries.\n');
	expect(await gitOutput(remote, ['rev-parse', 'refs/chamoji/memory'])).toBe(
		await gitOutput(dir, ['rev-parse', 'refs/chamoji/memory']),
	);
	const again = await chamoji(['memory', 'sync'], dir);
	expect(again.stdout).toBe('Memory already matches origin: 2 entries.\n');
});

test('memory sync --json prints the result', async () => {
	const dir = await remembered();
	await bareOrigin(dir);
	const {code, stdout} = await chamoji(['memory', 'sync', '--json'], dir);
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		fetched: false,
		merged: false,
		pushed: true,
		needsForce: false,
		entries: 2,
	});
});

test('memory sync with nothing anywhere says so', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await bareOrigin(repo.dir);
	const {code, stdout} = await chamoji(['memory', 'sync'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toBe('Nothing to sync: no memory here or on origin yet.\n');
});

test('memory sync with no origin exits 1 and says so', async () => {
	const dir = await remembered();
	const {code, stderr} = await chamoji(['memory', 'sync'], dir);
	expect(code).toBe(1);
	expect(stderr).toBe('chamoji: No remote named origin\n');
});

test('memory sync after a purge gives the exact step and pushes nothing', async () => {
	const dir = await remembered();
	const remote = await bareOrigin(dir);
	await chamoji(['memory', 'sync'], dir);
	const before = await gitOutput(remote, ['rev-parse', 'refs/chamoji/memory']);
	await chamoji(['memory', 'archive', 'auth', '--purge'], dir);
	const {code, stdout} = await chamoji(['memory', 'sync'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('git push --force origin refs/chamoji/memory\n');
	expect(stdout).toContain('still on origin');
	expect(await gitOutput(remote, ['rev-parse', 'refs/chamoji/memory'])).toBe(
		before,
	);
});

test('memory sync takes no arguments', async () => {
	const dir = await remembered();
	expect((await chamoji(['memory', 'sync', 'auth'], dir)).code).toBe(2);
});

test('outside a repo reports it plainly', async () => {
	loose = await mkdtemp(path.join(tmpdir(), 'chamoji-memory-'));
	const {code, stderr} = await chamoji(['memory', 'list'], loose);
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: Not a git repository');
});

test('a commit dated past year 9999 leaves memory readable', async () => {
	repo = await createRepo([{commit: '🎉 Init', files: WORKSTREAMS}]);
	await gitOutput(repo.dir, [
		'commit',
		'-q',
		'--allow-empty',
		'--date=@253402300800 +0000',
		'-m',
		'🐛 Peer\n\nWhy: from the future\nWorkstream: auth',
	]);
	const dropped = await chamoji(['ws', 'drop', 'auth'], repo.dir);
	expect(dropped.stderr).toBe('');
	expect(dropped.code).toBe(0);
	expect((await chamoji(['memory', 'list'], repo.dir)).stdout).toContain(
		'🔐 Auth revamp',
	);
	const shown = await chamoji(['memory', 'show', 'auth'], repo.dir);
	expect(shown.code).toBe(0);
	expect(shown.stdout).toMatch(/[0-9a-f]{7} 🐛 Peer, 10000-01-01\n/);
	expect(shown.stdout).toContain('  Why: from the future\n');
});
