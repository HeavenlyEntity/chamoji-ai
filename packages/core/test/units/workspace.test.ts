import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, expect, test} from 'vitest';
import {
	ownerOf,
	parseReleaseSettings,
	readWorkspace,
	resolveUnits,
} from '../../src/index.js';

let dir: string | undefined;

afterEach(async () => {
	if (dir) await rm(dir, {recursive: true, force: true});
	dir = undefined;
});

async function repo(files: Record<string, string>): Promise<string> {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-ws-'));
	for (const [file, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(dir, file)), {recursive: true});
		await writeFile(path.join(dir, file), content);
	}

	return dir;
}

const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({name, version: '1.0.0', ...extra});

test('reads pnpm workspace globs, nested and negated', async () => {
	const root = await repo({
		'pnpm-workspace.yaml':
			"packages:\n  - 'apps/*'\n  - 'packages/**'\n  - '!packages/legacy'\n",
		'package.json': JSON.stringify({name: 'root'}),
		'apps/web/package.json': pkg('web'),
		'apps/mobile/package.json': pkg('mobile'),
		'packages/ui/package.json': pkg('@k/ui'),
		'packages/features/billing/package.json': pkg('@k/billing'),
		'packages/legacy/package.json': pkg('@k/legacy'),
		'packages/ui/node_modules/dep/package.json': pkg('dep'),
		'apps/nameless/package.json': JSON.stringify({version: '1.0.0'}),
	});

	const found = await readWorkspace(root);
	expect(found.map(item => item.path)).toEqual([
		'apps/mobile',
		'apps/web',
		'packages/features/billing',
		'packages/ui',
	]);
});

test('a malformed package.json under a workspace glob throws, naming it', async () => {
	const root = await repo({
		'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
		'apps/web/package.json': '{nope',
	});
	await expect(readWorkspace(root)).rejects.toThrow(/apps.web.package\.json/);
});

test('a malformed pnpm-workspace.yaml throws, naming it', async () => {
	const root = await repo({
		'pnpm-workspace.yaml': 'packages: [unclosed\n',
		'package.json': JSON.stringify({name: 'root', workspaces: ['apps/*']}),
	});
	await expect(readWorkspace(root)).rejects.toThrow(/pnpm-workspace\.yaml/);
});

test('folders outside every glob prefix are never read', async () => {
	const root = await repo({
		'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/**\n',
		'apps/web/package.json': pkg('web'),
		'other/x/package.json': '{nope',
		'.claude/worktrees/w/package.json': '{nope',
	});
	const found = await readWorkspace(root);
	expect(found.map(item => item.path)).toEqual(['apps/web']);
});

