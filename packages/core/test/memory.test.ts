import {mkdir, writeFile} from 'node:fs/promises';
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
} from '../src/memory.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

/** Runs just before the next real `update-ref`, to move the ref under a write. */
const race = vi.hoisted(() => ({before: [] as Array<() => Promise<unknown>>}));

vi.mock('../src/git.js', async importOriginal => {
	const real = await importOriginal<typeof import('../src/git.js')>();
	return {
		...real,
		async runGit(args: string[], cwd: string) {
			if (args[0] === 'update-ref') await race.before.shift()?.();
			return real.runGit(args, cwd);
		},
	};
});

let repo: FixtureRepo | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	race.before = [];
	await repo?.cleanup();
	repo = undefined;
});

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    emoji: 🔐',
		'    status: shipped',
		'  billing:',
		'    title: Billing',
		'    status: active',
		'',
	].join('\n'),
};

/** Three commits, two of which name `auth`. */
async function shippedRepo(): Promise<string> {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nGotcha: order matters\nWorkstream: auth',
		},
		{commit: '🐛 Fix footer'},
		{commit: '🐛 Fix login', body: 'Workstream: auth'},
	]);
	return repo.dir;
}

/** Points the memory ref at a tree holding exactly `files`, each one directory deep. */
async function plant(
	dir: string,
	files: Record<string, string>,
	mode = '100644',
): Promise<void> {
	const folders = new Map<string, string[]>();
	for (const [file, text] of Object.entries(files)) {
		const [folder, name] = file.split('/') as [string, string];
		const blob = (
			await runGitWithInput(['hash-object', '-w', '--stdin'], dir, text)
		).trim();
		folders.set(folder, [
			...(folders.get(folder) ?? []),
			`${mode} blob ${blob}\t${name}`,
		]);
	}

	const root: string[] = [];
	for (const [folder, lines] of folders) {
		const tree = (
			await runGitWithInput(['mktree'], dir, `${lines.join('\n')}\n`)
		).trim();
		root.push(`040000 tree ${tree}\t${folder}`);
	}

	const tree = (
		await runGitWithInput(['mktree'], dir, `${root.join('\n')}\n`)
	).trim();
	const commit = (
		await gitOutput(dir, ['commit-tree', tree, '-m', 'x'])
	).trim();
	await gitOutput(dir, ['update-ref', MEMORY_REF, commit]);
}

function entry(slug: string, extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		version: 1,
		slug,
		title: 'Planted',
		status: 'shipped',
		updatedAt: '2026-01-01T00:00:00.000Z',
		archived: false,
		commits: [],
		...extra,
	});
}

const refHistory = async (dir: string) =>
	gitOutput(dir, ['log', '-p', MEMORY_REF]);

/** Takes the commits off every branch, so only memory can still hold their text. */
const dropBranchCommits = async (dir: string) =>
	gitOutput(dir, ['reset', '-q', '--hard', 'HEAD~3']);

const everyRef = async (dir: string) =>
	gitOutput(dir, ['log', '--all', '-p', MEMORY_REF]);

test('a snapshot holds the commits that name the workstream', async () => {
	const dir = await shippedRepo();
	const saved = await snapshotWorkstream(dir, 'auth');
	expect(saved).toMatchObject({
		version: 1,
		slug: 'auth',
		title: 'Auth revamp',
		emoji: '🔐',
		status: 'shipped',
		archived: false,
	});
	expect(saved.commits.map(commit => commit.subject)).toEqual([
		'🐛 Fix login',
		'✨ Add login',
	]);
	expect(saved.commits[1]!.card).toEqual({
		why: ['the old form leaked'],
		constraint: [],
		gotcha: ['order matters'],
		followUp: [],
	});
	expect(saved.commits[0]).not.toHaveProperty('card');
	expect(saved.commits[1]!.hash).toMatch(/^[0-9a-f]{40}$/);
	expect(await readMemory(dir, 'auth')).toEqual(saved);
});

