import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {runGitWithInput} from '../src/git.js';
import {
	MEMORY_REF,
	MEMORY_REMOTE_REF,
	MemoryError,
	archiveMemory,
	listMemory,
	purgeMemory,
	readMemory,
	readTree,
	snapshotWorkstream,
	writeTree,
	type MemoryEntry,
} from '../src/memory.js';
import {mergeTrees, pullMemory, syncMemory} from '../src/memory-sync.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

/**
 * `before` runs just before the next real `push`, to lose a race with another
 * clone. `broken` makes one git command fail the way a damaged repo would.
 */
const race = vi.hoisted(() => ({
	before: [] as Array<() => Promise<unknown>>,
	broken: undefined as string | undefined,
}));

vi.mock('../src/git.js', async importOriginal => {
	const real = await importOriginal<typeof import('../src/git.js')>();
	return {
		...real,
		async runGit(args: string[], cwd: string) {
			if (args[0] === race.broken) {
				throw Object.assign(new Error('git failed'), {
					code: 128,
					stderr: 'fatal: bad object',
				});
			}

			if (args[0] === 'push') await race.before.shift()?.();
			return real.runGit(args, cwd);
		},
	};
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	race.before = [];
	race.broken = undefined;
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

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

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-sync-'));
	cleanups.push(async () => rm(dir, {recursive: true, force: true}));
	return dir;
}

async function makeRepo(
	steps: Parameters<typeof createRepo>[0],
): Promise<FixtureRepo> {
	const repo = await createRepo(steps);
	cleanups.push(async () => repo.cleanup());
	return repo;
}

/** A bare remote, with clone `a` that pushed main to it. `clone` makes more. */
async function world() {
	const remote = await tempDir();
	await gitOutput(remote, ['init', '-q', '--bare', '-b', 'main']);
	const {dir: a} = await makeRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nWorkstream: auth',
		},
		{commit: '💳 Add billing', body: 'Why: money\nWorkstream: billing'},
	]);
	await gitOutput(a, ['remote', 'add', 'origin', remote]);
	await gitOutput(a, ['push', '-q', 'origin', 'main']);
	const clone = async () => {
		const dir = path.join(await tempDir(), 'clone');
		await gitOutput(path.dirname(dir), ['clone', '-q', remote, dir]);
		return dir;
	};

	return {remote, a, b: await clone(), clone};
}

const tip = async (dir: string, ref = MEMORY_REF) =>
	(await gitOutput(dir, ['rev-parse', ref])).trim();

const parentsOf = async (dir: string, commit: string) =>
	(await gitOutput(dir, ['log', '-1', '--format=%P', commit]))
		.trim()
		.split(' ')
		.filter(Boolean);

const slugs = async (dir: string) =>
	(await listMemory(dir, {archived: true})).map(entry => entry.slug);

const historyOf = async (dir: string) =>
	gitOutput(dir, ['log', '-p', MEMORY_REF]);

const commitFor = (letter: string, why?: string) => ({
	hash: letter.repeat(40),
	subject: `Commit ${letter}`,
	date: '2026-01-01T00:00:00Z',
	...(why === undefined
		? {}
		: {card: {why: [why], constraint: [], gotcha: [], followUp: []}}),
});

