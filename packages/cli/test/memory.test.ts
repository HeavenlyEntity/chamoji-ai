import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	cardLineId,
	listMemory,
	readBrief,
	readCardState,
	readTree,
	snapshotWorkstream,
	writeTree,
} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run, type Io} from '../src/run.js';
import {recordingFace} from './helpers/recording-face.js';

// The real card state, wrapped so a test can make it fail.
vi.mock('@chamoji/core', async importOriginal => {
	const original = await importOriginal<typeof import('@chamoji/core')>();
	return {
		...original,
		readCardState: vi.fn(original.readCardState),
		readBrief: vi.fn(original.readBrief),
	};
});

let repo: FixtureRepo | undefined;
let loose: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	const actual =
		await vi.importActual<typeof import('@chamoji/core')>('@chamoji/core');
	vi.mocked(readCardState).mockReset();
	vi.mocked(readCardState).mockImplementation(actual.readCardState);
	vi.mocked(readBrief).mockReset();
	vi.mocked(readBrief).mockImplementation(actual.readBrief);
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

const ORDER_ID = cardLineId('gotcha', 'order matters');

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
	expect(stdout).toContain(`  Gotcha [${ORDER_ID}]: order matters\n`);
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

test('why --json, memory search --json and memory show --json carry lines beside card', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nGotcha: order matters\nWorkstream: auth',
			files: {'src/login.ts': 'login\n'},
		},
		{
			commit: '🐛 Fix footer',
			body: 'Why: the footer overlapped the cookie banner on phones',
		},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	const card = {
		why: ['the old form leaked'],
		constraint: [],
		gotcha: ['order matters'],
		followUp: [],
	};
	const lines = [
		{id: ORDER_ID, kind: 'gotcha', text: 'order matters', state: 'open'},
	];

	const why = JSON.parse(
		(await chamoji(['why', 'src/login.ts:1', '--json'], repo.dir)).stdout,
	);
	expect(why.card).toEqual(card);
	expect(why.lines).toEqual(lines);
	expect(why.commit.card).toEqual(card);

	const hits = JSON.parse(
		(await chamoji(['memory', 'search', 'leaked', '--json'], repo.dir)).stdout,
	);
	expect(hits[0]).toMatchObject({kind: 'commit', card, lines});
	expect(Object.keys(hits[0])).toEqual([
		'kind',
		'id',
		'title',
		'card',
		'lines',
		'whyQuality',
		'score',
	]);
	// The workstream's card holds the same line, so the same state.
	expect(hits[1]).toMatchObject({kind: 'workstream', lines});
	// A hit with no constraint, gotcha or follow-up line has no lines at all.
	const [footer] = JSON.parse(
		(await chamoji(['memory', 'search', 'footer', '--json'], repo.dir)).stdout,
	);
	expect(footer.title).toBe('🐛 Fix footer');
	expect(footer).not.toHaveProperty('lines');

	const entry = JSON.parse(
		(await chamoji(['memory', 'show', 'auth', '--json'], repo.dir)).stdout,
	);
	expect(entry.commits[0]).toMatchObject({card, lines});
});

test('memory show and search say on stderr when line states could not be read, and show --json has linesUnavailable', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nGotcha: order matters\nWorkstream: auth',
			files: {'src/login.ts': 'login\n'},
		},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	const notice =
		'chamoji: line states could not be read, so cards are shown without them\n';
	vi.mocked(readCardState).mockRejectedValue(new Error('git failed'));

	const shown = await chamoji(['memory', 'show', 'auth'], repo.dir);
	expect(shown.code).toBe(0);
	expect(shown.stderr).toBe(notice);
	expect(shown.stdout).toContain('  Gotcha: order matters\n');

	const found = await chamoji(['memory', 'search', 'leaked'], repo.dir);
	expect(found.code).toBe(0);
	expect(found.stderr).toBe(notice);
	expect(found.stdout).toContain('  Gotcha: order matters\n');

	const json = await chamoji(['memory', 'show', 'auth', '--json'], repo.dir);
	expect(json.stderr).toBe('');
	const entry = JSON.parse(json.stdout);
	expect(entry.linesUnavailable).toBe(true);
	expect(entry.commits[0]).not.toHaveProperty('lines');
});

