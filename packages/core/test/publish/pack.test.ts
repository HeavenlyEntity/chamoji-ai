import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	detectPackageManager,
	packArgs,
	packPackage,
	readTarball,
	spawnSpec,
	tarCommand,
	tarballProblems,
} from '../../src/index.js';

const has = (tool: string): boolean => {
	try {
		execFileSync(tool, ['--version'], {
			stdio: 'ignore',
			shell: process.platform === 'win32',
		});
		return true;
	} catch {
		return false;
	}
};

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(async dir => rm(dir, {recursive: true, force: true})),
	);
});

async function tmp(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'chamoji-pack-'));
	dirs.push(root);
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(root, file);
		await mkdir(path.dirname(target), {recursive: true});
		await writeFile(target, content);
	}

	return root;
}

describe('detectPackageManager', () => {
	it('detects pnpm from packageManager', async () => {
		const root = await tmp({
			'package.json': JSON.stringify({packageManager: 'pnpm@10.33.0+sha512.x'}),
			'yarn.lock': '',
		});
		expect(await detectPackageManager(root)).toBe('pnpm');
	});

	it('detects yarn from yarn.lock', async () => {
		const root = await tmp({'package.json': '{}', 'yarn.lock': ''});
		expect(await detectPackageManager(root)).toBe('yarn');
	});

	it('detects bun from bun.lock', async () => {
		const root = await tmp({'package.json': '{}', 'bun.lock': ''});
		expect(await detectPackageManager(root)).toBe('bun');
	});

	it('falls back to npm', async () => {
		const root = await tmp({'package.json': '{}'});
		expect(await detectPackageManager(root)).toBe('npm');
		expect(await detectPackageManager(path.join(root, 'missing'))).toBe('npm');
	});
});

describe('packArgs', () => {
	it('names each package manager pack command', () => {
		expect(packArgs('pnpm', '/o')).toEqual({
			command: 'pnpm',
			args: ['pack', '--pack-destination', '/o'],
		});
		expect(packArgs('npm', '/o').args).toEqual([
			'pack',
			'--pack-destination',
			'/o',
		]);
		expect(packArgs('bun', '/o')).toEqual({
			command: 'bun',
			args: ['pm', 'pack', '--destination', '/o'],
		});
		expect(packArgs('yarn', '/o').args).toEqual([
			'pack',
			'--out',
			path.join('/o', '%s-%v.tgz'),
		]);
	});
});

describe('packPackage', () => {
	it.skipIf(!has('npm'))(
		'runs the pack with the env it is given',
		async () => {
			const prepack = `node -e "require('fs').writeFileSync('seen.txt', process.env.CHAMOJI_PACK_MARKER || 'none')"`;
			const root = await tmp({
				'package.json': JSON.stringify({
					name: 'marked',
					version: '1.0.0',
					scripts: {prepack},
				}),
			});
			const pkg = {
				name: 'marked',
				path: '',
				version: '1.0.0',
				private: false,
				runtimeDeps: [],
				ranges: {},
			};
			const out = await tmp({});

			await packPackage(root, pkg, 'npm', out, {
				...process.env,
				CHAMOJI_PACK_MARKER: 'given',
			});
			expect(await readFile(path.join(root, 'seen.txt'), 'utf8')).toBe('given');

			await packPackage(root, pkg, 'npm', await tmp({}));
			expect(await readFile(path.join(root, 'seen.txt'), 'utf8')).toBe('none');
		},
		30_000,
	);

	it.skipIf(!has('pnpm'))('pnpm pack rewrites workspace ranges', async () => {
		const root = await tmp({
			'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
			'package.json': JSON.stringify({private: true}),
			'packages/a/package.json': JSON.stringify({name: 'a', version: '1.0.0'}),
			'packages/b/package.json': JSON.stringify({
				name: 'b',
				version: '2.0.0',
				dependencies: {a: 'workspace:^'},
			}),
		});
		// pnpm only rewrites `workspace:` once it has linked the workspace.
		execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], {
			cwd: root,
			stdio: 'ignore',
			shell: process.platform === 'win32',
		});
		const out = await tmp({});
		const tgz = await packPackage(
			root,
			{
				name: 'b',
				path: 'packages/b',
				version: '2.0.0',
				private: false,
				runtimeDeps: ['a'],
				ranges: {a: 'workspace:^'},
			},
			'pnpm',
			out,
		);
		expect(path.isAbsolute(tgz)).toBe(true);
		const facts = await readTarball(tgz);
		expect((facts.manifest.dependencies as Record<string, string>).a).toBe(
			'^1.0.0',
		);
		expect(facts.files).toContain('package/package.json');
		expect(tarballProblems(facts)).toEqual([]);
	});

	it.skipIf(!has('npm'))('npm pack makes a tarball', async () => {
		const root = await tmp({
			'package.json': JSON.stringify({name: 'solo', version: '1.0.0'}),
		});
		const out = await tmp({});
		const tgz = await packPackage(
			root,
			{
				name: 'solo',
				path: '',
				version: '1.0.0',
				private: false,
				runtimeDeps: [],
				ranges: {},
			},
			'npm',
			out,
		);
		expect((await readTarball(tgz)).manifest.name).toBe('solo');
	});
});

