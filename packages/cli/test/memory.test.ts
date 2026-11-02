import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	listMemory,
	readTree,
	snapshotWorkstream,
	writeTree,
} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run, type Io} from '../src/run.js';

let repo: FixtureRepo | undefined;
let loose: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
	await repo?.cleanup();
	repo = undefined;
	if (loose) await rm(loose, {recursive: true, force: true});
	loose = undefined;
});

async function chamoji(argv: string[], cwd: string, extra: Partial<Io> = {}) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		...extra,
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

/** Commits a memory file holding `text` at `file`, on top of the ref if it has one. */
async function plantFile(dir: string, file: string, text: string) {
	const source = path.join(await tempFolder(), 'blob.txt');
	await writeFile(source, text);
	const blob = (await gitOutput(dir, ['hash-object', '-w', source])).trim();
	const head = await gitOutput(dir, [
		'rev-parse',
		'--verify',
		'-q',
		'refs/chamoji/memory',
	])
		.then(stdout => stdout.trim())
		.catch(() => undefined);
	const tree = head === undefined ? new Map() : await readTree(dir, head);
	tree.set(file, blob);
	const commit = await writeTree(dir, tree, head ? [head] : [], 'Planted');
	await gitOutput(dir, ['update-ref', 'refs/chamoji/memory', commit]);
}

async function tempFolder(): Promise<string> {
	const folder = await mkdtemp(path.join(tmpdir(), 'chamoji-memory-'));
	cleanups.push(async () => rm(folder, {recursive: true, force: true}));
	return folder;
}

test('memory list --archived includes archived entries, marked', async () => {
	const dir = await remembered();
	await chamoji(['memory', 'archive', 'auth'], dir);
	const live = await chamoji(['memory', 'list'], dir);
	expect(live.stdout).not.toContain('Auth revamp');
	const all = await chamoji(['memory', 'list', '--archived'], dir);
	expect(all.code).toBe(0);
	expect(all.stdout).toMatch(
		/auth +shipped, archived +1 commit +🔐 Auth revamp\n/,
	);
	expect(all.stdout).toMatch(/billing +dropped +1 commit/);
	const json = await chamoji(['memory', 'list', '--archived', '--json'], dir);
	expect(
		JSON.parse(json.stdout).map((item: {slug: string; archived: boolean}) => [
			item.slug,
			item.archived,
		]),
	).toEqual([
		['auth', true],
		['billing', false],
	]);
});