test('memory search --json keeps its array and says on stderr when line states cannot be read', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nGotcha: order matters\nWorkstream: auth',
			files: {'src/login.ts': 'login\n'},
		},
	]);
	vi.mocked(readCardState).mockRejectedValue(new Error('git failed'));
	const {code, stdout, stderr} = await chamoji(
		['memory', 'search', 'leaked', '--json'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stderr).toBe(
		'chamoji: line states could not be read, so cards are shown without them\n',
	);
	const hits = JSON.parse(stdout);
	expect(Array.isArray(hits)).toBe(true);
	expect(hits.length).toBeGreaterThan(0);
	for (const hit of hits) expect(hit).not.toHaveProperty('lines');
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
		'memory needs list, show, search, reindex, archive, sync, resolve or brief',
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
	expect(stdout).toContain(`  Gotcha [${ORDER_ID}]: order matters\n`);
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
	// Git for Windows can't print this date, so the year isn't pinned there.
	expect(shown.stdout).toMatch(/[0-9a-f]{7} 🐛 Peer, \d{4,5}-\d{2}-\d{2}\n/);
	expect(shown.stdout).toContain('  Why: from the future\n');
});

test('memory sync reports fetch, merge and push, then ends ok', async () => {
	const dir = await remembered();
	await bareOrigin(dir);
	const {face, calls} = recordingFace();
	const {code, stdout, stderr} = await chamoji(['memory', 'sync'], dir, {
		face,
	});
	expect(code).toBe(0);
	expect(stdout).toBe('Synced memory with origin: 2 entries.\n');
	expect(stderr).toBe('');
	expect(calls).toEqual([
		['step', 'Syncing memory with origin'],
		['update', "Fetching origin's memory"],
		['update', "Merging origin's memory into yours"],
		['update', 'Pushing memory to origin'],
		['end', 'ok', 'Synced memory with origin: 2 entries'],
		['stop'],
	]);
});

test('memory sync with nothing to sync ends ok', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await bareOrigin(repo.dir);
	const {face, calls} = recordingFace();
	const {stdout} = await chamoji(['memory', 'sync'], repo.dir, {face});
	expect(stdout).toBe('Nothing to sync: no memory here or on origin yet.\n');
	expect(calls).toContainEqual(['end', 'ok', 'Nothing to sync']);
});

test('memory sync ending in needsForce ends warn', async () => {
	const dir = await remembered();
	await bareOrigin(dir);
	await chamoji(['memory', 'sync'], dir);
	await chamoji(['memory', 'archive', 'auth', '--purge'], dir);
	const {face, calls} = recordingFace();
	const plain = await chamoji(['memory', 'sync'], dir);
	const faced = await chamoji(['memory', 'sync'], dir, {face});
	expect(faced.stdout).toBe(plain.stdout);
	expect(faced.code).toBe(0);
	expect(calls.at(-2)).toEqual([
		'end',
		'warn',
		'A purged entry is still on origin, so nothing was pushed',
	]);
});

test('a thrown step ends fail with its label, and stderr has chamoji: <message> once', async () => {
	const dir = await remembered();
	const {face, calls} = recordingFace();
	const {code, stderr} = await chamoji(['memory', 'sync'], dir, {face});
	expect(code).toBe(1);
	expect(stderr).toBe('chamoji: No remote named origin\n');
	expect(calls).toEqual([
		['step', 'Syncing memory with origin'],
		['end', 'fail', 'Syncing memory with origin'],
		['stop'],
	]);
});

