import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {ReleaseError} from '../../src/release.js';
import {editMentions} from '../../src/units/mentions.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';

const repos: FixtureRepo[] = [];
afterEach(async () => {
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
});

async function repoWith(files: Record<string, string>) {
	const repo = await createRepo([{commit: '🎉 Start', files}]);
	repos.push(repo);
	return repo.dir;
}

const PIN = {
	pattern: 'HeavenlyEntity/chamoji-ai@v{version}',
	files: ['README.md'],
};

test('every older match moves to the new version', async () => {
	const dir = await repoWith({
		'README.md':
			'uses: HeavenlyEntity/chamoji-ai@v0.14.0\nuses: HeavenlyEntity/chamoji-ai@v0.14.0\nuses: HeavenlyEntity/chamoji-ai@v0.13.0\n',
	});
	const [change] = await editMentions(dir, [PIN], null, '0.16.0', []);
	expect(change).toEqual({
		file: 'README.md',
		text: 'uses: HeavenlyEntity/chamoji-ai@v0.16.0\n'.repeat(3),
		how: 'version mentions set to 0.16.0',
	});
});

test('an equal or newer mention is left alone', async () => {
	const dir = await repoWith({
		'README.md':
			'HeavenlyEntity/chamoji-ai@v0.17.0-rc.1 HeavenlyEntity/chamoji-ai@v0.16.0 HeavenlyEntity/chamoji-ai@vnext\n',
	});
	expect(await editMentions(dir, [PIN], null, '0.16.0', [])).toEqual([]);
});

test('text around the pattern is untouched', async () => {
	const dir = await repoWith({
		'README.md':
			'since 0.13.0, use HeavenlyEntity/chamoji-ai@v0.14.0 or 0.14.0.\n',
	});
	const [change] = await editMentions(dir, [PIN], null, '0.16.0', []);
	expect(change?.text).toBe(
		'since 0.13.0, use HeavenlyEntity/chamoji-ai@v0.16.0 or 0.14.0.\n',
	);
});

test('globs match tracked files only, with **', async () => {
	const dir = await repoWith({
		'docs/site/a.mdx': 'x@v1.0.0\n',
		'docs/site/deep/b.mdx': 'x@v1.0.0\n',
	});
	await mkdir(path.join(dir, 'docs/site/deep'), {recursive: true});
	await writeFile(path.join(dir, 'docs/site/deep/untracked.mdx'), 'x@v1.0.0\n');
	const changes = await editMentions(
		dir,
		[{pattern: 'x@v{version}', files: ['docs/site/**/*.mdx']}],
		null,
		'1.1.0',
		[],
	);
	expect(changes.map(change => change.file).sort()).toEqual([
		'docs/site/a.mdx',
		'docs/site/deep/b.mdx',
	]);
	expect(
		await readFile(path.join(dir, 'docs/site/deep/untracked.mdx'), 'utf8'),
	).toBe('x@v1.0.0\n');
});

test('a glob that matches no tracked file stops the release', async () => {
	const dir = await repoWith({'README.md': 'x\n'});
	const error = await editMentions(
		dir,
		[{pattern: 'x@v{version}', files: ['docs/missing/*.md']}],
		null,
		'1.0.0',
		[],
	).catch((error_: unknown) => error_);
	expect(error).toBeInstanceOf(ReleaseError);
	expect((error as ReleaseError).code).toBe('invalid-mention');
	expect((error as ReleaseError).message).toBe(
		'release.mentions: "docs/missing/*.md" matches no tracked file',
	);
});

test('a file that is also a version file gets one change with both edits', async () => {
	const dir = await repoWith({
		'README.md': 'version 0.14.0\nHeavenlyEntity/chamoji-ai@v0.14.0\n',
	});
	const pending = [
		{
			file: 'README.md',
			text: 'version 0.16.0\nHeavenlyEntity/chamoji-ai@v0.14.0\n',
			how: 'version 0.16.0',
		},
	];
	const changes = await editMentions(dir, [PIN], null, '0.16.0', pending);
	expect(changes).toEqual([
		{
			file: 'README.md',
			text: 'version 0.16.0\nHeavenlyEntity/chamoji-ai@v0.16.0\n',
			how: 'version 0.16.0',
		},
	]);
	expect(pending[0]?.text).toContain('@v0.14.0');
});

test('a mention for another unit is skipped', async () => {
	const dir = await repoWith({'README.md': 'x@v1.0.0\n', 'b.md': 'x@v1.0.0\n'});
	const mentions = [
		{pattern: 'x@v{version}', files: ['README.md'], unit: 'web'},
		{pattern: 'x@v{version}', files: ['b.md'], unit: 'api'},
	];
	const changes = await editMentions(dir, mentions, 'web', '2.0.0', []);
	expect(changes.map(change => change.file)).toEqual(['README.md']);
});