function entryText(slug: string, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify(
		{
			version: 1,
			slug,
			title: 'Planted',
			status: 'shipped',
			updatedAt: '2026-01-01T00:00:00.000Z',
			archived: false,
			commits: [],
			...extra,
		},
		null,
		2,
	)}\n`;
}

/** Commits `files` on top of the ref, keeping every other path unless `only`. */
async function plant(
	dir: string,
	files: Record<string, string>,
	{only = false}: {only?: boolean} = {},
): Promise<string> {
	const head = await gitOutput(dir, ['rev-parse', '--verify', '-q', MEMORY_REF])
		.then(stdout => stdout.trim())
		.catch(() => undefined);
	const tree =
		head === undefined || only ? new Map() : await readTree(dir, head);
	for (const [file, text] of Object.entries(files)) {
		const args = ['hash-object', '-w', '--stdin'];
		tree.set(file, (await runGitWithInput(args, dir, text)).trim());
	}

	const commit = await writeTree(dir, tree, head ? [head] : [], 'Planted');
	await gitOutput(dir, ['update-ref', MEMORY_REF, commit]);
	return commit;
}

/** In-memory stores for calling mergeTrees without a repo. */
function store(blobs: Record<string, string>) {
	return {
		read: async (blob: string) => {
			const text = blobs[blob];
			if (text === undefined) throw new Error('no such blob');
			return text;
		},
		written: [] as MemoryEntry[],
		async write(entry: MemoryEntry) {
			this.written.push(entry);
			return `written-${this.written.length}`;
		},
	};
}

async function merge(
	ours: Record<string, string>,
	theirs: Record<string, string>,
	blobs: Record<string, string>,
) {
	const blobStore = store(blobs);
	const tree = await mergeTrees(
		new Map(Object.entries(ours)),
		new Map(Object.entries(theirs)),
		blobStore.read,
		async entry => blobStore.write(entry),
	);
	return {tree: Object.fromEntries(tree), written: blobStore.written};
}

test('sync pushes local memory to an empty remote', async () => {
	const {remote, a} = await world();
	await snapshotWorkstream(a, 'auth');
	expect(await syncMemory(a)).toEqual({
		fetched: false,
		merged: false,
		pushed: true,
		needsForce: false,
		entries: 1,
	});
	expect(await tip(remote)).toBe(await tip(a));
});

test('sync with nothing on either side does nothing', async () => {
	const {remote, a} = await world();
	expect(await syncMemory(a)).toEqual({
		fetched: false,
		merged: false,
		pushed: false,
		needsForce: false,
		entries: 0,
	});
	await expect(tip(remote)).rejects.toThrow();
});

test('sync takes remote memory into a clone that has none', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	expect(await syncMemory(b)).toEqual({
		fetched: true,
		merged: true,
		pushed: false,
		needsForce: false,
		entries: 1,
	});
	expect((await readMemory(b, 'auth'))?.commits[0]?.card?.why).toEqual([
		'the old form leaked',
	]);
	expect(await tip(b)).toBe(await tip(a));
});

test('sync fast-forwards when one side is behind', async () => {
	const {remote, a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await syncMemory(b);

	await snapshotWorkstream(a, 'billing');
	const ahead = await syncMemory(a);
	expect(ahead).toMatchObject({merged: false, pushed: true});
	expect(await tip(remote)).toBe(await tip(a));

	const behind = await syncMemory(b);
	expect(behind).toMatchObject({merged: true, pushed: false, entries: 2});
	expect(await tip(b)).toBe(await tip(a));
	// A fast-forward writes no merge commit.
	expect(await parentsOf(b, MEMORY_REF)).toHaveLength(1);
});

test('sync when both sides match changes nothing', async () => {
	const {a} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	const before = await tip(a);
	expect(await syncMemory(a)).toEqual({
		fetched: true,
		merged: false,
		pushed: false,
		needsForce: false,
		entries: 1,
	});
	expect(await tip(a)).toBe(before);
});

test.each([
	['a then b', true],
	['b then a', false],
])(
	'two clones ship different workstreams and both sync, in either order: %s',
	async (_name, aFirst) => {
		const {remote, a, b} = await world();
		await snapshotWorkstream(a, 'auth');
		await snapshotWorkstream(b, 'billing');
		const [first, second] = aFirst ? [a, b] : [b, a];
		await syncMemory(first);
		expect(await syncMemory(second)).toMatchObject({
			merged: true,
			pushed: true,
			entries: 2,
		});
		await syncMemory(first);
		for (const dir of [a, b]) {
			expect(await slugs(dir)).toEqual(['auth', 'billing']);
			expect(await tip(dir)).toBe(await tip(remote));
		}
	},
);

test('a merge has both tips as parents and records no one', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await snapshotWorkstream(b, 'billing');
	await syncMemory(a);
	const ours = await tip(b);
	await syncMemory(b);
	expect(await parentsOf(b, MEMORY_REF)).toEqual([ours, await tip(a)]);
	expect(
		await gitOutput(b, ['log', '-1', '--format=%an %ae', MEMORY_REF]),
	).toBe('chamoji noreply@chamoji.dev\n');
});

test('sync pushes only the memory ref', async () => {
	const {remote, a} = await world();
	const main = await tip(a, 'refs/heads/main');
	await gitOutput(a, ['commit', '-q', '--allow-empty', '-m', '🐛 Unpushed']);
	await gitOutput(a, ['tag', 'local-tag']);
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	expect(await tip(remote, 'refs/heads/main')).toBe(main);
	expect(await gitOutput(remote, ['for-each-ref', '--format=%(refname)'])).toBe(
		`${MEMORY_REF}\nrefs/heads/main\n`,
	);
});

test('sync leaves the work tree, the index and HEAD alone', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await snapshotWorkstream(b, 'billing');
	await writeFile(path.join(b, 'loose.txt'), 'loose\n');
	const status = await gitOutput(b, ['status', '--porcelain']);
	const head = await tip(b, 'HEAD');
	await syncMemory(b);
	expect(await gitOutput(b, ['status', '--porcelain'])).toBe(status);
	expect(await tip(b, 'HEAD')).toBe(head);
});

test('fetched memory lands beside the local ref, not on it', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await snapshotWorkstream(b, 'billing');
	const local = await tip(b);
	await gitOutput(b, [
		'fetch',
		'-q',
		'origin',
		`+refs/chamoji/*:refs/chamoji/remotes/origin/*`,
	]);
	expect(await tip(b)).toBe(local);
	expect(await tip(b, MEMORY_REMOTE_REF)).toBe(await tip(a));
});

test('pullMemory brings memory in and pushes nothing', async () => {
	const {remote, a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await snapshotWorkstream(b, 'billing');
	const before = await tip(remote);
	expect(await pullMemory(b)).toEqual({
		fetched: true,
		merged: true,
		ahead: true,
		needsForce: false,
		entries: 2,
	});
	expect(await slugs(b)).toEqual(['auth', 'billing']);
	expect(await tip(remote)).toBe(before);
});

test('memory deleted on the remote is pushed again, not read from a stale copy', async () => {
	const {remote, a} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await gitOutput(remote, ['update-ref', '-d', MEMORY_REF]);
	expect(await syncMemory(a)).toMatchObject({fetched: false, pushed: true});
	expect(await tip(remote)).toBe(await tip(a));
});

test('the newer entry wins when both changed the same slug', async () => {
	const {a, b} = await world();
	await plant(a, {
		'workstreams/auth.json': entryText('auth', {
			title: 'Old title',
			emoji: '🐢',
			status: 'active',
			updatedAt: '2026-02-01T00:00:00.000Z',
			commits: [commitFor('a', 'only on a')],
		}),
	});
	await plant(b, {
		'workstreams/auth.json': entryText('auth', {
			title: 'New title',
			status: 'shipped',
			updatedAt: '2026-03-01T00:00:00.000Z',
			commits: [commitFor('b', 'only on b')],
		}),
	});
	await syncMemory(a);
	await syncMemory(b);
	await syncMemory(a);
	for (const dir of [a, b]) {
		const found = await readMemory(dir, 'auth');
		expect(found).toMatchObject({title: 'New title', status: 'shipped'});
		expect(found).not.toHaveProperty('emoji');
		expect(found?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
		expect(found?.commits.map(commit => commit.hash).sort()).toEqual([
			'a'.repeat(40),
			'b'.repeat(40),
		]);
	}
});

const card = (fields: Partial<Record<string, string[]>>) => ({
	why: [],
	constraint: [],
	gotcha: [],
	followUp: [],
	...fields,
});

test('a forged entry with no card on a shared hash keeps the card', async () => {
	const {tree, written} = await merge(
		{'workstreams/auth.json': 'ours'},
		{'workstreams/auth.json': 'theirs'},
		{
			ours: entryText('auth', {commits: [commitFor('a', 'the real reason')]}),
			theirs: entryText('auth', {
				title: 'Forged',
				updatedAt: '9999-12-31T23:59:59.000Z',
				commits: [commitFor('a')],
			}),
		},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'written-1'});
	expect(written[0]).toMatchObject({title: 'Forged'});
	expect(written[0]!.commits[0]!.card?.why).toEqual(['the real reason']);
});

test('two cards on a shared hash are joined field by field', async () => {
	const {written} = await merge(
		{'workstreams/auth.json': 'ours'},
		{'workstreams/auth.json': 'theirs'},
		{
			ours: entryText('auth', {
				commits: [
					{
						...commitFor('a'),
						card: card({why: ['one'], gotcha: ['shared']}),
					},
				],
			}),
			theirs: entryText('auth', {
				updatedAt: '2026-03-01T00:00:00.000Z',
				commits: [
					{
						...commitFor('a'),
						card: card({
							why: ['two'],
							gotcha: ['shared'],
							constraint: ['tight'],
							followUp: ['later'],
						}),
					},
				],
			}),
		},
	);
	const merged = written[0]!.commits[0]!.card!;
	expect([...merged.why].sort()).toEqual(['one', 'two']);
	expect(merged.gotcha).toEqual(['shared']);
	expect(merged.constraint).toEqual(['tight']);
	expect(merged.followUp).toEqual(['later']);
});

test('an entry with the same hashes in another order keeps its blob', async () => {
	const {tree, written} = await merge(
		{'workstreams/auth.json': 'ours'},
		{'workstreams/auth.json': 'theirs'},
		{
			ours: entryText('auth', {commits: [commitFor('a'), commitFor('b')]}),
			theirs: entryText('auth', {
				updatedAt: '2026-03-01T00:00:00.000Z',
				commits: [commitFor('b'), commitFor('a')],
			}),
		},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'theirs'});
	expect(written).toEqual([]);
});

test('a forged far-future date loses no commits', async () => {
	const {tree, written} = await merge(
		{'workstreams/auth.json': 'ours'},
		{'workstreams/auth.json': 'theirs'},
		{
			ours: entryText('auth', {
				title: 'Honest',
				updatedAt: '2026-03-01T00:00:00.000Z',
				commits: [commitFor('a', 'real reason')],
			}),
			theirs: entryText('auth', {
				title: 'Forged',
				updatedAt: '9999-12-31T23:59:59.000Z',
				commits: [],
			}),
		},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'written-1'});
	expect(written[0]).toMatchObject({title: 'Forged'});
	expect(written[0]!.commits).toEqual([commitFor('a', 'real reason')]);
});

test('an entry with nothing new keeps its blob, so a merge settles', async () => {
	const blobs = {
		newer: entryText('auth', {
			updatedAt: '2026-03-01T00:00:00.000Z',
			commits: [commitFor('a'), commitFor('b')],
		}),
		older: entryText('auth', {commits: [commitFor('a')]}),
	};
	const {tree, written} = await merge(
		{'workstreams/auth.json': 'older'},
		{'workstreams/auth.json': 'newer'},
		blobs,
	);
	expect(tree).toEqual({'workstreams/auth.json': 'newer'});
	expect(written).toEqual([]);
});

test.each([
	['ours', {ours: 'bad', theirs: 'good'}],
	['theirs', {ours: 'good', theirs: 'bad'}],
])('an unreadable entry loses to a readable one: %s', async (_name, sides) => {
	const {tree} = await merge(
		{'workstreams/auth.json': sides.ours},
		{'workstreams/auth.json': sides.theirs},
		{
			bad: '{not json',
			good: entryText('auth', {commits: [commitFor('a')]}),
		},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'good'});
});

test('an unreadable entry with a far-future date still loses', async () => {
	const {tree} = await merge(
		{'workstreams/auth.json': 'bad'},
		{'archive/auth.json': 'good'},
		{
			bad: entryText('other', {updatedAt: '9999-01-01T00:00:00.000Z'}),
			good: entryText('auth', {archived: true}),
		},
	);
	expect(tree).toEqual({'archive/auth.json': 'good'});
});

test('a blob that will not load counts as unreadable', async () => {
	const {tree} = await merge(
		{'workstreams/auth.json': 'missing'},
		{'workstreams/auth.json': 'good'},
		{good: entryText('auth')},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'good'});
});

test('when neither entry can be read, ours stays', async () => {
	const {tree} = await merge(
		{'workstreams/auth.json': 'one'},
		{'workstreams/auth.json': 'two'},
		{one: '{not json', two: 'also not'},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'one'});
});

test('merge takes the union of paths', async () => {
	const {tree} = await merge(
		{'workstreams/auth.json': 'one', 'archive/old.json': 'two'},
		{'workstreams/billing.json': 'three', 'purged/gone': 'empty'},
		{},
	);
	expect(tree).toEqual({
		'workstreams/auth.json': 'one',
		'archive/old.json': 'two',
		'workstreams/billing.json': 'three',
		'purged/gone': 'empty',
	});
});

test('identical blobs on both sides need no reading', async () => {
	const {tree} = await merge(
		{'workstreams/auth.json': 'same'},
		{'workstreams/auth.json': 'same'},
		{},
	);
	expect(tree).toEqual({'workstreams/auth.json': 'same'});
});

test.each([
	['older', '2026-01-01T00:00:00.000Z', 'archive/auth.json'],
	['just as new', '2026-02-01T00:00:00.000Z', 'archive/auth.json'],
	['newer', '2026-03-01T00:00:00.000Z', 'workstreams/auth.json'],
])(
	'a live entry that is %s than the archived one',
	async (_name, updatedAt, kept) => {
		const blobs = {
			live: entryText('auth', {updatedAt}),
			archived: entryText('auth', {
				updatedAt: '2026-02-01T00:00:00.000Z',
				archived: true,
			}),
		};
		for (const [ours, theirs] of [
			[{'workstreams/auth.json': 'live'}, {'archive/auth.json': 'archived'}],
			[{'archive/auth.json': 'archived'}, {'workstreams/auth.json': 'live'}],
		] as Array<[Record<string, string>, Record<string, string>]>) {
			const {tree} = await merge(ours, theirs, blobs);
			expect(Object.keys(tree)).toEqual([kept]);
		}
	},
);

test('an archive on one clone reaches the other', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await syncMemory(b);
	await archiveMemory(a, 'auth');
	await snapshotWorkstream(a, 'billing');
	await snapshotWorkstream(b, 'billing');
	await syncMemory(a);
	await syncMemory(b);
	expect((await listMemory(b)).map(entry => entry.slug)).toEqual(['billing']);
	expect((await readMemory(b, 'auth'))?.archived).toBe(true);
});

test('merging a commit under an archive keeps it archived', async () => {
	const {tree, written} = await merge(
		{'archive/auth.json': 'archived'},
		{'workstreams/auth.json': 'live'},
		{
			archived: entryText('auth', {
				updatedAt: '2026-02-01T00:00:00.000Z',
				archived: true,
				commits: [commitFor('a')],
			}),
			live: entryText('auth', {commits: [commitFor('b')]}),
		},
	);
	expect(Object.keys(tree)).toEqual(['archive/auth.json']);
	expect(written[0]).toMatchObject({archived: true});
	expect(written[0]!.commits).toHaveLength(2);
});

test('a tombstone stops a purged entry coming back', async () => {
	for (const [ours, theirs] of [
		[
			{'purged/auth': 'stone'},
			{'workstreams/auth.json': 'live', 'archive/auth.json': 'old'},
		],
		[{'archive/auth.json': 'old'}, {'purged/auth': 'stone'}],
	] as Array<[Record<string, string>, Record<string, string>]>) {
		const {tree} = await merge(ours, theirs, {});
		expect(tree).toEqual({'purged/auth': 'stone'});
	}
});

/** Local text that must never reach the remote, in `a` and on the remote. */
async function synced(extra?: (b: string) => Promise<unknown>) {
	const setup = await world();
	const {a, b} = setup;
	await snapshotWorkstream(a, 'auth');
	await snapshotWorkstream(a, 'billing');
	await syncMemory(a);
	await syncMemory(b);
	await extra?.(b);
	return setup;
}

