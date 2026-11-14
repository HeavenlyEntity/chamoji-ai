import {afterEach, expect, test} from 'vitest';
import {listThinWhys} from '../src/thin-whys.js';
import {writeNoteCard} from '../src/why-notes.js';
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

async function fixture() {
	return createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: the provider returns 422 for stays over 365 nights',
			files: {'src/a.ts': 'a1\na2\n'},
		},
		{
			commit: '🐛 Fix b',
			body: 'Why: fix bug',
			files: {'src/b.ts': 'b1\nb2\nb3\nb4\nb5\n'},
		},
		{commit: '✨ Add c', files: {'src/c.ts': 'c1\n'}},
	]);
}

test('lists thin and missing Whys, most lines first', async () => {
	repo = await fixture();
	const found = await listThinWhys(repo.dir);
	expect(found.map(({subject, lines, kind}) => [subject, lines, kind])).toEqual(
		[
			['🐛 Fix b', 5, 'thin'],
			['✨ Add c', 1, 'missing'],
		],
	);
	expect(found[0]!.why).toBe('fix bug');
	expect(found[0]!.reasons.length).toBeGreaterThan(0);
	expect(found[1]).toMatchObject({why: '', reasons: []});
	expect(found[0]!.hash).toMatch(/^[0-9a-f]{40}/);
});

test('a path narrows the files read', async () => {
	repo = await fixture();
	const found = await listThinWhys(repo.dir, 'src/c.ts');
	expect(found.map(item => item.kind)).toEqual(['missing']);
});

test('an added reason takes a commit off the list', async () => {
	repo = await fixture();
	const [b] = await listThinWhys(repo.dir);
	await writeNoteCard(
		repo.dir,
		b!.hash,
		'the provider returns 422 for stays over 365 nights',
	);
	const found = await listThinWhys(repo.dir);
	expect(found.map(item => item.kind)).toEqual(['missing']);
});

test('the limit cuts the list', async () => {
	repo = await fixture();
	expect(await listThinWhys(repo.dir, '.', {limit: 1})).toHaveLength(1);
});

test('a path that looks like an option is a path', async () => {
	repo = await fixture();
	expect(await listThinWhys(repo.dir, '--output=x')).toEqual([]);
	expect(await gitOutput(repo.dir, ['status', '--porcelain'])).toBe('');
});
