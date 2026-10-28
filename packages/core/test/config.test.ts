import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {DEFAULT_GROUP_CONFIG, loadConfig} from '../src/config.js';
import {GITMOJIS} from '../src/gitmojis.js';

let dir: string | undefined;

afterEach(async () => {
	if (dir) {
		await rm(dir, {recursive: true, force: true});
	}

	dir = undefined;
});

test('every official gitmoji maps to exactly one group', () => {
	const seen = new Map<string, string[]>();
	for (const item of DEFAULT_GROUP_CONFIG) {
		for (const code of item.emojis) {
			seen.set(code, [...(seen.get(code) ?? []), item.group]);
		}
	}

	const unmapped = GITMOJIS.filter(gitmoji => !seen.has(gitmoji.code)).map(
		gitmoji => gitmoji.code,
	);
	const duplicated = [...seen].filter(([, groups]) => groups.length > 1);
	expect(unmapped).toEqual([]);
	expect(duplicated).toEqual([]);
});

test('legacy array config is accepted', async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-config-'));
	const file = path.join(dir, 'groups.json');
	await writeFile(
		file,
		JSON.stringify([{group: 'added', label: 'New', emojis: ['sparkles']}]),
	);

	const config = await loadConfig(dir, file);
	expect(config.groups).toEqual([
		{group: 'added', label: 'New', emojis: ['sparkles']},
	]);
});

test('object config merges over defaults', async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-config-'));
	await writeFile(
		path.join(dir, 'chamoji.config.json'),
		JSON.stringify({repositoryUrl: 'https://github.com/o/r'}),
	);

	const config = await loadConfig(dir);
	expect(config.repositoryUrl).toBe('https://github.com/o/r');
	expect(config.groups).toBe(DEFAULT_GROUP_CONFIG);
});

test('missing file gives defaults', async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-config-'));
	expect(await loadConfig(dir)).toEqual({groups: DEFAULT_GROUP_CONFIG});
});

test('invalid JSON names the file', async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-config-'));
	const file = path.join(dir, 'chamoji.config.json');
	await writeFile(file, '{nope');
	await expect(loadConfig(dir)).rejects.toThrow(`Invalid config ${file}`);
});

test('explicit missing file is an error', async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-config-'));
	await expect(loadConfig(dir, path.join(dir, 'nope.json'))).rejects.toThrow(
		'Config file not found',
	);
});

test('typo fixes are documentation, not bug fixes', () => {
	const documentation = DEFAULT_GROUP_CONFIG.find(
		group => group.group === 'documentation',
	);
	const fixed = DEFAULT_GROUP_CONFIG.find(group => group.group === 'fixed');
	expect(documentation?.emojis).toContain('pencil2');
	expect(fixed?.emojis).not.toContain('pencil2');
});

test('the ai block opts in to composer advice and diffs', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-ai-config-'));
	try {
		await writeFile(
			path.join(dir, 'chamoji.config.json'),
			'{"ai": {"composer": true}}',
		);
		expect((await loadConfig(dir)).ai).toEqual({
			composer: true,
			sendDiffs: false,
		});
		await writeFile(path.join(dir, 'chamoji.config.json'), '{}');
		expect((await loadConfig(dir)).ai).toBeUndefined();
		await writeFile(
			path.join(dir, 'chamoji.config.json'),
			'{"ai": {"composer": "yes"}}',
		);
		await expect(loadConfig(dir)).rejects.toThrow('ai must be');
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