test('local purged and remote still holds the entry: no merge reaches the text', async () => {
	const {remote, a} = await synced();
	const before = await tip(remote);
	await purgeMemory(a, 'auth');
	const purged = await tip(a);

	expect(await syncMemory(a)).toEqual({
		fetched: true,
		merged: false,
		pushed: false,
		needsForce: true,
		entries: 1,
	});
	// The remote adds nothing here, so the purge commit stays as it is.
	expect(await tip(a)).toBe(purged);
	expect(await tip(remote)).toBe(before);
	expect(await historyOf(a)).not.toContain('the old form leaked');

	await gitOutput(a, ['push', '--force', 'origin', MEMORY_REF]);
	expect(await historyOf(remote)).not.toContain('the old form leaked');
	expect(await tip(remote)).toBe(await tip(a));
	expect(await syncMemory(a)).toMatchObject({
		pushed: false,
		needsForce: false,
	});
});

test('a local purge takes what the remote added, with only itself as parent', async () => {
	const {remote, a, b} = await synced();
	await plant(b, {'workstreams/new.json': entryText('new')});
	await syncMemory(b);
	await purgeMemory(a, 'auth');
	const purged = await tip(a);

	expect(await syncMemory(a)).toMatchObject({
		merged: true,
		pushed: false,
		needsForce: true,
		entries: 2,
	});
	expect(await parentsOf(a, MEMORY_REF)).toEqual([purged]);
	expect(await slugs(a)).toEqual(['billing', 'new']);
	expect(await historyOf(a)).not.toContain('the old form leaked');

	// Asking again writes nothing new.
	const settled = await tip(a);
	await syncMemory(a);
	expect(await tip(a)).toBe(settled);

	await gitOutput(a, ['push', '--force', 'origin', MEMORY_REF]);
	expect(await historyOf(remote)).not.toContain('the old form leaked');
	expect(await slugs(remote)).toEqual(['billing', 'new']);
});

