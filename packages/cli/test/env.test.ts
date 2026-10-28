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
	const env: NodeJS.ProcessEnv = {};
	await readTypesafeKey(dir, env);
	expect(env).toEqual({});
	expect(process.env['GITHUB_TOKEN']).not.toBe('secret');
});

test('missing files and empty values give undefined', async () => {
	expect(await readTypesafeKey(dir, {})).toBeUndefined();
	await writeFile(path.join(dir, '.env.local'), 'TYPESAFE_API_KEY=\n');
	expect(await readTypesafeKey(dir, {TYPESAFE_API_KEY: '  '})).toBeUndefined();
});
