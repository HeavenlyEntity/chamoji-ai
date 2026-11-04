import {afterEach, expect, test} from 'vitest';
import {detectLayout} from '../../src/index.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';
import {
	gearzLayout,
	libraryLayout,
	singlePackage,
} from '../helpers/setup-fixtures.js';

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

test('gearz: web and mobile are units, e2e and dev-tool unticked and excluded, tooling excluded', async () => {
	repo = await gearzLayout();
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('apps');
	// Units come back in path order; the brief lists them as web, mobile.
	expect(found.units.map(unit => unit.name)).toEqual(['mobile', 'web']);
	expect(found.excluded).toEqual(['apps/dev-tool', 'apps/e2e', 'tooling/*']);
});

test("mobile's facts: app.config.ts is a version file and EAS is remote", async () => {
	repo = await gearzLayout();
	const found = await detectLayout(repo.dir);
	const mobile = found.units.find(unit => unit.name === 'mobile')!;
	expect(mobile.version).toBe('1.0.0');
	expect(mobile.versionFiles).toEqual(['apps/mobile/app.config.ts']);
	expect(mobile.easRemote).toBe(true);
	expect(mobile.easLocal).toBe(false);
});

test("a devDependency never makes a package an app's dependency, and tooling is not an app", async () => {
	repo = await gearzLayout();
	const found = await detectLayout(repo.dir);
	const web = found.packages.find(pkg => pkg.path === 'apps/web')!;
	expect(web.runtimeDeps).toEqual(['@gearz/supabase']);
	expect(found.apps.map(app => app.path)).not.toContain('tooling/eslint');
	expect(found.apps.map(app => app.path)).not.toContain('packages/supabase');
});

test('libraries: three published packages, no apps', async () => {
	repo = await libraryLayout();
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('libraries');
	expect(found.apps).toEqual([]);
	expect(found.units.map(unit => unit.name)).toEqual(['cli', 'core', 'types']);
});

test('a single package or no workspace is single', async () => {
	repo = await singlePackage();
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('single');
	expect(found.units).toEqual([]);

	const empty = await createRepo([]);
	try {
		const none = await detectLayout(empty.dir);
		expect(none.kind).toBe('single');
		expect(none.rootOnly).toEqual({count: 0, examples: [], since: null});
	} finally {
		await empty.cleanup();
	}
});

test('root-only commits are counted with up to three example files', async () => {
	repo = await gearzLayout({
		extraSteps: [
			{commit: '🔧 Pin the lockfile', files: {'pnpm-lock.yaml': 'v: 2\n'}},
			{
				commit: '👷 Cache installs',
				files: {'.github/workflows/ci.yml': 'name: ci\non: pull_request\n'},
			},
		],
	});
	const found = await detectLayout(repo.dir);
	expect(found.rootOnly).toEqual({
		count: 2,
		examples: ['.github/workflows/ci.yml', 'pnpm-lock.yaml'],
		since: null,
	});
});

test('root-only commits after a tag are counted since that tag', async () => {
	repo = await gearzLayout({
		extraSteps: [
			{tag: 'web/v0.1.0'},
			{commit: '🔧 Pin the lockfile', files: {'pnpm-lock.yaml': 'v: 2\n'}},
		],
	});
	const found = await detectLayout(repo.dir);
	expect(found.rootOnly).toEqual({
		count: 1,
		examples: ['pnpm-lock.yaml'],
		since: 'web/v0.1.0',
	});
});

test('a VERSION constant is offered, a longer version string is not', async () => {
	repo = await gearzLayout({
		extraSteps: [
			{
				commit: '✨ Add version files',
				files: {
					'apps/web/src/version.ts': "export const VERSION = '0.1.0';\n",
					'apps/web/src/other.ts': "export const OTHER = '10.1.0.5';\n",
				},
			},
		],
	});
	const found = await detectLayout(repo.dir);
	const web = found.units.find(unit => unit.name === 'web')!;
	expect(web.otherVersionFiles).toEqual(['apps/web/src/version.ts']);
});
