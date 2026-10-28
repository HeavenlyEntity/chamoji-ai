import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {readTypesafeKey} from '../src/env.js';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-env-'));
});

afterEach(async () => {
	await rm(dir, {recursive: true, force: true});
});

test('the environment variable wins over files', async () => {
	await writeFile(path.join(dir, '.env.local'), 'TYPESAFE_API_KEY=from-file\n');
	expect(await readTypesafeKey(dir, {TYPESAFE_API_KEY: 'from-env'})).toBe(
		'from-env',
	);
});

test('.env.local wins over .env', async () => {
	await writeFile(path.join(dir, '.env'), 'TYPESAFE_API_KEY=from-env-file\n');
	await writeFile(
		path.join(dir, '.env.local'),
		'TYPESAFE_API_KEY=from-local\n',
	);
	expect(await readTypesafeKey(dir, {})).toBe('from-local');
});

test('falls back to .env', async () => {
	await writeFile(path.join(dir, '.env'), 'TYPESAFE_API_KEY=from-env-file\n');
	expect(await readTypesafeKey(dir, {})).toBe('from-env-file');
});

test('quoted values and CRLF line endings are handled', async () => {
	await writeFile(
		path.join(dir, '.env.local'),
		'OTHER=1\r\nTYPESAFE_API_KEY="quoted-key"\r\n',
	);
	expect(await readTypesafeKey(dir, {})).toBe('quoted-key');
});

test('other variables are never loaded into the environment', async () => {
	await writeFile(
		path.join(dir, '.env.local'),
		'GITHUB_TOKEN=secret\nTYPESAFE_API_KEY=key\n',
	);
	const before = {...process.env};
	const env: NodeJS.ProcessEnv = {};
	expect(await readTypesafeKey(dir, env)).toBe('key');
	expect(env).toEqual({});
	expect(process.env).toEqual(before);
});

test('a file with only other variables gives undefined', async () => {
	await writeFile(path.join(dir, '.env.local'), 'GITHUB_TOKEN=secret\n');
	expect(await readTypesafeKey(dir, {})).toBeUndefined();
});

test('an empty value in .env.local falls through to .env', async () => {
	await writeFile(path.join(dir, '.env.local'), 'TYPESAFE_API_KEY=  \n');
	await writeFile(path.join(dir, '.env'), 'TYPESAFE_API_KEY=from-env-file\n');
	expect(await readTypesafeKey(dir, {})).toBe('from-env-file');
});

test('missing files and empty values give undefined', async () => {
	expect(await readTypesafeKey(dir, {})).toBeUndefined();
	await writeFile(path.join(dir, '.env.local'), 'TYPESAFE_API_KEY=\n');
	expect(await readTypesafeKey(dir, {TYPESAFE_API_KEY: '  '})).toBeUndefined();
});

test('untrackedOnly skips a .env that git tracks', async () => {
	const git = async (...args: string[]) =>
		new Promise<void>((resolve, reject) => {
			execFile('git', args, {cwd: dir}, error =>
				error ? reject(error) : resolve(),
			);
		});
	await git('init', '-q');
	await writeFile(path.join(dir, '.env'), 'TYPESAFE_API_KEY=someone-elses\n');
	await git('add', '.env');
	expect(await readTypesafeKey(dir, {})).toBe('someone-elses');
	expect(await readTypesafeKey(dir, {}, {untrackedOnly: true})).toBeUndefined();

	await writeFile(path.join(dir, '.env.local'), 'TYPESAFE_API_KEY=mine\n');
	expect(await readTypesafeKey(dir, {}, {untrackedOnly: true})).toBe('mine');
});
