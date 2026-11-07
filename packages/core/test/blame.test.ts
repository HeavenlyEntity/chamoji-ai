import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {blameLine, parseLocation, WhyError} from '../src/blame.js';
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

const THREE_LINES = 'one\ntwo\nthree\n';

test('finds the commit that wrote a line', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: because',
			files: {'src/a.ts': THREE_LINES},
		},
		{commit: '🐛 Touch b', files: {'src/b.ts': 'b\n'}},
	]);
	const result = await blameLine(repo.dir, 'src/a.ts', 2);
	expect(result.kind).toBe('commit');
	if (result.kind !== 'commit') return;
	expect(result.commit.subject).toBe('✨ Add a');
	expect(result.commit.card?.why).toEqual(['because']);
});

test('follows a line through a rename', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: because',
			files: {'src/a.ts': THREE_LINES},
		},
	]);
	await gitOutput(repo.dir, ['mv', 'src/a.ts', 'src/renamed.ts']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '♻️ Rename a']);
	const result = await blameLine(repo.dir, 'src/renamed.ts', 1);
	expect(result.kind).toBe('commit');
	if (result.kind !== 'commit') return;
	expect(result.commit.subject).toBe('✨ Add a');
});

test('reports an uncommitted line', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', files: {'src/a.ts': THREE_LINES}},
	]);
	await writeFile(path.join(repo.dir, 'src/a.ts'), `${THREE_LINES}four\n`);
	expect(await blameLine(repo.dir, 'src/a.ts', 4)).toEqual({
		kind: 'uncommitted',
	});
	expect((await blameLine(repo.dir, 'src/a.ts', 3)).kind).toBe('commit');
});

test('a line past the end throws WhyError', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', files: {'src/a.ts': THREE_LINES}},
	]);
	const failure = blameLine(repo.dir, 'src/a.ts', 9);
	await expect(failure).rejects.toThrow(WhyError);
	await expect(failure).rejects.toThrow('src/a.ts has 3 lines');
});

test('a missing file throws WhyError', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', files: {'src/a.ts': THREE_LINES}},
	]);
	const failure = blameLine(repo.dir, 'nope.ts', 1);
	await expect(failure).rejects.toThrow(WhyError);
	await expect(failure).rejects.toThrow('No such file in HEAD: nope.ts');
});

test('a file name starting with a dash is treated as a file', async () => {
	repo = await createRepo([
		{commit: '✨ Add dash', files: {'-f.ts': THREE_LINES}},
	]);
	const result = await blameLine(repo.dir, '-f.ts', 1);
	expect(result.kind).toBe('commit');
});

test('parseLocation splits at the last colon', () => {
	expect(parseLocation('a:b.ts:12')).toEqual({file: 'a:b.ts', line: 12});
	expect(parseLocation('src/a.ts:3')).toEqual({file: 'src/a.ts', line: 3});
});

test('parseLocation refuses a bad location', () => {
	for (const input of ['a.ts', 'a.ts:0', 'a.ts:x', 'a.ts:', ':3', 'a.ts:1.5']) {
		expect(() => parseLocation(input), input).toThrow(WhyError);
	}
});
