import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {displayVersion, installedVersion} from '../../src/publish/lockfile.js';

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true})));
});

async function withFiles(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-lock-'));
	dirs.push(dir);
	for (const [file, text] of Object.entries(files)) {
		// eslint-disable-next-line no-await-in-loop
		await mkdir(path.dirname(path.join(dir, file)), {recursive: true});
		// eslint-disable-next-line no-await-in-loop
		await writeFile(path.join(dir, file), text);
	}

	return dir;
}

test('pnpm-lock importers give the installed version', async () => {
	const dir = await withFiles({
		'pnpm-lock.yaml': [
			"lockfileVersion: '9.0'",
			'',
			'importers:',
			'  .: {}',
			'  apps/web:',
			'    dependencies:',
			'      next:',
			'        specifier: ^15.2.0',
			'        version: 15.2.3(react-dom@19.0.0(react@19.0.0))(react@19.0.0)',
			"      '@remix-run/react':",
			'        specifier: ^2.15.0',
			'        version: 2.15.2(react@19.0.0)',
			'  apps/other:',
			'    dependencies:',
			'      next:',
			'        specifier: ^14.0.0',
			'        version: 14.2.1',
			'',
		].join('\n'),
	});
	expect(await installedVersion(dir, 'apps/web', 'next')).toBe('15.2.3');
	expect(await installedVersion(dir, 'apps/web', '@remix-run/react')).toBe(
		'2.15.2',
	);
	expect(await installedVersion(dir, 'apps/other', 'next')).toBe('14.2.1');
	expect(await installedVersion(dir, 'apps/web', 'astro')).toBeNull();
});

test('package-lock packages give the installed version', async () => {
	const dir = await withFiles({
		'package-lock.json': JSON.stringify({
			lockfileVersion: 3,
			packages: {
				'': {name: 'root'},
				'node_modules/next': {version: '14.0.0'},
				'apps/web/node_modules/next': {version: '15.2.3'},
				'node_modules/astro': {version: '5.3.0'},
			},
		}),
	});
	expect(await installedVersion(dir, 'apps/web', 'next')).toBe('15.2.3');
	expect(await installedVersion(dir, 'apps/web', 'astro')).toBe('5.3.0');
	expect(await installedVersion(dir, '', 'next')).toBe('14.0.0');
});

test('no lockfile: null', async () => {
	const dir = await withFiles({'package.json': '{}'});
	expect(await installedVersion(dir, 'apps/web', 'next')).toBeNull();
});

test('displayVersion', () => {
	expect(displayVersion('15.2.3')).toBe('15.2');
	expect(displayVersion('52.0.11')).toBe('52');
	expect(displayVersion('^5.3.0')).toBe('5.3');
	expect(displayVersion('workspace:*')).toBeNull();
	expect(displayVersion(null)).toBeNull();
});
