import {afterEach, expect, test} from 'vitest';
import {listReleaseTags, readCommits, toWebUrl} from '../src/git.js';
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

test('toWebUrl handles common remote formats', () => {
	expect(toWebUrl('git@github.com:owner/repo.git')).toBe(
		'https://github.com/owner/repo',
	);
	expect(toWebUrl('ssh://git@gitlab.com/group/repo.git')).toBe(
		'https://gitlab.com/group/repo',
	);
	expect(toWebUrl('https://github.com/owner/repo.git')).toBe(
		'https://github.com/owner/repo',
	);
	expect(toWebUrl('https://user:token@github.com/owner/repo')).toBe(
		'https://github.com/owner/repo',
	);
	expect(toWebUrl('/local/path/repo')).toBeUndefined();
});

test('readCommits returns body and trailers and skips merges', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add login',
			body: 'Explains why.\n\nWorkstream: auth\nRefs: #4',
		},
		{mergeBranch: 'feature', commits: ['🐛 Fix crash']},
	]);

	const commits = await readCommits(repo.dir, 'HEAD');
	expect(commits.map(c => c.subject)).toEqual(['🐛 Fix crash', '✨ Add login']);
	expect(commits[1]).toMatchObject({
		authorName: 'Fixture Bot',
		trailers: 'Workstream: auth\nRefs: #4\n',
	});
	expect(commits[1]!.body).toContain('Explains why.');
	expect(commits[1]!.hash).toMatch(/^[\da-f]{40}$/);
});

test('listReleaseTags keeps semver tags sorted newest first', async () => {
	repo = await createRepo([
		{commit: '🎉 Init'},
		{tag: 'v1.0.0-rc.1'},
		{commit: '✨ Add'},
		{tag: 'v1.0.0', annotated: true},
		{tag: 'not-a-version'},
	]);

	const tags = await listReleaseTags(repo.dir, 'HEAD');
	expect(tags.map(tag => tag.name)).toEqual(['v1.0.0', 'v1.0.0-rc.1']);
	expect(tags[0]!.date).toMatch(/^2026-01-02/);
});

test('a branch with the same name as a tag does not hide the tag', async () => {
	repo = await createRepo([{commit: '✨ Add'}, {tag: 'v1.0.0'}]);
	await gitOutput(repo.dir, ['branch', 'v1.0.0']);

	const tags = await listReleaseTags(repo.dir, 'HEAD');
	expect(tags.map(tag => tag.name)).toEqual(['v1.0.0']);
});

test('readCommits does not treat the range as an option', async () => {
	repo = await createRepo([{commit: '✨ Add'}]);
	await expect(readCommits(repo.dir, '--all')).rejects.toThrow();
});