test('git-ignored build output is not a package', async () => {
	const root = await repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/**\n',
		'.gitignore': 'dist/\n',
		'packages/ui/package.json': pkg('@k/ui'),
		'packages/ui/dist/package.json': pkg('@k/ui-dist'),
	});
	execFileSync('git', ['init', '-q'], {cwd: root});
	const found = await readWorkspace(root);
	expect(found.map(item => item.name)).toEqual(['@k/ui']);
});

test('test folders under a ** glob are skipped, in git and plain folders', async () => {
	const files = {
		'pnpm-workspace.yaml': 'packages:\n  - packages/**\n',
		'packages/x/package.json': pkg('x'),
		'packages/x/test/fixtures/bad/package.json': '{nope',
	};
	const plain = await repo(files);
	expect((await readWorkspace(plain)).map(item => item.name)).toEqual(['x']);
	await rm(plain, {recursive: true, force: true});

	const root = await repo(files);
	execFileSync('git', ['init', '-q'], {cwd: root});
	expect((await readWorkspace(root)).map(item => item.name)).toEqual(['x']);
});

test('reads npm workspaces as an object', async () => {
	const root = await repo({
		'package.json': JSON.stringify({
			name: 'root',
			workspaces: {packages: ['libs/*']},
		}),
		'libs/a/package.json': pkg('a', {
			private: true,
			dependencies: {b: '^1.0.0'},
			peerDependencies: {c: '*'},
			devDependencies: {d: '~2.0.0'},
		}),
	});

	const [a] = await readWorkspace(root);
	expect(a).toEqual({
		name: 'a',
		path: 'libs/a',
		version: '1.0.0',
		private: true,
		runtimeDeps: ['b', 'c'],
		ranges: {b: '^1.0.0', c: '*', d: '~2.0.0'},
	});
});

const settings = (units: Record<string, {path: string}>, exclude: string[]) =>
	parseReleaseSettings(
		{schema: 1, shape: 'apps', units, exclude},
		'/repo/chamoji.config.json',
	);

test('uses follows runtime dependencies transitively, not devDependencies', async () => {
	const root = await repo({
		'pnpm-workspace.yaml':
			'packages:\n  - apps/*\n  - packages/**\n  - tooling/*\n',
		'apps/web/package.json': pkg('web', {
			dependencies: {'@k/billing': 'workspace:*', react: '^19'},
			devDependencies: {'@k/eslint-config': 'workspace:*'},
		}),
		'apps/other/package.json': pkg('other', {
			dependencies: {web: 'workspace:*'},
		}),
		'packages/features/billing/package.json': pkg('@k/billing', {
			dependencies: {'@k/supabase': 'workspace:*', other: 'workspace:*'},
		}),
		'packages/supabase/package.json': pkg('@k/supabase'),
		'tooling/eslint/package.json': pkg('@k/eslint-config'),
	});

	const packages = await readWorkspace(root);
	const units = resolveUnits(
		settings({web: {path: 'apps/web'}, other: {path: 'apps/other'}}, [
			'tooling/*',
		]),
		packages,
	);

	expect(units[0]?.pkg?.name).toBe('web');
	expect(units[0]?.uses).toEqual([
		'packages/features/billing',
		'packages/supabase',
	]);
	// A dependency on another unit is not followed.
	expect(units[1]?.uses).toEqual([]);
});

test('a unit without a workspace package has pkg null', () => {
	const units = resolveUnits(settings({site: {path: 'site'}}, []), []);
	expect(units[0]?.pkg).toBeNull();
	expect(units[0]?.uses).toEqual([]);
});

test('ownerOf matches on segment boundaries', () => {
	const withUnits = resolveUnits(
		settings(
			{web: {path: 'apps/web'}, 'web-admin': {path: 'apps/web-admin'}},
			[],
		),
		[],
	);
	expect(ownerOf('apps/web-admin/x.ts', withUnits, [], [])).toEqual({
		kind: 'unit',
		unit: 'web-admin',
	});
	expect(ownerOf('apps/web/src/a.ts', withUnits, [], [])).toEqual({
		kind: 'unit',
		unit: 'web',
	});

	const onlyWeb = resolveUnits(settings({web: {path: 'apps/web'}}, []), []);
	expect(
		ownerOf('apps/web-admin/x.ts', onlyWeb, [], ['apps/web-admin']),
	).toEqual({kind: 'excluded'});
	expect(ownerOf('apps/web-admin/x.ts', onlyWeb, [], [])).toEqual({
		kind: 'root',
	});
});

test('excluded globs win over internal', () => {
	const eslint = {
		name: '@k/eslint',
		path: 'tooling/eslint',
		version: null,
		private: true,
		runtimeDeps: [],
		ranges: {},
	};
	const ui = {...eslint, name: '@k/ui', path: 'packages/ui'};
	const units = resolveUnits(settings({web: {path: 'apps/web'}}, []), []);
	const exclude = ['tooling/*'];

	expect(
		ownerOf('tooling/eslint/index.js', units, [eslint, ui], exclude),
	).toEqual({kind: 'excluded'});
	expect(ownerOf('packages/ui/a.ts', units, [eslint, ui], exclude)).toEqual({
		kind: 'internal',
		path: 'packages/ui',
	});
});

test('files outside every package are root', () => {
	const units = resolveUnits(settings({web: {path: 'apps/web'}}, []), []);
	for (const file of ['pnpm-lock.yaml', '.github/workflows/ci.yml']) {
		expect(ownerOf(file, units, [], ['tooling/*'])).toEqual({kind: 'root'});
	}
});