test('a snapshot from a subdirectory reads the whole tree', async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'auth');
	await snapshotWorkstream(path.join(dir, '.chamoji'), 'billing');
	expect((await listMemory(dir)).map(item => item.slug)).toEqual([
		'auth',
		'billing',
	]);
	expect(await readMemory(path.join(dir, '.chamoji'), 'auth')).toBeDefined();
});

test('a snapshot of a repo with no commits yet holds none', async () => {
	repo = await createRepo([]);
	await mkdir(path.join(repo.dir, '.chamoji'));
	await writeFile(
		path.join(repo.dir, '.chamoji/workstreams.yml'),
		WORKSTREAMS['.chamoji/workstreams.yml'],
	);
	expect((await snapshotWorkstream(repo.dir, 'auth')).commits).toEqual([]);
});

test('a snapshot leaves the work tree, the index and HEAD alone', async () => {
	const dir = await shippedRepo();
	await writeFile(path.join(dir, 'staged.txt'), 'staged\n');
	await gitOutput(dir, ['add', 'staged.txt']);
	await writeFile(path.join(dir, 'loose.txt'), 'loose\n');
	const status = await gitOutput(dir, ['status', '--porcelain']);
	const head = await gitOutput(dir, ['rev-parse', 'HEAD']);
	const index = await gitOutput(dir, ['write-tree']);

	await snapshotWorkstream(dir, 'auth');
	await archiveMemory(dir, 'auth');
	await purgeMemory(dir, 'auth');

	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe(status);
	expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(head);
	expect(await gitOutput(dir, ['write-tree'])).toBe(index);
});

test('a later snapshot keeps commits it can no longer reach', async () => {
	const dir = await shippedRepo();
	const first = await snapshotWorkstream(dir, 'auth');
	await gitOutput(dir, ['reset', '-q', '--hard', 'HEAD~2']);
	await writeFile(path.join(dir, 'next.txt'), 'next\n');
	await gitOutput(dir, ['add', 'next.txt']);
	await gitOutput(dir, ['commit', '-q', '-m', '🐛 Later\n\nWorkstream: auth']);

	const later = await snapshotWorkstream(dir, 'auth');
	expect(later.commits).toHaveLength(3);
	expect(later.commits.map(commit => commit.hash)).toEqual(
		expect.arrayContaining(first.commits.map(commit => commit.hash)),
	);
	expect(new Set(later.commits.map(commit => commit.hash)).size).toBe(3);
	expect(later.commits[0]!.subject).toBe('🐛 Later');
});

test('works with no git identity set', async () => {
	const dir = await shippedRepo();
	await gitOutput(dir, ['config', '--unset', 'user.name']);
	await gitOutput(dir, ['config', '--unset', 'user.email']);
	// Without this, git would make an identity up from the host name.
	await gitOutput(dir, ['config', 'user.useConfigOnly', 'true']);
	vi.stubEnv('GIT_CONFIG_GLOBAL', `${dir}.gitconfig`);
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
	await expect(
		gitOutput(dir, ['commit', '--allow-empty', '-m', 'needs an identity']),
	).rejects.toThrow();

	await snapshotWorkstream(dir, 'auth');
	expect(await readMemory(dir, 'auth')).toBeDefined();
});

test('the ref records no author email', async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'auth');
	const identity = await gitOutput(dir, [
		'log',
		'--format=%an %ae %cn %ce',
		MEMORY_REF,
	]);
	expect(identity).toBe(
		'chamoji noreply@chamoji.dev chamoji noreply@chamoji.dev\n',
	);
	expect(await refHistory(dir)).not.toContain('fixture@example.com');
});

