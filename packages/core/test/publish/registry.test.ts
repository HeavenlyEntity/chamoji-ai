import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {registryFor, type WorkspacePackage} from '../../src/index.js';

let dir: string | undefined;

afterEach(async () => {
	if (dir) await rm(dir, {recursive: true, force: true});
	dir = undefined;
});

const pkg = (name: string): WorkspacePackage => ({
	name,
	path: 'packages/x',
	version: '1.0.0',
	private: false,
	runtimeDeps: [],
	ranges: {},
});

async function setup(
	manifest: Record<string, unknown>,
	npmrc?: string,
): Promise<string> {
	dir = await mkdtemp(path.join(os.tmpdir(), 'chamoji-registry-'));
	await mkdir(path.join(dir, 'packages/x'), {recursive: true});
	await writeFile(
		path.join(dir, 'packages/x/package.json'),
		JSON.stringify({name: 'x', ...manifest}),
	);
	if (npmrc !== undefined) await writeFile(path.join(dir, '.npmrc'), npmrc);
	return dir;
}

test('registryFor prefers publishConfig, then the scope in .npmrc', async () => {
	const npmrc = [
		'# a comment',
		'; another',
		'//npm.acme.dev/:_authToken=secret',
		'@acme:registry=https://npm.acme.dev/',
		'@other:registry=https://npm.other.dev',
	].join('\n');

	const both = await setup(
		{publishConfig: {registry: 'https://pub.example.com'}},
		npmrc,
	);
	expect(await registryFor(both, pkg('@acme/x'))).toBe(
		'https://pub.example.com/',
	);

	const scoped = await setup({}, npmrc);
	expect(await registryFor(scoped, pkg('@acme/x'))).toBe(
		'https://npm.acme.dev/',
	);
	expect(await registryFor(scoped, pkg('@other/x'))).toBe(
		'https://npm.other.dev/',
	);
	expect(await registryFor(scoped, pkg('@nope/x'))).toBe(
		'https://registry.npmjs.org/',
	);
	expect(await registryFor(scoped, pkg('plain'))).toBe(
		'https://registry.npmjs.org/',
	);
});

test('registryFor defaults to npmjs with no .npmrc', async () => {
	const root = await setup({});
	expect(await registryFor(root, pkg('@acme/x'))).toBe(
		'https://registry.npmjs.org/',
	);
});