test('remote purged and local still holds the entry: it goes, and local work stays', async () => {
	const {remote, a, b} = await synced();
	await purgeMemory(a, 'auth');
	await syncMemory(a);
	await gitOutput(a, ['push', '--force', 'origin', MEMORY_REF]);
	const purged = await tip(remote);

	await plant(b, {'workstreams/new.json': entryText('new')});
	expect(await syncMemory(b)).toMatchObject({
		merged: true,
		pushed: true,
		needsForce: false,
		entries: 2,
	});
	expect(await parentsOf(b, MEMORY_REF)).toEqual([purged]);
	expect(await tip(remote)).toBe(await tip(b));
	expect(await historyOf(b)).not.toContain('the old form leaked');
	expect(await historyOf(remote)).not.toContain('the old form leaked');
	expect(await readMemory(b, 'auth')).toBeUndefined();
	expect(await slugs(b)).toEqual(['billing', 'new']);
});

test('a remote purge with nothing new locally is a plain move to its tip', async () => {
	const {remote, a, b} = await synced();
	await purgeMemory(a, 'auth');
	await syncMemory(a);
	await gitOutput(a, ['push', '--force', 'origin', MEMORY_REF]);
	expect(await syncMemory(b)).toMatchObject({merged: true, pushed: false});
	expect(await tip(b)).toBe(await tip(remote));
});