test('the identity holds against config and environment that outrank user.email', async () => {
	const dir = await shippedRepo();
	await gitOutput(dir, ['config', 'author.email', 'config@example.com']);
	await gitOutput(dir, ['config', 'committer.email', 'config@example.com']);
	vi.stubEnv('GIT_AUTHOR_NAME', 'Real Name');
	vi.stubEnv('GIT_AUTHOR_EMAIL', 'real@example.com');
	vi.stubEnv('GIT_COMMITTER_NAME', 'Real Name');
	vi.stubEnv('GIT_COMMITTER_EMAIL', 'real@example.com');
	await snapshotWorkstream(dir, 'auth');
	expect(
		await gitOutput(dir, ['log', '--format=%an %ae %cn %ce', MEMORY_REF]),
	).toBe('chamoji noreply@chamoji.dev chamoji noreply@chamoji.dev\n');
});

test("an entry that isn't valid JSON is skipped by listMemory and throws MemoryError from readMemory", async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/broken.json': '{not json',
		'workstreams/fine.json': entry('fine'),
	});
	expect((await listMemory(dir)).map(item => item.slug)).toEqual(['fine']);
	await expect(readMemory(dir, 'broken')).rejects.toBeInstanceOf(MemoryError);
});

const hash = 'a'.repeat(40);
const commit = {hash, subject: 'x', date: '2026-01-01T00:00:00Z'};

test.each([
	['a null', 'null'],
	['an array', '[]'],
	['another version', entry('bad', {version: 2})],
	['a different slug', entry('other')],
	['no title', entry('bad', {title: undefined})],
	['a blank title', entry('bad', {title: '  '})],
	['an unknown status', entry('bad', {status: 'done'})],
	['an emoji that is not text', entry('bad', {emoji: 7})],
	['a bad date', entry('bad', {updatedAt: 'soon'})],
	['forged text for a date', entry('bad', {updatedAt: '1 (forged text)'})],
	[
		'an updatedAt nothing can compare',
		entry('bad', {updatedAt: '10000-01-01T00:00:00Z'}),
	],
	['a date with no time', entry('bad', {updatedAt: '2026-01-01'})],
	['commits that are not a list', entry('bad', {commits: {}})],
	['a commit that is not an object', entry('bad', {commits: ['x']})],
	['a bad hash', entry('bad', {commits: [{...commit, hash: '--all'}]})],
	[
		'a subject that is not text',
		entry('bad', {commits: [{...commit, subject: 1}]}),
	],
	[
		'a commit with a bad date',
		entry('bad', {commits: [{...commit, date: 'x'}]}),
	],
	[
		'forged text for a commit date',
		entry('bad', {commits: [{...commit, date: '1 (forged text)'}]}),
	],
	[
		'a newline after a commit date',
		entry('bad', {commits: [{...commit, date: `${commit.date}\n`}]}),
	],
	[
		'a card missing a list',
		entry('bad', {commits: [{...commit, card: {why: []}}]}),
	],
	[
		'a card holding numbers',
		entry('bad', {
			commits: [
				{...commit, card: {why: [1], constraint: [], gotcha: [], followUp: []}},
			],
		}),
	],
])('an entry with %s is refused', async (_name, text) => {
	const dir = await shippedRepo();
	await plant(dir, {'workstreams/bad.json': text});
	expect(await listMemory(dir)).toEqual([]);
	await expect(readMemory(dir, 'bad')).rejects.toBeInstanceOf(MemoryError);
});

test('an entry keeps only the fields it should, and takes archived from its path', async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/fine.json': entry('fine', {archived: true, extra: 'x'}),
	});
	const found = await readMemory(dir, 'fine');
	expect(found?.archived).toBe(false);
	expect(found).not.toHaveProperty('extra');
});

test.each([['../evil'], ['Bad_Slug'], [''], ['a/b'], ['__proto__']])(
	'a slug that fails isSlug is refused: %j',
	async slug => {
		const dir = await shippedRepo();
		await expect(readMemory(dir, slug)).rejects.toBeInstanceOf(MemoryError);
		await expect(snapshotWorkstream(dir, slug)).rejects.toBeInstanceOf(
			MemoryError,
		);
		await expect(archiveMemory(dir, slug)).rejects.toBeInstanceOf(MemoryError);
		await expect(purgeMemory(dir, slug)).rejects.toBeInstanceOf(MemoryError);
	},
);