test('memory list points at --archived when only archived entries exist', async () => {
	const dir = await remembered();
	await chamoji(['memory', 'archive', 'auth'], dir);
	await chamoji(['memory', 'archive', 'billing'], dir);
	const {code, stdout} = await chamoji(['memory', 'list'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('No live entries. 2 entries archived');
	expect(stdout).toContain('chamoji memory list --archived');
	expect(stdout).not.toContain('Nothing in memory yet');
});

test('memory list says when an entry is there but cannot be read', async () => {
	const dir = await remembered();
	await plantFile(dir, 'workstreams/broken.json', '{not json');
	const {code, stdout, stderr} = await chamoji(['memory', 'list'], dir);
	expect(code).toBe(0);
	expect(stdout).toMatch(/auth +shipped/);
	expect(stderr).toBe(
		"chamoji: memory has 1 entry that can't be read: broken. chamoji memory show <slug> says what is wrong.\n",
	);
});

test('memory list does not call a memory empty when its only entry is a damaged archived one', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await plantFile(repo.dir, 'archive/broken.json', '{not json');
	for (const argv of [
		['memory', 'list'],
		['memory', 'list', '--archived'],
	]) {
		const {code, stdout, stderr} = await chamoji(argv, repo.dir);
		expect(code).toBe(0);
		expect(stdout).not.toContain('Nothing in memory yet');
		expect(stderr).toContain("1 entry that can't be read: broken");
	}
});

test('memory list does not call an unreadable memory empty', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await plantFile(repo.dir, 'workstreams/broken.json', '{not json');
	await plantFile(repo.dir, 'workstreams/worse.json', '[]');
	const {code, stdout, stderr} = await chamoji(['memory', 'list'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).not.toContain('Nothing in memory yet');
	expect(stderr).toContain("2 entries that can't be read: broken, worse");
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

test('memory list and show strip bidirectional overrides from a title', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml':
					'workstreams:\n  auth:\n    title: "evil \\u202Egnp.exe"\n    status: shipped\n',
			},
		},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	for (const argv of [
		['memory', 'list'],
		['memory', 'show', 'auth'],
	]) {
		const {stdout} = await chamoji(argv, repo.dir);
		expect(stdout).toContain('evil gnp.exe');
		expect(stdout).not.toContain('\u202E');
	}
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

test('memory archive <slug> --purge sends the user to memory sync, not to a raw force-push', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(
		['memory', 'archive', 'auth', '--purge'],
		dir,
	);
	expect(code).toBe(0);
	expect(stdout).toContain('Purged auth');
	expect(stdout).toContain('chamoji memory sync');
	expect(stdout).not.toContain('--force');
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
	expect(stderr).toContain(
		'memory needs list, show, search, reindex, archive or sync',
	);
});

test('memory search prints each match with its card', async () => {
	const dir = await remembered();
	const {code, stdout, stderr} = await chamoji(
		['memory', 'search', 'old form leaked'],
		dir,
	);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toMatch(/^[0-9a-f]{7} ✨ Add login\n/);
	expect(stdout).toContain('  Why: the old form leaked\n');
	expect(stdout).toContain('  Gotcha: order matters\n');
	expect(stdout).toContain('workstream auth Auth revamp\n');
});

test('memory search takes a query in several words', async () => {
	const dir = await remembered();
	const {stdout} = await chamoji(['memory', 'search', 'old', 'form'], dir);
	expect(stdout).toContain('Add login');
});

test('memory search --json prints the hits', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(
		['memory', 'search', 'leaked', '--json'],
		dir,
	);
	expect(code).toBe(0);
	const hits = JSON.parse(stdout);
	expect(hits.map((hit: {kind: string}) => hit.kind)).toEqual([
		'commit',
		'workstream',
	]);
	expect(hits[0]).toMatchObject({
		title: '✨ Add login',
		card: {why: ['the old form leaked']},
	});
	expect(hits[0].score).toBeGreaterThan(0);
	expect(stdout).not.toContain('fixture@example.com');
});

test('memory search says when nothing matches', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(
		['memory', 'search', 'zzz\u001B[31m'],
		dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe('Nothing in memory matches "zzz[31m".\n');
});