test('each side purged what the other still holds: the merge has no parents', async () => {
	const {remote, a, b} = await synced();
	await purgeMemory(a, 'auth');
	await purgeMemory(b, 'billing');
	await syncMemory(b);
	expect(await tip(remote)).not.toBe(await tip(b));
	await gitOutput(b, ['push', '--force', 'origin', MEMORY_REF]);

	expect(await syncMemory(a)).toMatchObject({
		merged: true,
		pushed: false,
		needsForce: true,
		entries: 0,
	});
	expect(await parentsOf(a, MEMORY_REF)).toEqual([]);
	const tree = await readTree(a, MEMORY_REF);
	expect([...tree.keys()].sort()).toEqual(['purged/auth', 'purged/billing']);
	expect(await historyOf(a)).not.toContain('the old form leaked');
	expect(await historyOf(a)).not.toContain('money');

	const settled = await tip(a);
	await syncMemory(a);
	expect(await tip(a)).toBe(settled);
});

test('both sides purged the same slug: a plain merge, nothing to force', async () => {
	const {remote, a, b} = await synced();
	await purgeMemory(a, 'auth');
	await syncMemory(a);
	await gitOutput(a, ['push', '--force', 'origin', MEMORY_REF]);
	// Something else differs, or both purges could be the very same commit.
	await plant(b, {'workstreams/new.json': entryText('new')});
	await purgeMemory(b, 'auth');
	expect(await syncMemory(b)).toMatchObject({
		merged: true,
		pushed: true,
		needsForce: false,
	});
	expect(await parentsOf(b, MEMORY_REF)).toHaveLength(2);
	expect(await tip(remote)).toBe(await tip(b));
	expect(await historyOf(remote)).not.toContain('the old form leaked');
});