test("a tree path that isn't a slug is ignored on read", async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/Bad_Slug.json': entry('Bad_Slug'),
		'workstreams/fine.json': entry('fine'),
		'workstreams/no-extension': entry('no-extension'),
		'archive/UPPER.json': entry('UPPER'),
		'other/stray.json': entry('stray'),
		'purged/Not_Slug': '',
	});
	expect(
		(await listMemory(dir, {archived: true})).map(item => item.slug),
	).toEqual(['fine']);
	const head = (await gitOutput(dir, ['rev-parse', MEMORY_REF])).trim();
	expect([...(await readTree(dir, head)).keys()]).toEqual([
		'workstreams/fine.json',
	]);
});

test('a symlink in the tree is ignored on read', async () => {
	const dir = await shippedRepo();
	await plant(dir, {'workstreams/linked.json': entry('linked')}, '120000');
	expect(await listMemory(dir)).toEqual([]);
	expect(await readMemory(dir, 'linked')).toBeUndefined();
});

test('nothing in memory reads as empty', async () => {
	const dir = await shippedRepo();
	expect(await listMemory(dir)).toEqual([]);
	expect(await readMemory(dir, 'auth')).toBeUndefined();
});

test('a slug with no workstream is refused', async () => {
	const dir = await shippedRepo();
	await expect(snapshotWorkstream(dir, 'nope')).rejects.toThrow(
		'No workstream named "nope"',
	);
});

test('archive moves the entry and keeps its content', async () => {
	const dir = await shippedRepo();
	const saved = await snapshotWorkstream(dir, 'auth');
	await snapshotWorkstream(dir, 'billing');
	await archiveMemory(dir, 'auth');

	expect((await listMemory(dir)).map(item => item.slug)).toEqual(['billing']);
	expect(
		(await listMemory(dir, {archived: true})).map(item => item.slug),
	).toEqual(['auth', 'billing']);
	const archived = await readMemory(dir, 'auth');
	expect(archived).toMatchObject({
		archived: true,
		title: saved.title,
		commits: saved.commits,
	});
	const tree = await readTree(dir, MEMORY_REF);
	expect(tree.has('archive/auth.json')).toBe(true);
	expect(tree.has('workstreams/auth.json')).toBe(false);
	// Archive never deletes: the old commit is still there.
	expect(await gitOutput(dir, ['rev-list', '--count', MEMORY_REF])).toBe('3\n');
});

test('archive says when there is nothing to do', async () => {
	const dir = await shippedRepo();
	await expect(archiveMemory(dir, 'auth')).rejects.toBeInstanceOf(MemoryError);
	await snapshotWorkstream(dir, 'auth');
	await archiveMemory(dir, 'auth');
	await expect(archiveMemory(dir, 'auth')).rejects.toThrow('already archived');
});

test('snapshot of an archived slug brings it back', async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'auth');
	await archiveMemory(dir, 'auth');
	await gitOutput(dir, ['reset', '-q', '--hard', 'HEAD~2']);

	const back = await snapshotWorkstream(dir, 'auth');
	expect(back.archived).toBe(false);
	expect(back.commits).toHaveLength(2);
	expect((await listMemory(dir)).map(item => item.slug)).toEqual(['auth']);
	expect((await readTree(dir, MEMORY_REF)).has('archive/auth.json')).toBe(
		false,
	);
});