test('a push that fails ends fail with the push label', async () => {
	const dir = await remembered();
	const remote = await bareOrigin(dir);
	await writeFile(path.join(remote, 'hooks/update'), '#!/bin/sh\nexit 1\n', {
		mode: 0o755,
	});
	const {face, calls} = recordingFace();
	const {code, stderr} = await chamoji(['memory', 'sync'], dir, {face});
	expect(code).toBe(1);
	expect(stderr.match(/chamoji: /g)).toHaveLength(1);
	expect(calls.at(-2)).toEqual(['end', 'fail', 'Pushing memory to origin']);
});

test('memory search --ai shows Jev ranking the matches', async () => {
	const dir = await remembered();
	const {face, calls} = recordingFace();
	const {code} = await chamoji(['memory', 'search', 'login', '--ai'], dir, {
		face,
		async rerank(_query, hits) {
			return hits;
		},
	});
	expect(code).toBe(0);
	expect(calls).toEqual([
		['step', 'Jev is ranking the matches'],
		['end', 'ok', 'Jev ranked the matches'],
		['stop'],
	]);
});

test('memory reindex is one step', async () => {
	const dir = await remembered();
	const {face, calls} = recordingFace();
	const {stdout} = await chamoji(['memory', 'reindex'], dir, {face});
	expect(stdout).toMatch(/^Indexed \d+ documents\.\n$/);
	expect(calls[0]).toEqual(['step', 'Rebuilding the search index']);
	expect(calls[1]?.slice(0, 2)).toEqual(['end', 'ok']);
});

test('memory list and show never call the face', async () => {
	const dir = await remembered();
	const {face, calls} = recordingFace();
	await chamoji(['memory', 'list'], dir, {face});
	await chamoji(['memory', 'show', 'auth'], dir, {face});
	await chamoji(['memory', 'search', 'login'], dir, {face});
	expect(calls).toEqual([]);
});

