import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {reindexMemory, searchMemory} from '../src/memory-index.js';
import {writeNoteCard} from '../src/why-notes.js';
import {archiveMemory, purgeMemory, snapshotWorkstream} from '../src/memory.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    status: shipped',
		'',
	].join('\n'),
};

async function indexFile(dir: string): Promise<string> {
	const gitDir = (await gitOutput(dir, ['rev-parse', '--absolute-git-dir']))
		.trim()
		.replaceAll('\\', '/');
	return path.join(gitDir, 'chamoji', 'memory-index.json');
}

test('search finds a Why: line that is not in the subject', async () => {
	repo = await createRepo([
		{commit: '✨ Add login'},
		{
			commit: '🐛 Fix sessions',
			body: 'Why: the old form leaked tokens into referrer headers',
		},
		{commit: '📝 Tidy readme'},
	]);
	const hits = await searchMemory(repo.dir, 'referrer leaked');
	expect(hits.map(hit => hit.title)).toEqual(['🐛 Fix sessions']);
	expect(hits[0]).toMatchObject({
		kind: 'commit',
		card: {why: ['the old form leaked tokens into referrer headers']},
	});
	expect(hits[0]!.id).toMatch(/^[0-9a-f]{40}$/);
	expect(hits[0]!.score).toBeGreaterThan(0);
});

test('search finds a word from the body', async () => {
	repo = await createRepo([
		{commit: '✨ Add login', body: 'Uses a throttle on the endpoint.'},
		{commit: '📝 Tidy readme'},
	]);
	expect(
		(await searchMemory(repo.dir, 'throttle')).map(hit => hit.title),
	).toEqual(['✨ Add login']);
});

test('a card match outranks a body match', async () => {
	repo = await createRepo([
		{commit: '✨ Add cache', body: 'The retry queue is untouched.'},
		{commit: '✨ Add queue', body: 'Why: retry queue keeps jobs'},
		{commit: '✨ Add log', body: 'A retry queue shows up here, too.'},
	]);
	const hits = await searchMemory(repo.dir, 'retry queue');
	expect(hits[0]!.title).toBe('✨ Add queue');
	expect(hits).toHaveLength(3);
});

test('a subject match outranks a body match', async () => {
	repo = await createRepo([
		{commit: '✨ Add log', body: 'The pagination is described elsewhere.'},
		{commit: '✨ Add pagination'},
	]);
	expect((await searchMemory(repo.dir, 'pagination'))[0]!.title).toBe(
		'✨ Add pagination',
	);
});

// BM25 marks long documents down, so the thin commit's body is long enough
// that only its card weight, not its length, decides the order.
test('a thin Why ranks below a specific one and is labeled', async () => {
	repo = await createRepo([
		{
			commit: '🐛 Fix a crash',
			body: 'Why: fix upload\n\nTouches the client wrapper, the shared helper and the docs for the sdk package.',
		},
		{
			commit: '🐛 Stop the retry storm',
			body: 'Why: the upload endpoint returns 429 when we retry an upload within 1 s, so wait 2 s',
		},
	]);
	const hits = await searchMemory(repo.dir, 'upload');
	expect(hits.map(hit => hit.title)).toEqual([
		'🐛 Stop the retry storm',
		'🐛 Fix a crash',
	]);
	expect(hits.map(hit => hit.whyQuality)).toEqual(['ok', 'thin']);
});

test('a commit with no card has no whyQuality', async () => {
	repo = await createRepo([
		{commit: '✨ Add login', body: 'Uses a throttle on the endpoint.'},
	]);
	const [hit] = await searchMemory(repo.dir, 'throttle');
	expect(hit).toBeDefined();
	expect(hit).not.toHaveProperty('whyQuality');
});

test('an index file from an older version is rebuilt', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	await searchMemory(repo.dir, 'login');
	const file = await indexFile(repo.dir);
	const saved = JSON.parse(await readFile(file, 'utf8'));
	await writeFile(file, JSON.stringify({...saved, version: 1}));
	await searchMemory(repo.dir, 'login');
	expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(3);
});