test("purge leaves no trace in the ref's history", async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'auth');
	await snapshotWorkstream(dir, 'billing');
	await archiveMemory(dir, 'auth');
	await dropBranchCommits(dir);
	expect(await everyRef(dir)).toContain('the old form leaked');

	await purgeMemory(dir, 'auth');

	expect(await everyRef(dir)).not.toContain('the old form leaked');
	expect(await refHistory(dir)).not.toContain('Auth revamp');
	expect(await readMemory(dir, 'auth')).toBeUndefined();
	const tree = await readTree(dir, MEMORY_REF);
	expect(tree.has('purged/auth')).toBe(true);
	expect(tree.has('archive/auth.json')).toBe(false);
	expect(
		await gitOutput(dir, ['cat-file', '-s', tree.get('purged/auth')!]),
	).toBe('0\n');
	// A new root commit, and the other entry is unharmed.
	expect(await gitOutput(dir, ['rev-list', '--count', MEMORY_REF])).toBe('1\n');
	expect(await readMemory(dir, 'billing')).toBeDefined();
});

test('purge deletes the fetched copy of the remote, which holds the text', async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'auth');
	await snapshotWorkstream(dir, 'billing');
	await gitOutput(dir, ['update-ref', MEMORY_REMOTE_REF, MEMORY_REF]);
	await dropBranchCommits(dir);

	await purgeMemory(dir, 'auth');

	expect(await gitOutput(dir, ['for-each-ref', 'refs/chamoji/remotes'])).toBe(
		'',
	);
	expect(await everyRef(dir)).not.toContain('the old form leaked');
});

test("purge removes a live entry, and one that can't be parsed", async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/broken.json': '{secret text',
		'workstreams/fine.json': entry('fine'),
	});
	await purgeMemory(dir, 'broken');
	expect(await refHistory(dir)).not.toContain('secret text');
	expect((await readTree(dir, MEMORY_REF)).has('workstreams/broken.json')).toBe(
		false,
	);
});

test("purge refuses a slug that doesn't exist", async () => {
	const dir = await shippedRepo();
	await expect(purgeMemory(dir, 'auth')).rejects.toBeInstanceOf(MemoryError);
	await snapshotWorkstream(dir, 'billing');
	await expect(purgeMemory(dir, 'auth')).rejects.toThrow(
		'No memory for "auth"',
	);
	await purgeMemory(dir, 'billing');
	await expect(purgeMemory(dir, 'billing')).rejects.toBeInstanceOf(MemoryError);
});

test('a purged slug is not snapshotted back', async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'auth');
	await purgeMemory(dir, 'auth');
	await expect(snapshotWorkstream(dir, 'auth')).rejects.toThrow('purged');
	expect(await refHistory(dir)).not.toContain('the old form leaked');
	expect(await listMemory(dir, {archived: true})).toEqual([]);
});

test('update-ref is compare-and-swap', async () => {
	const dir = await shippedRepo();
	race.before.push(async () => snapshotWorkstream(dir, 'billing'));
	await snapshotWorkstream(dir, 'auth');
	expect((await listMemory(dir)).map(item => item.slug)).toEqual([
		'auth',
		'billing',
	]);
	expect(await gitOutput(dir, ['rev-list', '--count', MEMORY_REF])).toBe('2\n');
});

test('a ref that moves on every try gives up plainly and keeps the other write', async () => {
	const dir = await shippedRepo();
	await snapshotWorkstream(dir, 'billing');
	const move = async () => {
		await gitOutput(dir, [
			'update-ref',
			MEMORY_REF,
			(
				await gitOutput(dir, [
					'commit-tree',
					`${MEMORY_REF}^{tree}`,
					'-p',
					MEMORY_REF,
					'-m',
					'moved',
				])
			).trim(),
		]);
	};

	race.before.push(move, move);
	await expect(snapshotWorkstream(dir, 'auth')).rejects.toBeInstanceOf(
		MemoryError,
	);
	expect(await gitOutput(dir, ['log', '-1', '--format=%s', MEMORY_REF])).toBe(
		'moved\n',
	);
	expect(await readMemory(dir, 'auth')).toBeUndefined();
});

test('writeTree refuses a path outside the layout', async () => {
	const dir = await shippedRepo();
	const blob = (
		await runGitWithInput(['hash-object', '-w', '--stdin'], dir, 'x')
	).trim();
	for (const file of [
		'workstreams/../../evil.json',
		'workstreams/Bad.json',
		'stray',
		'purged/a/b',
	]) {
		await expect(
			writeTree(dir, new Map([[file, blob]]), [], 'x'),
		).rejects.toBeInstanceOf(MemoryError);
	}
});

