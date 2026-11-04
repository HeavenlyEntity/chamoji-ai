import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	attribute,
	parseReleaseSettings,
	readCommitFiles,
	releaseTargets,
	resolveUnits,
	type ReleaseSettings,
	type ResolvedUnit,
	type WorkspacePackage,
} from '../../src/index.js';
import {commit} from '../helpers/commit.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../helpers/fixture-repo.js';

const pkg = (
	name: string,
	path: string,
	runtimeDeps: string[] = [],
): WorkspacePackage => ({
	name,
	path,
	version: '1.0.0',
	private: false,
	runtimeDeps,
	ranges: {},
});

const packages = [
	pkg('web', 'apps/web', ['@k/supabase']),
	pkg('mobile', 'apps/mobile'),
	pkg('@k/supabase', 'packages/supabase'),
	pkg('@k/ui', 'packages/ui'),
];

function setup(rootFiles: 'none' | 'all' | 'note' = 'none'): {
	settings: ReleaseSettings;
	units: ResolvedUnit[];
} {
	const settings = parseReleaseSettings(
		{
			schema: 1,
			shape: 'apps',
			units: {web: {path: 'apps/web'}, mobile: {path: 'apps/mobile'}},
			exclude: ['apps/e2e'],
			rootFiles,
		},
		'/repo/chamoji.config.json',
	);
	return {settings, units: resolveUnits(settings, packages)};
}

test('own, shared and root are split', () => {
	const {settings, units} = setup('note');
	const own = commit('own');
	const shared = commit('shared');
	const root = commit('root');
	const excluded = commit('excluded');
	const files = new Map([
		[own.hash, ['apps/web/a.ts']],
		[shared.hash, ['packages/supabase/b.ts']],
		[root.hash, ['pnpm-lock.yaml']],
		[excluded.hash, ['apps/e2e/c.ts']],
	]);
	const web = units.find(unit => unit.name === 'web')!;

	const result = attribute(
		[own, shared, root, excluded],
		files,
		web,
		units,
		packages,
		settings,
	);
	expect(result.own).toEqual([own]);
	expect(result.shared).toEqual([{...shared, via: 'packages/supabase'}]);
	expect(result.root).toEqual([root]);
});

test('root commits are dropped under rootFiles none', () => {
	const {settings, units} = setup('none');
	const root = commit('root');
	const web = units.find(unit => unit.name === 'web')!;
	const result = attribute(
		[root],
		new Map([[root.hash, ['pnpm-lock.yaml']]]),
		web,
		units,
		packages,
		settings,
	);
	expect(result).toEqual({own: [], shared: [], root: []});
});

test('a commit touching two units is own for both', () => {
	const {settings, units} = setup();
	const both = commit('both');
	const files = new Map([[both.hash, ['apps/web/a.ts', 'apps/mobile/b.ts']]]);
	for (const unit of units) {
		const result = attribute([both], files, unit, units, packages, settings);
		expect(result.own).toEqual([both]);
		expect(result.shared).toEqual([]);
	}
});

test('a used package plus another unit is shared, and an unused one is dropped', () => {
	const {settings, units} = setup();
	const mixed = commit('mixed');
	const files = new Map([
		[mixed.hash, ['packages/supabase/b.ts', 'apps/mobile/x.ts']],
	]);
	const web = units.find(unit => unit.name === 'web')!;
	expect(
		attribute([mixed], files, web, units, packages, settings).shared,
	).toEqual([{...mixed, via: 'packages/supabase'}]);

	const unused = commit('unused');
	const unusedFiles = new Map([[unused.hash, ['packages/ui/x.ts']]]);
	expect(
		attribute([unused], unusedFiles, web, units, packages, settings),
	).toEqual({own: [], shared: [], root: []});
});

test('rootFiles all makes root commits own', () => {
	const {settings, units} = setup('all');
	const root = commit('root');
	const web = units.find(unit => unit.name === 'web')!;
	const result = attribute(
		[root],
		new Map([[root.hash, ['pnpm-lock.yaml']]]),
		web,
		units,
		packages,
		settings,
	);
	expect(result.own).toEqual([root]);
	expect(result.root).toEqual([]);
});

test('Release trailers name units', () => {
	const names = ['web', 'mobile'];
	const one = commit('one', {trailers: 'Release: mobile'});
	expect(releaseTargets(one, names)).toEqual(['mobile']);

	const all = commit('all', {trailers: 'Release: all'});
	expect(releaseTargets(all, names)).toEqual(['web', 'mobile']);

	const messy = commit('messy', {
		trailers: 'release: Mobile, nope,  WEB\nRelease: mobile',
	});
	expect(releaseTargets(messy, names)).toEqual(['web', 'mobile']);

	expect(releaseTargets(commit('none'), names)).toEqual([]);
	expect(
		releaseTargets(commit('x', {trailers: 'Release: nope'}), names),
	).toEqual([]);
});

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

test('a moved file counts for both owners', async () => {
	repo = await createRepo([
		{
			commit: 'add ui file',
			files: {'packages/ui/x.ts': 'export const x = 1;\n'},
		},
		{commit: 'empty one'},
	]);
	await mkdir(path.join(repo.dir, 'apps', 'web'), {recursive: true});
	await gitOutput(repo.dir, ['mv', 'packages/ui/x.ts', 'apps/web/x.ts']);
	await gitOutput(repo.dir, [
		'-c',
		'user.name=Fixture Bot',
		'-c',
		'user.email=fixture@example.com',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-q',
		'-m',
		'move it',
	]);

	const files = await readCommitFiles(repo.dir, 'HEAD');
	const [moveHash] = [...files.keys()];
	expect(files.get(moveHash!)?.sort()).toEqual([
		'apps/web/x.ts',
		'packages/ui/x.ts',
	]);
	// Empty commits are listed with no files.
	expect([...files.values()].map(list => list.length)).toEqual([2, 0, 1]);

	const ui = [pkg('@k/ui', 'packages/ui'), pkg('lib', 'libs/lib', ['@k/ui'])];
	const all = [...packages.filter(p => p.path.startsWith('apps/')), ...ui];
	const settings = parseReleaseSettings(
		{
			schema: 1,
			shape: 'apps',
			units: {web: {path: 'apps/web'}, lib: {path: 'libs/lib'}},
		},
		'/repo/chamoji.config.json',
	);
	const units = resolveUnits(settings, all);
	const moved = commit('move it');
	moved.hash = moveHash!;
	const map = new Map([[moveHash!, files.get(moveHash!)!]]);
	const web = units.find(unit => unit.name === 'web')!;
	const lib = units.find(unit => unit.name === 'lib')!;
	expect(attribute([moved], map, web, units, all, settings).own).toEqual([
		moved,
	]);
	expect(attribute([moved], map, lib, units, all, settings).shared).toEqual([
		{...moved, via: 'packages/ui'},
	]);
});