test('search finds a workstream summary whose branch is gone', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: sessions never expired\nWorkstream: auth',
		},
		{commit: '🐛 Fix footer'},
		{commit: '🐛 Fix login', body: 'Workstream: auth'},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	await gitOutput(repo.dir, ['reset', '-q', '--hard', 'HEAD~3']);
	const hits = await searchMemory(repo.dir, 'sessions expired');
	expect(hits).toHaveLength(1);
	expect(hits[0]).toMatchObject({
		kind: 'workstream',
		id: 'auth',
		title: 'Auth revamp',
		card: {why: ['sessions never expired']},
	});
	expect((await searchMemory(repo.dir, 'auth revamp'))[0]?.id).toBe('auth');
});

test('an archived workstream is not searched', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{commit: '✨ Add login', body: 'Workstream: auth'},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	await archiveMemory(repo.dir, 'auth');
	expect(await searchMemory(repo.dir, 'revamp')).toEqual([]);
});

test('a new commit rebuilds the index on the next search', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	expect(await searchMemory(repo.dir, 'pagination')).toEqual([]);
	await gitOutput(repo.dir, [
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'✨ Add pagination',
	]);
	expect(
		(await searchMemory(repo.dir, 'pagination')).map(hit => hit.title),
	).toEqual(['✨ Add pagination']);
});

test('a new memory entry rebuilds the index on the next search', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{commit: '✨ Add login', body: 'Workstream: auth'},
	]);
	expect(await searchMemory(repo.dir, 'revamp')).toEqual([]);
	await snapshotWorkstream(repo.dir, 'auth');
	expect((await searchMemory(repo.dir, 'revamp')).map(hit => hit.id)).toEqual([
		'auth',
	]);
});

test('an index built for the current state is read, not built again', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	await searchMemory(repo.dir, 'login');
	const file = await indexFile(repo.dir);
	const saved = JSON.parse(await readFile(file, 'utf8'));
	saved.documents[0].title = 'edited in place';
	await writeFile(file, JSON.stringify(saved));
	expect((await searchMemory(repo.dir, 'login'))[0]!.title).toBe(
		'edited in place',
	);
});

test('a corrupt index file is rebuilt, not fatal', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	await searchMemory(repo.dir, 'login');
	const file = await indexFile(repo.dir);
	const good = await readFile(file, 'utf8');
	const saved = JSON.parse(good);
	const damaged: unknown[] = [
		'{not json',
		'',
		'null',
		'[]',
		JSON.stringify({...saved, version: 'x'}),
		JSON.stringify({...saved, documents: 'no'}),
		JSON.stringify({...saved, documents: []}),
		JSON.stringify({...saved, documents: [{kind: 'commit', id: 'x'}]}),
		JSON.stringify({...saved, index: null}),
		JSON.stringify({...saved, index: {...saved.index, ids: [1]}}),
		JSON.stringify({
			...saved,
			index: {...saved.index, postings: [['login', [99, 1]]]},
		}),
		JSON.stringify({
			...saved,
			index: {...saved.index, postings: [['login', [0, 'a']]]},
		}),
		JSON.stringify({
			...saved,
			documents: [{...saved.documents[0], card: {why: 'no'}}],
		}),
	];
	for (const text of damaged as string[]) {
		await writeFile(file, text);
		const hits = await searchMemory(repo.dir, 'login');
		expect(hits.map(hit => hit.title)).toEqual(['✨ Add login']);
		expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(
			saved.version,
		);
	}
});

test('a missing index file is built', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	const file = await indexFile(repo.dir);
	await expect(readFile(file, 'utf8')).rejects.toThrow();
	expect(await searchMemory(repo.dir, 'login')).toHaveLength(1);
	expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
		version: expect.any(Number),
		head: expect.stringMatching(/^[0-9a-f]{40}$/),
	});
});

test('reindex rebuilds from scratch and counts the documents', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{commit: '✨ Add login', body: 'Workstream: auth'},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	expect(await reindexMemory(repo.dir)).toEqual({documents: 3});
	const file = await indexFile(repo.dir);
	await writeFile(file, 'garbage');
	expect(await reindexMemory(repo.dir)).toEqual({documents: 3});
	expect(JSON.parse(await readFile(file, 'utf8')).documents).toHaveLength(3);
});