test('writeTree and readTree round-trip, with parents', async () => {
	const dir = await shippedRepo();
	const blob = (
		await runGitWithInput(['hash-object', '-w', '--stdin'], dir, entry('fine'))
	).trim();
	const tree = new Map([
		['workstreams/fine.json', blob],
		['archive/old.json', blob],
		['purged/gone', blob],
	]);
	const first = await writeTree(dir, tree, [], 'First');
	const second = await writeTree(dir, tree, [first], 'Second');
	expect(await readTree(dir, second)).toEqual(tree);
	expect(await gitOutput(dir, ['log', '--format=%s', second])).toBe(
		'Second\nFirst\n',
	);
});

test('runGitWithInput feeds stdin and reports git failing', async () => {
	const dir = await shippedRepo();
	const blob = (
		await runGitWithInput(['hash-object', '-w', '--stdin'], dir, 'héllo\n')
	).trim();
	expect(await gitOutput(dir, ['cat-file', 'blob', blob])).toBe('héllo\n');
	await expect(
		runGitWithInput(['mktree'], dir, 'not a tree line\n'),
	).rejects.toMatchObject({stderr: expect.any(String)});
});

/** Puts a commit with exactly this date on main, as a peer's tools could. */
async function commitDated(dir: string, stamp: string): Promise<string> {
	const tree = (await gitOutput(dir, ['rev-parse', 'HEAD^{tree}'])).trim();
	const parent = (await gitOutput(dir, ['rev-parse', 'HEAD'])).trim();
	const author = `Peer <p@example.com> ${stamp}`;
	const text = `tree ${tree}\nparent ${parent}\nauthor ${author}\ncommitter ${author}\n\n🐛 Odd\n\nWhy: kept anyway\nWorkstream: auth\n`;
	const args = ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'];
	const hash = (await runGitWithInput(args, dir, text)).trim();
	await gitOutput(dir, ['update-ref', 'refs/heads/main', hash]);
	return hash;
}

test('a commit dated past year 9999 stays in the entry', async () => {
	const dir = await shippedRepo();
	await gitOutput(dir, [
		'commit',
		'-q',
		'--allow-empty',
		'--date=@253402300800 +0000',
		'-m',
		'🐛 Peer\n\nWorkstream: auth',
	]);
	const saved = await snapshotWorkstream(dir, 'auth');
	expect(saved.commits).toHaveLength(3);
	expect(saved.commits.map(commit => commit.date)).toContain(
		'10000-01-01T00:00:00Z',
	);
	expect(await readMemory(dir, 'auth')).toEqual(saved);
	expect((await listMemory(dir)).map(item => item.slug)).toEqual(['auth']);
});

test.each([
	['+9900', '1767225600 +9900', '2026-01-05T03:00:00+99:00'],
	['+2500', '1767225600 +2500', '2026-01-02T01:00:00+25:00'],
	['+051800', '1767225600 +051800', '2026-01-22T14:00:00+518:00'],
	['a huge stamp', '99999999999999 +0000', '3170843-11-07T09:46:39Z'],
])('a commit with %s stays in the entry', async (_name, stamp, date) => {
	const dir = await shippedRepo();
	const hash = await commitDated(dir, stamp);
	const saved = await snapshotWorkstream(dir, 'auth');
	expect(saved.commits.find(commit => commit.hash === hash)?.date).toBe(date);
	expect(await readMemory(dir, 'auth')).toEqual(saved);
	// And it doesn't block the next one.
	await expect(snapshotWorkstream(dir, 'auth')).resolves.toBeDefined();
});

