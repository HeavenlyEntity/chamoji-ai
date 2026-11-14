import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	PENDING_WHY_MAX_AGE_MS,
	clearPendingWhy,
	readPendingWhy,
	writePendingWhy,
} from '../src/pending-why.js';
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

const INPUT = {
	why: 'the provider returns 422 for stays over 365 nights',
	source: 'your Claude Code session',
};

test('a kept reason reads back', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writePendingWhy(repo.dir, INPUT);
	const pending = await readPendingWhy(repo.dir);
	expect(pending).toMatchObject(INPUT);
	expect(pending?.head).toBe(
		(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim(),
	);
});

test('a new commit makes it stale', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writePendingWhy(repo.dir, INPUT);
	await gitOutput(repo.dir, ['commit', '--allow-empty', '-m', 'next']);
	expect(await readPendingWhy(repo.dir)).toBeUndefined();
});

test('a reason from yesterday is not offered', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const now = new Date();
	await writePendingWhy(repo.dir, INPUT, now);
	const later = new Date(now.getTime() + PENDING_WHY_MAX_AGE_MS + 60_000);
	expect(await readPendingWhy(repo.dir, later)).toBeUndefined();
	expect(await readPendingWhy(repo.dir, now)).toBeDefined();
});

test('a damaged file reads as nothing', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const gitDir = (
		await gitOutput(repo.dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	await mkdir(path.join(gitDir, 'chamoji'), {recursive: true});
	await writeFile(path.join(gitDir, 'chamoji', 'pending-why.json'), '{nope');
	expect(await readPendingWhy(repo.dir)).toBeUndefined();
	await writeFile(path.join(gitDir, 'chamoji', 'pending-why.json'), '[1]');
	expect(await readPendingWhy(repo.dir)).toBeUndefined();
});

test('clearing removes it, and clearing nothing is fine', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writePendingWhy(repo.dir, INPUT);
	await clearPendingWhy(repo.dir);
	expect(await readPendingWhy(repo.dir)).toBeUndefined();
	await expect(clearPendingWhy(repo.dir)).resolves.toBeUndefined();
});