describe('tarballProblems', () => {
	it('finds leftover workspace and catalog ranges', () => {
		const problems = tarballProblems({
			manifest: {dependencies: {a: 'workspace:*', b: 'catalog:'}},
			files: ['package/package.json'],
		});
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain('a');
		expect(problems[1]).toContain('b');
	});

	it('finds a missing entry file', () => {
		const problems = tarballProblems({
			manifest: {main: 'dist/index.js'},
			files: ['package/package.json'],
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('dist/index.js');
	});

	it('checks exports (string and conditions) and bin', () => {
		const files = ['package/package.json', 'package/dist/ok.js'];
		expect(
			tarballProblems({
				manifest: {
					exports: {
						'.': {import: './dist/ok.js', require: './dist/gone.cjs'},
						'./x': './dist/x.js',
						'./y/*': './dist/y/*.js',
					},
					bin: {tool: './dist/bin.js'},
				},
				files,
			}),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining('dist/gone.cjs'),
				expect.stringContaining('dist/x.js'),
				expect.stringContaining('dist/bin.js'),
			]),
		);
		expect(
			tarballProblems({
				manifest: {exports: './dist/ok.js', bin: 'dist/ok.js'},
				files,
			}),
		).toEqual([]);
	});

	it('accepts an extensionless main', () => {
		expect(
			tarballProblems({
				manifest: {main: 'lib'},
				files: ['package/package.json', 'package/lib/index.js'],
			}),
		).toEqual([]);
	});
});

describe('tarballProblems exports', () => {
	const base = ['package/package.json'];

	it('needs a pattern target to match a file', () => {
		const manifest = {exports: {'./*': './dist/*.js'}};
		const problems = tarballProblems({manifest, files: base});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('./dist/*.js');
		expect(
			tarballProblems({manifest, files: [...base, 'package/dist/a.js']}),
		).toEqual([]);
	});

	it('refuses a target that does not start with ./', () => {
		const problems = tarballProblems({
			manifest: {exports: {'.': 'dist/a.js'}},
			files: [...base, 'package/dist/a.js'],
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('dist/a.js');
	});

	it('checks arrays and nested conditions', () => {
		const files = [...base, 'package/dist/a.js'];
		expect(
			tarballProblems({
				manifest: {exports: ['./dist/a.js', './dist/b.js']},
				files,
			}),
		).toEqual([expect.stringContaining('dist/b.js')]);
		expect(
			tarballProblems({
				manifest: {
					exports: {
						'.': {
							import: {types: './dist/a.d.ts', default: './dist/a.js'},
						},
					},
				},
				files,
			}),
		).toEqual([expect.stringContaining('dist/a.d.ts')]);
	});
});

describe('spawnSpec', () => {
	it('runs the command directly off Windows', () => {
		expect(spawnSpec('pnpm', ['pack', '/o x'], 'linux')).toEqual({
			file: 'pnpm',
			args: ['pack', '/o x'],
		});
	});

	it('goes through cmd.exe on Windows', () => {
		expect(spawnSpec('pnpm', ['pack', 'C:\\o x'], 'win32')).toEqual({
			file: 'cmd.exe',
			args: ['/d', '/s', '/c', 'pnpm', 'pack', 'C:\\o x'],
		});
		expect(
			spawnSpec('yarn', ['pack', '--out', 'C:\\o\\%s-%v.tgz'], 'win32').file,
		).toBe('cmd.exe');
	});

	it('refuses cmd metacharacters on Windows', () => {
		expect(() => spawnSpec('npm', ['pack', 'C:\\%TEMP%'], 'win32')).toThrow(
			'%TEMP%',
		);
		expect(() => spawnSpec('npm', ['pack', 'a&b'], 'win32')).toThrow('a&b');
		expect(() => spawnSpec('npm', ['pack', 'a&b'], 'linux')).not.toThrow();
	});
});

describe('tarCommand', () => {
	it('is tar off Windows', () => {
		expect(tarCommand('darwin', () => true)).toBe('tar');
	});

	it('prefers the system bsdtar on Windows when it exists', () => {
		expect(tarCommand('win32', () => true, 'D:\\Win')).toBe(
			'D:\\Win\\System32\\tar.exe',
		);
		expect(tarCommand('win32', () => true, undefined)).toBe(
			'C:\\Windows\\System32\\tar.exe',
		);
		expect(tarCommand('win32', () => false, 'D:\\Win')).toBe('tar');
	});
});