/** A repo whose one card line is long and carries a terminal escape; gives its id. */
async function withLine(): Promise<{dir: string; id: string}> {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: The dev server must stay on port 3000 \u001B[31mbecause the OAuth callback URL registered with the provider says so`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	const [line] = (await readCardState(repo.dir)).lines;
	return {dir: repo.dir, id: line!.id};
}

test('memory resolve prints the two lines and exits 0', async () => {
	const {dir, id} = await withLine();
	const {code, stdout, stderr} = await chamoji(
		['memory', 'resolve', id, '--because', 'the proxy owns the port now'],
		dir,
	);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	const short = (
		await gitOutput(dir, ['rev-parse', '--short=7', 'HEAD'])
	).trim();
	const text =
		'The dev server must stay on port 3000 [31mbecause the OAuth callback URL registe';
	expect(text).toHaveLength(80);
	expect(stdout).toBe(
		`Resolved ${id}: ${text}\nRecorded in ${short}. Push it like any commit.\n`,
	);
	expect(await gitOutput(dir, ['log', '-1', '--format=%B'])).toBe(
		`📝 Resolve ${id}\n\nResolves: ${id} the proxy owns the port now\n\n`,
	);
});

test('memory resolve with no --because exits 2 with the usage line', async () => {
	const {dir, id} = await withLine();
	const head = await gitOutput(dir, ['rev-parse', 'HEAD']);
	const usage =
		'chamoji: memory resolve needs an id and a reason: chamoji memory resolve <id> --because "<reason>"\n';
	for (const argv of [
		['memory', 'resolve', id],
		['memory', 'resolve', '--because', 'gone'],
		['memory', 'resolve', id, 'other', '--because', 'gone'],
	]) {
		const {code, stdout, stderr} = await chamoji(argv, dir);
		expect(code).toBe(2);
		expect(stdout).toBe('');
		expect(stderr).toBe(usage);
	}

	expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(head);
});

test('memory resolve --json prints the id and the hash', async () => {
	const {dir, id} = await withLine();
	const {code, stdout} = await chamoji(
		['memory', 'resolve', id, '--because', 'gone', '--json'],
		dir,
	);
	expect(code).toBe(0);
	const hash = (await gitOutput(dir, ['rev-parse', 'HEAD'])).trim();
	expect(JSON.parse(stdout)).toEqual({resolved: id, hash});
});

test('memory resolve of an unknown or resolved line exits 1 with the message', async () => {
	const {dir, id} = await withLine();
	const unknown = await chamoji(
		['memory', 'resolve', 'c-00000000', '--because', 'gone'],
		dir,
	);
	expect(unknown).toMatchObject({
		code: 1,
		stdout: '',
		stderr: 'chamoji: No card line has the id c-00000000\n',
	});

	await chamoji(['memory', 'resolve', id, '--because', 'gone'], dir);
	const short = (
		await gitOutput(dir, ['rev-parse', '--short=7', 'HEAD'])
	).trim();
	const again = await chamoji(
		['memory', 'resolve', id, '--because', 'gone'],
		dir,
	);
	expect(again).toMatchObject({
		code: 1,
		stderr: `chamoji: ${id} is already resolved by ${short}\n`,
	});
});

test('memory resolve with staged changes exits 1 with the staged-changes message and makes no commit', async () => {
	const {dir, id} = await withLine();
	const head = await gitOutput(dir, ['rev-parse', 'HEAD']);
	await writeFile(path.join(dir, 'a.txt'), 'a\n');
	await gitOutput(dir, ['add', 'a.txt']);
	const result = await chamoji(
		['memory', 'resolve', id, '--because', 'gone'],
		dir,
	);
	expect(result).toMatchObject({
		code: 1,
		stdout: '',
		stderr:
			'chamoji: You have staged changes. Commit or unstage them first, so the resolve commit stays empty.\n',
	});
	expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(head);
	expect(await gitOutput(dir, ['diff', '--cached', '--name-only'])).toBe(
		'a.txt\n',
	);
});

test('memory resolve --because "" exits 1 with the reason message', async () => {
	const {dir, id} = await withLine();
	const head = await gitOutput(dir, ['rev-parse', 'HEAD']);
	const result = await chamoji(['memory', 'resolve', id, '--because', ''], dir);
	expect(result).toMatchObject({
		code: 1,
		stdout: '',
		stderr: 'chamoji: The reason must be one line of 1 to 200 characters\n',
	});
	expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(head);
});

const BRIEF_PORT = 'The dev server must stay on port 3000';
const BRIEF_PORT_ID = cardLineId('constraint', BRIEF_PORT);
const BRIEF_FLAKY = 'The upload test is flaky on CI';
const BRIEF_FLAKY_ID = cardLineId('gotcha', BRIEF_FLAKY);

/** A constraint and a gotcha, both open. */
async function briefRepo(): Promise<string> {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${BRIEF_PORT}\nGotcha: ${BRIEF_FLAKY}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	return repo.dir;
}

test('memory brief prints the text and exits 0, and prints nothing for a repo with no cards', async () => {
	const dir = await briefRepo();
	const {text} = await readBrief(dir);
	const {code, stdout, stderr} = await chamoji(['memory', 'brief'], dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toBe(`${text}\n`);
	expect(stdout).toContain(`Constraints\n  open       ${BRIEF_PORT_ID}`);
	expect(stdout).toContain(`Gotchas\n  open       ${BRIEF_FLAKY_ID}`);

	await repo!.cleanup();
	repo = await createRepo([{commit: '🎉 Init'}, {commit: '✨ Add search'}]);
	const bare = await chamoji(['memory', 'brief'], repo.dir);
	expect(bare).toEqual({code: 0, stdout: '', stderr: ''});
});

test('memory brief --section constraints --budget 4000 prints only constraints', async () => {
	const dir = await briefRepo();
	const {code, stdout, stderr} = await chamoji(
		['memory', 'brief', '--section', 'constraints', '--budget', '4000'],
		dir,
	);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toBe(
		`${(await readBrief(dir, {section: 'constraints', budget: 4000})).text}\n`,
	);
	expect(stdout).toContain(BRIEF_PORT_ID);
	expect(stdout).not.toContain('Gotchas');
	expect(stdout).not.toContain(BRIEF_FLAKY_ID);
});

test('memory brief --budget 50 and --section nope each exit 2', async () => {
	const dir = await briefRepo();
	const budget = 'chamoji: --budget must be a whole number from 200 to 20000\n';
	for (const value of ['50', '20001', '1500.5', 'lots', '']) {
		const result = await chamoji(['memory', 'brief', '--budget', value], dir);
		expect(result, value).toEqual({code: 2, stdout: '', stderr: budget});
	}

	expect(await chamoji(['memory', 'brief', '--section', 'nope'], dir)).toEqual({
		code: 2,
		stdout: '',
		stderr:
			'chamoji: --section must be one of: constraints, resolved, gotchas, follow-ups, off-branch, workstreams, recent\n',
	});
	expect(await chamoji(['memory', 'brief', 'extra'], dir)).toEqual({
		code: 2,
		stdout: '',
		stderr:
			'chamoji: memory brief takes no arguments: chamoji memory brief [--budget <tokens>] [--section <name>]\n',
	});
	for (const value of ['200', '20000']) {
		const result = await chamoji(['memory', 'brief', '--budget', value], dir);
		expect(result.code, value).toBe(0);
	}
});

test('memory brief --json lists every line in every state', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${BRIEF_PORT}\nGotcha: ${BRIEF_FLAKY}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{
			commit: '✨ Add banner',
			body: 'Follow-up: fade the \u001B[31mbanner',
			files: {'banner.ts': 'banner\n'},
		},
		{
			commit: '🔥 Drop the flaky test',
			body: `Resolves: ${BRIEF_FLAKY_ID} the test is gone\nResolves: c-00000000 nothing`,
		},
	]);
	const dir = repo.dir;
	await gitOutput(dir, ['revert', '--no-edit', 'HEAD~1']);
	const followUp = cardLineId('followUp', 'fade the \u001B[31mbanner');
	const head = (await gitOutput(dir, ['rev-parse', 'HEAD'])).trim();

	const {code, stdout, stderr} = await chamoji(
		['memory', 'brief', '--json'],
		dir,
	);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	const reply = JSON.parse(stdout);
	expect(Object.keys(reply)).toEqual(['head', 'text', 'lines', 'dangling']);
	expect(reply.head).toBe(head);
	expect(reply.text).toBe((await readBrief(dir)).text);
	const states = Object.fromEntries(
		reply.lines.map((line: {id: string; state: string}) => [
			line.id,
			line.state,
		]),
	);
	expect(states).toEqual({
		[BRIEF_PORT_ID]: 'open',
		[BRIEF_FLAKY_ID]: 'resolved',
		[followUp]: 'reverted',
	});
	const reverted = reply.lines.find(
		(line: {id: string}) => line.id === followUp,
	);
	expect(reverted.text).toBe('fade the [31mbanner');
	expect(reverted).not.toHaveProperty('sources');
	// The brief text never prints a reverted line.
	expect(reply.text).not.toContain(followUp);
	expect(reply.dangling).toEqual([
		{
			id: 'c-00000000',
			hash: (await gitOutput(dir, ['rev-parse', 'HEAD~1'])).trim(),
		},
	]);
});

test('memory brief reports a git failure and exits 1', async () => {
	const dir = await briefRepo();
	vi.mocked(readBrief).mockRejectedValue(new Error('git log failed'));
	expect(await chamoji(['memory', 'brief'], dir)).toEqual({
		code: 1,
		stdout: '',
		stderr: 'chamoji: git log failed\n',
	});
	expect(await chamoji(['memory', 'brief', '--json'], dir)).toMatchObject({
		code: 1,
		stdout: '',
	});
});