test.each([
	['a negative stamp', '-100 +0000'],
	['no stamp', ''],
])('a commit with %s is kept at the epoch', async (_name, stamp) => {
	const dir = await shippedRepo();
	const hash = await commitDated(dir, stamp);
	const saved = await snapshotWorkstream(dir, 'auth');
	const found = saved.commits.find(commit => commit.hash === hash);
	expect(found?.date).toBe('1970-01-01T00:00:00Z');
	expect(found?.card?.why).toEqual(['kept anyway']);
	expect(await readMemory(dir, 'auth')).toEqual(saved);
});

test('a date that JavaScript cannot read sorts last, in a stable order', async () => {
	const dir = await shippedRepo();
	await commitDated(dir, '1767225600 +9900');
	await commitDated(dir, '253402300800 +0000');
	const saved = await snapshotWorkstream(dir, 'auth');
	expect(saved.commits.map(commit => commit.subject)).toEqual([
		'🐛 Fix login',
		'✨ Add login',
		'🐛 Odd',
		'🐛 Odd',
	]);
});

test('a snapshot that would not read back is refused and the old entry stays', async () => {
	const dir = await shippedRepo();
	const saved = await snapshotWorkstream(dir, 'auth');
	const tip = await gitOutput(dir, ['rev-parse', MEMORY_REF]);
	// toISOString writes this year as +010000, which isn't a date git gives.
	vi.useFakeTimers({toFake: ['Date']});
	vi.setSystemTime(new Date(Date.UTC(10_000, 0, 1)));
	try {
		await expect(snapshotWorkstream(dir, 'auth')).rejects.toBeInstanceOf(
			MemoryError,
		);
	} finally {
		vi.useRealTimers();
	}

	expect(await gitOutput(dir, ['rev-parse', MEMORY_REF])).toBe(tip);
	expect(await readMemory(dir, 'auth')).toEqual(saved);
});

test('a tombstone hides an entry beside it, and purge still clears it', async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'purged/gone': '',
		'workstreams/gone.json': entry('gone'),
		'archive/gone.json': entry('gone'),
		'workstreams/fine.json': entry('fine'),
	});
	expect(
		(await listMemory(dir, {archived: true})).map(item => item.slug),
	).toEqual(['fine']);
	expect(await readMemory(dir, 'gone')).toBeUndefined();
	await expect(archiveMemory(dir, 'gone')).rejects.toThrow(
		'No memory for "gone"',
	);

	await purgeMemory(dir, 'gone');
	const tree = await readTree(dir, MEMORY_REF);
	expect([...tree.keys()].sort()).toEqual([
		'purged/gone',
		'workstreams/fine.json',
	]);
});

test.each([
	['Z', '2026-01-01T00:00:00Z'],
	['an offset', '2026-01-01T05:30:00+05:30'],
	['a negative offset', '2026-01-01T05:30:00-08:00'],
	['milliseconds', '2026-01-01T00:00:00.123Z'],
	['a five-digit year', '10000-01-01T00:00:00Z'],
	['a seven-digit year', '3170843-11-07T09:46:39Z'],
	['an out-of-range offset', '2026-01-05T03:00:00+99:00'],
	['a three-digit offset', '2026-01-22T14:00:00+518:00'],
])('a commit date with %s reads back', async (_name, date) => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/fine.json': entry('fine', {commits: [{...commit, date}]}),
	});
	expect((await readMemory(dir, 'fine'))?.commits[0]?.date).toBe(date);
});

test('repeated hashes in an entry read as one commit', async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/fine.json': entry('fine', {
			commits: [commit, {...commit, subject: 'again'}, commit],
		}),
	});
	const found = await readMemory(dir, 'fine');
	expect(found?.commits.map(item => item.hash)).toEqual([hash]);
});