test('a purge synced before anything else happened never pushes the old text', async () => {
	const {remote, a} = await world();
	await snapshotWorkstream(a, 'auth');
	await purgeMemory(a, 'auth');
	expect(await syncMemory(a)).toMatchObject({pushed: true, needsForce: false});
	expect(await historyOf(remote)).not.toContain('the old form leaked');
});

test('sync retries once when a push loses a race', async () => {
	const {remote, a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await snapshotWorkstream(b, 'billing');
	race.before.push(async () => syncMemory(b));
	expect(await syncMemory(a)).toMatchObject({
		merged: true,
		pushed: true,
		entries: 2,
	});
	expect(await tip(remote)).toBe(await tip(a));
	expect(await slugs(a)).toEqual(['auth', 'billing']);
});

test('a push the remote refuses is a MemoryError, tried once, and keeps the local merge', async () => {
	const {remote, a, b} = await world();
	await snapshotWorkstream(b, 'billing');
	await syncMemory(b);
	await snapshotWorkstream(a, 'auth');
	await writeFile(
		path.join(remote, 'hooks/update'),
		'#!/bin/sh\necho x >> "$GIT_DIR/tries"\necho no memory here >&2\nexit 1\n',
		{mode: 0o755},
	);
	const failure = await syncMemory(a).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(MemoryError);
	expect((failure as Error).message).toContain('no memory here');
	expect(await slugs(a)).toEqual(['auth', 'billing']);
	// A refusal would be the same on a second push, so there was no second push.
	expect(await readFile(path.join(remote, 'tries'), 'utf8')).toBe('x\n');
});

test('a failing pre-push hook is a MemoryError after one run', async () => {
	const {remote, a} = await world();
	await snapshotWorkstream(a, 'auth');
	const marker = path.join(await tempDir(), 'ran');
	await writeFile(
		path.join(a, '.git/hooks/pre-push'),
		`#!/bin/sh\necho ran >> "${marker}"\necho blocked by policy >&2\nexit 1\n`,
		{mode: 0o755},
	);
	const failure = await syncMemory(a).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(MemoryError);
	expect((failure as Error).message).toContain(
		'Could not push memory to origin',
	);
	// A refusal is the same on a second push, so the hook ran once.
	expect(await readFile(marker, 'utf8')).toBe('ran\n');
	expect(await gitOutput(remote, ['for-each-ref', 'refs/chamoji'])).toBe('');
});

test('a fetch that fails is a MemoryError', async () => {
	const {a} = await world();
	await gitOutput(a, ['remote', 'set-url', 'origin', `${a}-missing`]);
	await expect(syncMemory(a)).rejects.toBeInstanceOf(MemoryError);
	await expect(syncMemory(a)).rejects.toThrow('Could not fetch memory');
});

/** Pushes, without force, a commit on top of origin's memory holding `tree`. */
async function pushDescendant(
	dir: string,
	tree: Map<string, string>,
): Promise<string> {
	const commit = await writeTree(dir, tree, [await tip(dir)], 'Forged');
	await gitOutput(dir, ['push', '-q', 'origin', `${commit}:${MEMORY_REF}`]);
	return commit;
}

test('a descendant that drops an entry does not take it away', async () => {
	const {remote, a, b} = await synced();
	const tree = await readTree(b, MEMORY_REF);
	tree.delete('workstreams/auth.json');
	const forged = await pushDescendant(b, tree);

	expect(await syncMemory(a)).toEqual({
		fetched: true,
		merged: true,
		pushed: true,
		needsForce: false,
		entries: 2,
	});
	expect(await parentsOf(a, MEMORY_REF)).toEqual([forged]);
	expect((await readMemory(a, 'auth'))?.commits[0]?.card?.why).toEqual([
		'the old form leaked',
	]);
	expect(await tip(remote)).toBe(await tip(a));
});

test('a descendant with an empty tree empties nothing', async () => {
	const {a, b} = await synced();
	await pushDescendant(b, new Map());
	expect(await syncMemory(a)).toMatchObject({entries: 2, pushed: true});
	expect(await slugs(a)).toEqual(['auth', 'billing']);
});

test('a descendant that drops an entry cannot empty a clone through init', async () => {
	const {a, b} = await synced();
	await pushDescendant(b, new Map());
	expect(await pullMemory(a)).toMatchObject({entries: 2, ahead: true});
});

/** `a` and `b` both on a tree with auth purged, and that on origin too. */
async function purgedEverywhere() {
	const setup = await synced();
	const {a, b} = setup;
	await purgeMemory(a, 'auth');
	await syncMemory(a);
	await gitOutput(a, ['push', '--force', 'origin', MEMORY_REF]);
	await syncMemory(b);
	return setup;
}

test('a descendant that drops a tombstone does not lift it', async () => {
	const {remote, a, b} = await purgedEverywhere();
	const tree = await readTree(b, MEMORY_REF);
	tree.delete('purged/auth');
	const forged = await pushDescendant(b, tree);

	expect(await syncMemory(a)).toMatchObject({
		merged: true,
		pushed: true,
		needsForce: false,
	});
	expect(await parentsOf(a, MEMORY_REF)).toEqual([forged]);
	expect((await readTree(a, MEMORY_REF)).has('purged/auth')).toBe(true);
	expect(await tip(remote)).toBe(await tip(a));
});

test('a descendant that drops a tombstone and brings the entry back is left out', async () => {
	const {a, b} = await purgedEverywhere();
	const purged = await tip(a);
	const tree = await readTree(b, MEMORY_REF);
	tree.delete('purged/auth');
	const args = ['hash-object', '-w', '--stdin'];
	const text = entryText('auth', {title: 'the old form leaked'});
	tree.set(
		'workstreams/auth.json',
		(await runGitWithInput(args, b, text)).trim(),
	);
	await pushDescendant(b, tree);

	expect(await syncMemory(a)).toMatchObject({
		merged: false,
		pushed: false,
		needsForce: true,
	});
	expect(await tip(a)).toBe(purged);
	expect(await readMemory(a, 'auth')).toBeUndefined();
	expect(await historyOf(a)).not.toContain('the old form leaked');
});

test('a git failure comparing commits is not read as a need to force', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await snapshotWorkstream(b, 'billing');
	const before = await tip(b);
	race.broken = 'merge-base';
	const failure = await syncMemory(b).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(MemoryError);
	expect((failure as Error).message).toContain('fatal: bad object');
	expect(await tip(b)).toBe(before);
});

