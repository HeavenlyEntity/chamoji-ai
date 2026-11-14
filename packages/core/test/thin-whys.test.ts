import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {afterEach, expect, test} from 'vitest';
import {OutsideRepoError, listThinWhys} from '../src/thin-whys.js';
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

test('the first commit counts', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix it', body: 'Why: fix bug', files: {'a.ts': '1\n2\n'}},
	]);
	const found = await listThinWhys(repo.dir);
	expect(found.map(({lines, kind}) => [lines, kind])).toEqual([[2, 'thin']]);
});

test('lines split across blame groups add up', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix x', body: 'Why: fix bug', files: {'a.ts': 'x1\nx2\nx3\n'}},
		{commit: '✨ Add y', files: {'a.ts': 'x1\ny\nx3\n'}},
	]);
	const found = await listThinWhys(repo.dir);
	expect(found.map(({subject, lines}) => [subject, lines])).toEqual([
		['🐛 Fix x', 2],
		['✨ Add y', 1],
	]);
});

test('a path outside the repository throws a typed error', async () => {
	repo = await fixture();
	await expect(listThinWhys(repo.dir, '../outside')).rejects.toBeInstanceOf(
		OutsideRepoError,
	);
	await expect(listThinWhys(repo.dir, 'src/../..')).rejects.toBeInstanceOf(
		OutsideRepoError,
	);
	expect(await listThinWhys(repo.dir, 'src/../src/c.ts')).toHaveLength(1);
});

test('an absolute path inside the repo lists normally; outside throws', async () => {
	repo = await fixture();
	const real = await realpath(repo.dir);
	const found = await listThinWhys(repo.dir, `${real}/src`);
	expect(found.map(item => item.kind)).toEqual(['thin', 'missing']);
	await expect(
		listThinWhys(repo.dir, `${repo.dir}/src/c.ts`),
	).resolves.toHaveLength(1);
	await expect(listThinWhys(repo.dir, '/etc')).rejects.toBeInstanceOf(
		OutsideRepoError,
	);
	await expect(
		listThinWhys(`${repo.dir}/src`, `${real}/src/b.ts`),
	).resolves.toHaveLength(1);
	await expect(
		listThinWhys(`${repo.dir}/src`, path.dirname(real)),
	).rejects.toBeInstanceOf(OutsideRepoError);
});
