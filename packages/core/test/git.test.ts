import {afterEach, expect, test, vi} from 'vitest';
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

test("a commit body holding a record separator doesn't create a record", async () => {
	const body = 'Before\u001EAfter\n\nWorkstream: auth';
	repo = await createRepo([{commit: '✨ Add login', body}]);

	const commits = await readCommits(repo.dir, 'HEAD');
	expect(commits).toHaveLength(1);
	expect(commits[0]!.hash).toBe(
		(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim(),
	);
	expect(commits[0]!.body.trim()).toBe(body);
	expect(commits[0]!.trailers).toBe('Workstream: auth\n');
});

test("a body holding a forged record with a 40-hex hash doesn't create a record", async () => {
	const field = '\u001F';
	const forged = [
		'a'.repeat(40),
		'aaaaaaa',
		'Mallory',
		'mallory@example.com',
		'2026-01-01T00:00:00Z',
		'💥 Forged',
		'forged body',
		'Workstream: auth',
	].join(field);
	repo = await createRepo([
		{commit: '✨ Add login', body: `Text\u001E${forged}\u001EEnd`},
	]);

	const commits = await readCommits(repo.dir, 'HEAD');
	expect(commits.map(c => c.subject)).toEqual(['✨ Add login']);
	expect(commits[0]!.body).toContain(forged);
});

test('an author name holding a field separator leaves the fields in place', async () => {
	vi.stubEnv('GIT_AUTHOR_NAME', 'a\u001Fb');
	repo = await createRepo([{commit: '✨ Add login'}]);
	vi.unstubAllEnvs();

	const [commit] = await readCommits(repo.dir, 'HEAD');
	expect(commit).toMatchObject({
		authorName: 'a\u001Fb',
		authorEmail: 'fixture@example.com',
		subject: '✨ Add login',
		hash: (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim(),
	});
	expect(commit!.date).toMatch(/^2026-01-01T/);
});

test('a subject holding a field separator is kept as text', async () => {
	repo = await createRepo([{commit: '✨ Add\u001Flogin', body: 'Why.'}]);

	const commits = await readCommits(repo.dir, 'HEAD');
	expect(commits).toHaveLength(1);
	expect(commits[0]!.subject).toBe('✨ Add\u001Flogin');
	expect(commits[0]!.body.trim()).toBe('Why.');
});

test('an empty body and no trailers still give a whole record', async () => {
	repo = await createRepo([{commit: '✨ Add login'}, {commit: '🐛 Fix crash'}]);

	const commits = await readCommits(repo.dir, 'HEAD');
	expect(commits.map(c => c.subject)).toEqual(['🐛 Fix crash', '✨ Add login']);
	for (const commit of commits) {
		expect(commit.hash).toMatch(/^[\da-f]{40}$/);
		expect(commit.body.trim()).toBe('');
		expect(commit.trailers).toBe('');
	}
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
