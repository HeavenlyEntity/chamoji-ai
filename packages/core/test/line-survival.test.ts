import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {readSurvival} from '../src/line-survival.js';
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

const rev = async (dir: string, ref: string) =>
	(await gitOutput(dir, ['rev-parse', ref])).trim();

async function cachePath(dir: string): Promise<string> {
	const gitDir = (await gitOutput(dir, ['rev-parse', '--absolute-git-dir']))
		.trim()
		.replaceAll('\\', '/');
	return path.join(gitDir, 'chamoji', 'blame-cache.json');
}

test('a commit whose lines are still there survives', async () => {
	repo = await createRepo([
		{commit: 'add', files: {'a.txt': 'one\ntwo\n'}},
		{commit: 'more', files: {'a.txt': 'one\ntwo\nthree\n'}},
	]);
	const first = await rev(repo.dir, 'HEAD~1');
	const result = await readSurvival(repo.dir, [first]);
	expect(result.get(first)).toEqual({survives: true, files: ['a.txt']});
});

test('a commit whose file was rewritten in full does not survive', async () => {
	repo = await createRepo([
		{commit: 'add', files: {'a.txt': 'one\ntwo\n'}},
		{commit: 'rewrite', files: {'a.txt': 'red\nblue\n'}},
	]);
	const first = await rev(repo.dir, 'HEAD~1');
	const second = await rev(repo.dir, 'HEAD');
	const result = await readSurvival(repo.dir, [first, second]);
	expect(result.get(first)).toEqual({survives: false, files: ['a.txt']});
	expect(result.get(second)?.survives).toBe(true);
});

test('a commit whose file was deleted does not survive', async () => {
	repo = await createRepo([
		{commit: 'add', files: {'a.txt': 'one\n', 'b.txt': 'keep\n'}},
	]);
	const first = await rev(repo.dir, 'HEAD');
	await gitOutput(repo.dir, ['rm', '-q', 'a.txt']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', 'drop a']);
	const result = await readSurvival(repo.dir, [first]);
	// b.txt still holds a line of that commit, so look at a file-only commit too.
	expect(result.get(first)?.files.sort()).toEqual(['a.txt', 'b.txt']);
	expect(result.get(first)?.survives).toBe(true);

	await gitOutput(repo.dir, ['rm', '-q', 'b.txt']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', 'drop b']);
	const after = await readSurvival(repo.dir, [first]);
	expect(after.get(first)).toMatchObject({survives: false});
});

test('a commit that only deleted lines has survives undefined and no files', async () => {
	repo = await createRepo([
		{commit: 'add', files: {'a.txt': 'one\ntwo\n'}},
		{commit: 'trim', files: {'a.txt': 'one\n'}},
	]);
	const second = await rev(repo.dir, 'HEAD');
	const result = await readSurvival(repo.dir, [second]);
	expect(result.get(second)).toEqual({survives: undefined, files: []});
});

test('a hash git cannot show has survives undefined and no files', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.txt': 'one\n'}}]);
	const missing = 'f'.repeat(40);
	const result = await readSurvival(repo.dir, [missing]);
	expect(result.get(missing)).toEqual({survives: undefined, files: []});
});

test('a whitespace-only rewrite does not take a line away from its commit', async () => {
	repo = await createRepo([
		{commit: 'add', files: {'a.txt': 'one\ntwo\n'}},
		{commit: 'indent', files: {'a.txt': '  one\n  two\n'}},
	]);
	const first = await rev(repo.dir, 'HEAD~1');
	const result = await readSurvival(repo.dir, [first]);
	expect(result.get(first)?.survives).toBe(true);
});

test('an empty list returns an empty map and blames nothing', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.txt': 'one\n'}}]);
	const blamed: string[] = [];
	const result = await readSurvival(repo.dir, [], {
		onBlame: file => blamed.push(file),
	});
	expect(result.size).toBe(0);
	expect(blamed).toEqual([]);
});

test('an unchanged file is not blamed again', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.txt': 'one\n'}}]);
	const hash = await rev(repo.dir, 'HEAD');
	const first: string[] = [];
	await readSurvival(repo.dir, [hash], {onBlame: f => first.push(f)});
	expect(first).toEqual(['a.txt']);
	const blamed: string[] = [];
	const result = await readSurvival(repo.dir, [hash], {
		onBlame: f => blamed.push(f),
	});
	expect(blamed).toEqual([]);
	expect(result.get(hash)?.survives).toBe(true);
});

test('a changed file is blamed again and its old entry is dropped', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.txt': 'one\n'}}]);
	const hash = await rev(repo.dir, 'HEAD');
	await readSurvival(repo.dir, [hash]);
	await writeFile(path.join(repo.dir, 'a.txt'), 'two\n');
	await gitOutput(repo.dir, ['commit', '-q', '-a', '-m', 'change']);
	const blamed: string[] = [];
	const result = await readSurvival(repo.dir, [hash], {
		onBlame: f => blamed.push(f),
	});
	expect(blamed).toEqual(['a.txt']);
	expect(result.get(hash)?.survives).toBe(false);
	const cache = JSON.parse(await readFile(await cachePath(repo.dir), 'utf8'));
	expect(Object.keys(cache.files)).toHaveLength(1);
});

test('a damaged cache file is ignored and rebuilt', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.txt': 'one\n'}}]);
	const hash = await rev(repo.dir, 'HEAD');
	await readSurvival(repo.dir, [hash]);
	const file = await cachePath(repo.dir);

	for (const damage of [
		'{not json',
		JSON.stringify({version: 99, files: {}}),
		JSON.stringify({version: 1, files: {x: 'nope'}}),
		JSON.stringify({version: 1, files: {x: [1]}}),
		'null',
	]) {
		await writeFile(file, damage);
		const blamed: string[] = [];
		const result = await readSurvival(repo.dir, [hash], {
			onBlame: f => blamed.push(f),
		});
		expect(blamed).toEqual(['a.txt']);
		expect(result.get(hash)?.survives).toBe(true);
		const rebuilt = JSON.parse(await readFile(file, 'utf8'));
		expect(rebuilt.version).toBe(1);
	}
});

test('a cache that cannot be written still gives the answer', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.txt': 'one\n'}}]);
	const hash = await rev(repo.dir, 'HEAD');
	const file = await cachePath(repo.dir);
	// A file where the folder should be makes the write fail.
	await writeFile(path.dirname(file), 'in the way');
	const result = await readSurvival(repo.dir, [hash]);
	expect(result.get(hash)?.survives).toBe(true);
});

test('a path with spaces and a leading dash is blamed correctly', async () => {
	repo = await createRepo([
		{commit: 'add', files: {'-my "odd" file.txt': 'one\n'}},
		{commit: 'other', files: {'b.txt': 'x\n'}},
	]);
	const first = await rev(repo.dir, 'HEAD~1');
	const blamed: string[] = [];
	const result = await readSurvival(repo.dir, [first], {
		onBlame: f => blamed.push(f),
	});
	expect(result.get(first)).toEqual({
		survives: true,
		files: ['-my "odd" file.txt'],
	});
	expect(blamed).toEqual(['-my "odd" file.txt']);
});

test('a binary file does not count as lines added', async () => {
	repo = await createRepo([{commit: 'add', files: {'a.bin': 'x\0y\0z\n'}}]);
	const hash = await rev(repo.dir, 'HEAD');
	const result = await readSurvival(repo.dir, [hash]);
	expect(result.get(hash)).toEqual({survives: undefined, files: []});
});
