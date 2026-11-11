import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {readBoundedText} from '../src/fs-read.js';

const made: string[] = [];
afterEach(async () => {
	for (const dir of made.splice(0))
		await rm(dir, {recursive: true, force: true});
});

test('readBoundedText reads a file within the limit and nothing else', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-fsread-'));
	made.push(dir);
	await writeFile(path.join(dir, 'a.txt'), 'hello');
	await mkdir(path.join(dir, 'folder'));
	await symlink(path.join(dir, 'a.txt'), path.join(dir, 'link.txt')).catch(
		() => {},
	);
	expect(await readBoundedText(path.join(dir, 'a.txt'), 5)).toBe('hello');
	expect(await readBoundedText(path.join(dir, 'a.txt'), 4)).toBeNull();
	expect(await readBoundedText(path.join(dir, 'folder'), 100)).toBeNull();
	expect(await readBoundedText(path.join(dir, 'missing.txt'), 100)).toBeNull();
	// A link is never followed (and a missing one reads as null too).
	expect(await readBoundedText(path.join(dir, 'link.txt'), 100)).toBeNull();
});