test('a git failure asking for origin is not read as no origin', async () => {
	const {a} = await world();
	race.broken = 'remote';
	const failure = await syncMemory(a).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(MemoryError);
	expect((failure as Error).message).toContain('fatal: bad object');
	expect((failure as Error).message).not.toContain('No remote named origin');
});

test('sync with no origin throws MemoryError', async () => {
	const {dir} = await makeRepo([{commit: '🎉 Init'}]);
	const failure = await syncMemory(dir).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(MemoryError);
	expect((failure as Error).message).toBe('No remote named origin');
});

test('sync works from a subdirectory', async () => {
	const {remote, a} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(path.join(a, '.chamoji'));
	expect(await tip(remote)).toBe(await tip(a));
});

test('junk on the remote stays out of what readers and merges see', async () => {
	const {a, b} = await world();
	await snapshotWorkstream(a, 'auth');
	await syncMemory(a);
	await snapshotWorkstream(b, 'billing');
	const stray = await plantStray(a);
	await gitOutput(a, ['push', '-q', 'origin', `${stray}:${MEMORY_REF}`]);
	await syncMemory(b);
	expect(await slugs(b)).toEqual(['auth', 'billing']);
	const tree = await readTree(b, MEMORY_REF);
	expect([...tree.keys()].sort()).toEqual([
		'workstreams/auth.json',
		'workstreams/billing.json',
	]);
	expect(await gitOutput(b, ['ls-tree', '-r', '--name-only', MEMORY_REF])).toBe(
		'workstreams/auth.json\nworkstreams/billing.json\n',
	);
});

/** A commit on the memory ref with a file outside the layout in it. */
async function plantStray(dir: string): Promise<string> {
	const blob = (
		await runGitWithInput(['hash-object', '-w', '--stdin'], dir, 'stray\n')
	).trim();
	const entries = await gitOutput(dir, ['ls-tree', MEMORY_REF]);
	const tree = (
		await runGitWithInput(
			['mktree'],
			dir,
			`${entries}100644 blob ${blob}\tstray.txt\n`,
		)
	).trim();
	return (
		await gitOutput(dir, ['commit-tree', tree, '-p', MEMORY_REF, '-m', 'stray'])
	).trim();
}
