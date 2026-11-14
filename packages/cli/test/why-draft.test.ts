import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {readPendingWhy} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {draftFrom} from '../src/why-draft.js';

const repos: FixtureRepo[] = [];
afterEach(async () => {
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
});

/** A file as another tool or an older version could have left it. */
async function plant(why: unknown, source: unknown) {
	const repo = await createRepo([{commit: '🎉 Init'}]);
	repos.push(repo);
	const gitDir = (
		await gitOutput(repo.dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	const head = (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim();
	await mkdir(path.join(gitDir, 'chamoji'), {recursive: true});
	await writeFile(
		path.join(gitDir, 'chamoji', 'pending-why.json'),
		JSON.stringify({why, source, head, at: new Date().toISOString()}),
	);
	return draftFrom(await readPendingWhy(repo.dir));
}

test('a thin stored reason is not offered', async () => {
	expect(await plant('fix bug', 'your Claude Code session')).toBeUndefined();
});

test('control characters are removed from the reason and the source', async () => {
	const draft = await plant(
		'the provider returns \u001B[31m422 for stays over 365 nights',
		'your \u001B[31mCursor chat',
	);
	expect(draft).toEqual({
		text: 'the provider returns [31m422 for stays over 365 nights',
		source: 'your [31mCursor chat',
	});
});

test('a long source is capped and a long reason is dropped', async () => {
	const draft = await plant(
		'the provider returns 422 for stays over 365 nights',
		'x'.repeat(200),
	);
	expect(draft?.source).toHaveLength(60);
	expect(
		await plant('the provider returns 422 for stays. '.repeat(20), 'a'),
	).toBeUndefined();
});