test('a repository with no commits has nothing to search', async () => {
	repo = await createRepo([]);
	expect(await searchMemory(repo.dir, 'anything')).toEqual([]);
	expect(await reindexMemory(repo.dir)).toEqual({documents: 0});
});

test('words named like Object properties are searchable', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix constructor', body: 'Why: __proto__ leaked through merge'},
		{commit: '📝 Tidy readme'},
	]);
	for (const query of ['constructor', '__proto__', 'toString']) {
		const titles = (await searchMemory(repo.dir, query)).map(hit => hit.title);
		expect(titles).toEqual(query === 'toString' ? [] : ['🐛 Fix constructor']);
	}
});

test('the limit defaults to ten and can be set', async () => {
	repo = await createRepo(
		Array.from({length: 12}, (_, i) => ({commit: `✨ Add widget ${i}`})),
	);
	expect(await searchMemory(repo.dir, 'widget')).toHaveLength(10);
	expect(await searchMemory(repo.dir, 'widget', {limit: 3})).toHaveLength(3);
});

test('an empty query finds nothing', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	expect(await searchMemory(repo.dir, '')).toEqual([]);
	expect(await searchMemory(repo.dir, ' - ')).toEqual([]);
});

test('the index holds no author name or address', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	await searchMemory(repo.dir, 'login');
	const text = await readFile(await indexFile(repo.dir), 'utf8');
	expect(text).not.toContain('fixture@example.com');
	expect(text).not.toContain('Fixture Bot');
});

test('a read-only index location does not stop a search', async () => {
	repo = await createRepo([{commit: '✨ Add login'}]);
	const gitDir = (
		await gitOutput(repo.dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	// A file where the folder should be: the index can't be written.
	await writeFile(path.join(gitDir, 'chamoji'), 'in the way');
	expect(await searchMemory(repo.dir, 'login')).toHaveLength(1);
	await expect(reindexMemory(repo.dir)).rejects.toThrow();
});

test('purge deletes this worktree index, and another worktree rebuilds its own', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{commit: '✨ Add login', body: 'Workstream: auth'},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	const other = `${repo.dir}-other`;
	await gitOutput(repo.dir, ['worktree', 'add', '-q', '-b', 'other', other]);
	try {
		// The workstream title is only in memory, so it shows where entry text is.
		for (const dir of [repo.dir, other]) {
			expect(await searchMemory(dir, 'revamp')).toHaveLength(1);
			expect(await readFile(await indexFile(dir), 'utf8')).toContain(
				'Auth revamp',
			);
		}

		await purgeMemory(repo.dir, 'auth');

		await expect(readFile(await indexFile(repo.dir), 'utf8')).rejects.toThrow();
		// The other worktree's file waits for its next search, which sees that
		// the memory ref moved and rebuilds it.
		expect(await readFile(await indexFile(other), 'utf8')).toContain(
			'Auth revamp',
		);
		expect(await searchMemory(other, 'revamp')).toEqual([]);
		expect(await readFile(await indexFile(other), 'utf8')).not.toContain(
			'Auth revamp',
		);
		expect(await searchMemory(repo.dir, 'revamp')).toEqual([]);
		expect(await readFile(await indexFile(repo.dir), 'utf8')).not.toContain(
			'Auth revamp',
		);
	} finally {
		await gitOutput(repo.dir, ['worktree', 'remove', '--force', other]);
	}
});

test('an added reason is found by the next search with no reindex', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug'},
		{commit: '📝 Tidy readme'},
	]);
	expect(await searchMemory(repo.dir, '365')).toEqual([]);
	const hash = (await gitOutput(repo.dir, ['rev-parse', 'HEAD~1'])).trim();
	await writeNoteCard(
		repo.dir,
		hash,
		'the provider returns 422 for stays over 365 nights',
	);
	const hits = await searchMemory(repo.dir, '365');
	expect(hits.map(hit => hit.id)).toEqual([hash]);
	expect(hits[0]).toMatchObject({whyQuality: 'ok'});
	expect(hits[0]!.card?.why).toEqual([
		'the provider returns 422 for stays over 365 nights',
		'fix bug',
	]);
});
