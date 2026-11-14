import {afterEach, expect, test} from 'vitest';
import {readCommits} from '../src/git.js';
import {parseCommit} from '../src/parse.js';
import {findClues, prNumber} from '../src/why-clues.js';
import {createRepo, type FixtureRepo} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

test('prNumber reads a trailing (#n) or a merge subject', () => {
	expect(prNumber('🐛 Keep the session (#482)')).toBe(482);
	expect(prNumber('Merge pull request #21 from a/b')).toBe(21);
	expect(prNumber('Fix #3 later')).toBeUndefined();
});

const GOOD = (what: string) =>
	`Why: ${what} leaked sessions after the tab closed, so logins stayed open`;

test('findClues keeps explained commits from the last 14 days', async () => {
	repo = await createRepo([
		{
			commit: '✨ Old',
			body: GOOD('the old form'),
			date: '2026-01-01T00:00:00Z',
			files: {'src/a.ts': 'one\n'},
		},
		{
			commit: '🐛 Thin',
			body: 'Why: fix bug',
			date: '2026-01-15T00:00:00Z',
			files: {'src/a.ts': 'two\n'},
		},
		{
			commit: '🐛 Good',
			body: GOOD('the cookie form'),
			date: '2026-01-16T00:00:00Z',
			files: {'src/a.ts': 'three\n'},
		},
		{
			commit: '🐛 Target (#9)',
			body: 'Why: fix bug',
			date: '2026-01-21T00:00:00Z',
			files: {'src/a.ts': 'four\n'},
		},
	]);
	const [target] = (await readCommits(repo.dir, 'HEAD')).map(parseCommit);
	const clues = await findClues(repo.dir, target!, 'src/a.ts');
	expect(clues.pr).toBe(9);
	expect(clues.nearby.map(item => item.subject)).toEqual(['🐛 Good']);
});

test('the root commit has no nearby commits', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Why: fix bug', files: {'src/a.ts': 'one\n'}},
	]);
	const [root] = (await readCommits(repo.dir, 'HEAD')).map(parseCommit);
	expect(await findClues(repo.dir, root!, 'src/a.ts')).toEqual({nearby: []});
});
