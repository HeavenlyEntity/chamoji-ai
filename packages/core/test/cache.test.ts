import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {openJudgmentCache} from '../src/cache.js';
import {createRepo, type FixtureRepo} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const cacheFile = (dir: string) =>
	path.join(dir, '.git', 'chamoji', 'cache.json');

test('judgments survive a save and a fresh open', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const cache = await openJudgmentCache(repo.dir, 'jev-v1');
	expect(cache.get('abc')).toBeUndefined();
	cache.set('abc', {gitmoji: 'bug', confidence: 0.91});
	cache.set('def', {gitmoji: null, confidence: 0.4});
	expect(cache.get('abc')).toEqual({gitmoji: 'bug', confidence: 0.91});
	await cache.save();

	const again = await openJudgmentCache(repo.dir, 'jev-v1');
	expect(again.get('abc')).toEqual({gitmoji: 'bug', confidence: 0.91});
	expect(again.get('def')).toEqual({gitmoji: null, confidence: 0.4});
});

test('a cache from another model or question version opens empty', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const old = await openJudgmentCache(repo.dir, 'jev-v1');
	old.set('abc', {gitmoji: 'bug', confidence: 0.91});
	await old.save();
	const next = await openJudgmentCache(repo.dir, 'jev-v2');
	expect(next.get('abc')).toBeUndefined();
});

test('a corrupt file opens empty and is replaced on save', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await mkdir(path.dirname(cacheFile(repo.dir)), {recursive: true});
	await writeFile(cacheFile(repo.dir), '{nope');
	const cache = await openJudgmentCache(repo.dir, 'jev-v1');
	expect(cache.get('abc')).toBeUndefined();
	cache.set('abc', {gitmoji: 'sparkles', confidence: 0.8});
	await cache.save();
	expect(JSON.parse(await readFile(cacheFile(repo.dir), 'utf8'))).toEqual({
		version: 'jev-v1',
		judgments: {abc: {gitmoji: 'sparkles', confidence: 0.8}},
	});
});

test('saving without changes writes nothing', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const cache = await openJudgmentCache(repo.dir, 'jev-v1');
	await cache.save();
	await expect(readFile(cacheFile(repo.dir))).rejects.toThrow();
});