test('memory search strips terminal escapes', async () => {
	const dir = await remembered();
	const {stdout} = await chamoji(['memory', 'search', 'billing'], dir);
	expect(stdout).toContain('Fix [31mbilling');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('memory search with no query is a usage error', async () => {
	const dir = await remembered();
	const {code, stderr} = await chamoji(['memory', 'search'], dir);
	expect(code).toBe(2);
	expect(stderr).toContain('memory search needs a query');
});

test('memory reindex prints the document count', async () => {
	const dir = await remembered();
	const {code, stdout} = await chamoji(['memory', 'reindex'], dir);
	expect(code).toBe(0);
	// Three commits on HEAD and two live entries.
	expect(stdout).toBe('Indexed 5 documents.\n');
	expect((await chamoji(['memory', 'reindex', 'x'], dir)).code).toBe(2);
});

test('memory search --ai with no key says so and exits 2', async () => {
	const dir = await remembered();
	const saved = process.env['TYPESAFE_API_KEY'];
	delete process.env['TYPESAFE_API_KEY'];
	try {
		const {code, stdout, stderr} = await chamoji(
			['memory', 'search', 'leaked', '--ai'],
			dir,
		);
		expect(code).toBe(2);
		expect(stdout).toBe('');
		expect(stderr).toContain('--ai needs a TypeSafe API key');
	} finally {
		if (saved !== undefined) process.env['TYPESAFE_API_KEY'] = saved;
	}
});

test('memory search --ai ignores a key from a tracked env file', async () => {
	const dir = await remembered();
	await writeFile(path.join(dir, '.env'), 'TYPESAFE_API_KEY=bad…\n');
	const saved = process.env['TYPESAFE_API_KEY'];
	delete process.env['TYPESAFE_API_KEY'];
	try {
		// Untracked, the file's key reaches client setup, which rejects this one.
		const untracked = await chamoji(
			['memory', 'search', 'leaked', '--ai'],
			dir,
		);
		expect(untracked.code).toBe(1);
		expect(untracked.stderr).toContain('looks truncated');
		// Tracked, a clone could have named someone else's account, so it is not read.
		await gitOutput(dir, ['add', '.env']);
		const tracked = await chamoji(['memory', 'search', 'leaked', '--ai'], dir);
		expect(tracked.code).toBe(2);
		expect(tracked.stdout).toBe('');
		expect(tracked.stderr).toContain('--ai needs a TypeSafe API key');
		expect(tracked.stderr).not.toContain('truncated');
	} finally {
		if (saved !== undefined) process.env['TYPESAFE_API_KEY'] = saved;
	}
});

test('memory search --ai prints the matches in the order the rerank gives', async () => {
	const dir = await remembered();
	const seen: string[][] = [];
	const {code, stdout} = await chamoji(
		['memory', 'search', 'leaked', '--ai'],
		dir,
		{
			async rerank(query, hits) {
				seen.push([query, ...hits.map(hit => hit.kind)]);
				return [...hits].reverse();
			},
		},
	);
	expect(code).toBe(0);
	expect(seen).toEqual([['leaked', 'commit', 'workstream']]);
	expect(stdout.indexOf('workstream auth')).toBeLessThan(
		stdout.indexOf('Add login'),
	);
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
	expect(stdout).toContain("overwrites origin's history");
	expect(await gitOutput(remote, ['rev-parse', 'refs/chamoji/memory'])).toBe(
		before,
	);
});

test("following purge's advice keeps a teammate's entry on origin", async () => {
	const dir = await remembered();
	const remote = await bareOrigin(dir);
	await chamoji(['memory', 'sync'], dir);

	// A teammate ships and syncs another workstream that this clone never fetched.
	const mate = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml':
					'workstreams:\n  search:\n    title: Search\n    status: shipped\n',
			},
		},
	]);
	try {
		await gitOutput(mate.dir, ['remote', 'add', 'origin', remote]);
		await snapshotWorkstream(mate.dir, 'search');
		expect((await chamoji(['memory', 'sync'], mate.dir)).code).toBe(0);
	} finally {
		await mate.cleanup();
	}

	// This clone purges a different slug, and does what purge says next.
	const purged = await chamoji(['memory', 'archive', 'auth', '--purge'], dir);
	expect(purged.stdout).not.toContain('--force');
	const synced = await chamoji(['memory', 'sync'], dir);
	expect(synced.stdout).toContain("overwrites origin's history");
	expect((await listMemory(dir, {archived: true})).map(e => e.slug)).toEqual([
		'billing',
		'search',
	]);

	// The sync merged first, so the step it printed keeps the teammate's entry.
	await gitOutput(dir, ['push', '--force', 'origin', 'refs/chamoji/memory']);
	expect((await listMemory(remote, {archived: true})).map(e => e.slug)).toEqual(
		['billing', 'search'],
	);
});

test('text from a remote reaches the terminal with no control characters, line by line', async () => {
	const dir = await remembered();
	const remote = await bareOrigin(dir);
	await writeFile(
		path.join(remote, 'hooks/update'),
		"#!/bin/sh\nprintf '\\033]0;pwned\\007\\033[31mfirst line\\nsecond line\\n' >&2\nexit 1\n",
		{mode: 0o755},
	);
	const {code, stderr} = await chamoji(['memory', 'sync'], dir);
	expect(code).toBe(1);
	// eslint-disable-next-line no-control-regex
	expect(stderr).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
	// Git pads each line a remote sends.
	expect(stderr).toMatch(/first line *\n.*second line/);
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
