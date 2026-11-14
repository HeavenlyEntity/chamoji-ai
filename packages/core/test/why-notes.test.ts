import {afterEach, expect, test} from 'vitest';
import {
	mergeCards,
	noteCard,
	noteText,
	readNoteCard,
	readNoteCards,
	writeNoteCard,
} from '../src/why-notes.js';
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

const empty = {why: [], constraint: [], gotcha: [], followUp: []};

async function head(dir: string) {
	return (await gitOutput(dir, ['rev-parse', 'HEAD'])).trim();
}

test('free text becomes a Why line, and card text is kept', () => {
	expect(noteText('see the incident doc')).toBe('Why: see the incident doc');
	expect(noteText('  one\ntwo\n\nthree ')).toBe('Why: one two');
	expect(noteText('Why: x\nConstraint: y')).toBe('Why: x\nConstraint: y');
	expect(noteCard('see the incident doc')?.why).toEqual([
		'see the incident doc',
	]);
});

test('mergeCards puts the added lines first', () => {
	expect(
		mergeCards(
			{...empty, why: ['added'], gotcha: ['g']},
			{...empty, why: ['own'], constraint: ['c']},
		),
	).toEqual({
		why: ['added', 'own'],
		constraint: ['c'],
		gotcha: ['g'],
		followUp: [],
	});
	expect(mergeCards(undefined, {...empty, why: ['own']})?.why).toEqual(['own']);
	expect(mergeCards(undefined, undefined)).toBeUndefined();
});

test('a repo with no notes ref has no note cards', async () => {
	repo = await createRepo([{commit: '✨ Add a'}]);
	expect(await readNoteCard(repo.dir, await head(repo.dir))).toBeUndefined();
	expect((await readNoteCards(repo.dir)).size).toBe(0);
});

test('a written reason reads back, and a second one replaces it', async () => {
	repo = await createRepo([{commit: '✨ Add a'}, {commit: '✨ Add b'}]);
	const hash = await head(repo.dir);
	await writeNoteCard(repo.dir, hash, 'the first reason');
	expect((await readNoteCard(repo.dir, hash))?.why).toEqual([
		'the first reason',
	]);
	await writeNoteCard(repo.dir, hash, 'the second reason');
	expect((await readNoteCard(repo.dir, hash))?.why).toEqual([
		'the second reason',
	]);
	const all = await readNoteCards(repo.dir);
	expect([...all.keys()]).toEqual([hash]);
	expect(all.get(hash)?.why).toEqual(['the second reason']);
});

test('a free-text note made with git itself reads as a Why', async () => {
	repo = await createRepo([{commit: '✨ Add a'}]);
	const hash = await head(repo.dir);
	await gitOutput(repo.dir, [
		'notes',
		'--ref=chamoji',
		'add',
		'-m',
		'no key here',
		hash,
	]);
	expect((await readNoteCard(repo.dir, hash))?.why).toEqual(['no key here']);
});

test('readNoteCards reads many notes, multi-line and non-ASCII ones included', async () => {
	repo = await createRepo([
		{commit: '✨ Add a'},
		{commit: '✨ Add b'},
		{commit: '✨ Add c'},
	]);
	const [c, b, a] = (
		await gitOutput(repo.dir, ['rev-list', '--max-count=3', 'HEAD'])
	)
		.trim()
		.split('\n') as [string, string, string];
	await writeNoteCard(
		repo.dir,
		a,
		'the vendor café API caps stays at 365 nights',
	);
	await writeNoteCard(repo.dir, b, 'Why: x is slow\nConstraint: no network');
	await writeNoteCard(
		repo.dir,
		c,
		'Why: first line\nwrapped onto a second\nGotcha: ünïcode ✨\nFollow-up: later',
	);
	const all = await readNoteCards(repo.dir);
	expect(all.size).toBe(3);
	expect(all.get(a)?.why).toEqual([
		'the vendor café API caps stays at 365 nights',
	]);
	expect(all.get(b)).toMatchObject({
		why: ['x is slow'],
		constraint: ['no network'],
	});
	expect(all.get(c)).toMatchObject({
		why: ['first line wrapped onto a second'],
		gotcha: ['ünïcode ✨'],
		followUp: ['later'],
	});
});