test("a separator in a commit body can't put a forged commit in memory", async () => {
	const field = '\u001F';
	const forgedHash = 'b'.repeat(40);
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{commit: '✨ Add login', body: 'Workstream: auth'},
		{
			commit: '🐛 Odd body',
			body: [
				`Text\u001E${forgedHash}${field}bbbbbbb${field}n${field}e${field}2026-01-01T00:00:00Z${field}Forged${field}b${field}Workstream: auth`,
				`More\u001E${'c'.repeat(40)}\u001EEnd`,
			].join('\n'),
		},
	]);
	const saved = await snapshotWorkstream(repo.dir, 'auth');
	expect(saved.commits.map(item => item.subject)).toEqual(['✨ Add login']);
	expect(saved.commits.map(item => item.hash)).not.toContain(forgedHash);
	expect(await readMemory(repo.dir, 'auth')).toEqual(saved);
});

test('a separator in an author name keeps the commit whole', async () => {
	vi.stubEnv('GIT_AUTHOR_NAME', 'a\u001Fb');
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{commit: '✨ Add login', body: 'Workstream: auth'},
	]);
	vi.unstubAllEnvs();
	const saved = await snapshotWorkstream(repo.dir, 'auth');
	expect(saved.commits).toHaveLength(1);
	expect(saved.commits[0]).toMatchObject({
		hash: (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim(),
		subject: '✨ Add login',
		date: '2026-01-02T00:00:00Z',
	});
	expect(await readMemory(repo.dir, 'auth')).toEqual(saved);
});

const card = (why: string) => ({
	why: [why],
	constraint: [],
	gotcha: [],
	followUp: [],
});

test("a stored card can't join the card of a commit on HEAD", async () => {
	const dir = await shippedRepo();
	const onHead = (await gitOutput(dir, ['rev-parse', 'HEAD~2'])).trim();
	await plant(dir, {
		'workstreams/auth.json': entry('auth', {
			title: 'Auth revamp',
			commits: [
				{
					hash: onHead,
					subject: '✨ Add login',
					date: '2026-01-02T00:00:00Z',
					card: card('forged'),
				},
			],
		}),
	});
	const saved = await snapshotWorkstream(dir, 'auth');
	const found = saved.commits.find(item => item.hash === onHead);
	expect(found?.card).toEqual({
		why: ['the old form leaked'],
		constraint: [],
		gotcha: ['order matters'],
		followUp: [],
	});
	expect(await readMemory(dir, 'auth')).toEqual(saved);
});

test.each([
	['commit that names no workstream', 'HEAD~1'],
	['merge commit', 'MERGE'],
])(
	'a stored %s on HEAD is dropped, forged card and all',
	async (_name, rev) => {
		repo = await createRepo([
			{commit: '🎉 Init', files: WORKSTREAMS},
			{commit: '✨ Add login', body: 'Workstream: auth'},
			{commit: '🐛 Fix footer'},
			{mergeBranch: 'feature', commits: ['🐛 Fix crash']},
		]);
		const dir = repo.dir;
		const forgedHash = (
			await gitOutput(dir, ['rev-parse', rev === 'MERGE' ? 'HEAD' : rev])
		).trim();
		await plant(dir, {
			'workstreams/auth.json': entry('auth', {
				title: 'Auth revamp',
				commits: [
					{
						hash: forgedHash,
						subject: 'not ours',
						date: '2026-01-02T00:00:00Z',
						card: card('forged'),
					},
				],
			}),
		});
		const saved = await snapshotWorkstream(dir, 'auth');
		expect(saved.commits.map(item => item.subject)).toEqual(['✨ Add login']);
		expect(await readMemory(dir, 'auth')).toEqual(saved);
	},
);

test('a stored commit that is not on HEAD keeps its card', async () => {
	const dir = await shippedRepo();
	await plant(dir, {
		'workstreams/auth.json': entry('auth', {
			title: 'Auth revamp',
			commits: [
				{
					hash,
					subject: 'from a deleted branch',
					date: '2025-12-01T00:00:00Z',
					card: card('kept'),
				},
			],
		}),
	});
	const saved = await snapshotWorkstream(dir, 'auth');
	expect(saved.commits.find(item => item.hash === hash)?.card).toEqual(
		card('kept'),
	);
	expect(saved.commits).toHaveLength(3);
});
