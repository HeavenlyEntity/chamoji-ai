import {afterEach, expect, test} from 'vitest';
import {detectLayout} from '../../src/index.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';
import {
	gearzLayout,
	libraryLayout,
	singlePackage,
	suiteAppMonorepo,
	templatedSuiteApp,
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

const pkgJson = (value: Record<string, unknown>): string =>
	JSON.stringify(value, null, 2);

test('a Next.js app at packages/web is an app with its reason', async () => {
	repo = await createRepo([
		{
			commit: 'x',
			files: {
				'package.json': pkgJson({
					name: 'root',
					private: true,
					workspaces: ['packages/*'],
				}),
				'packages/web/package.json': pkgJson({
					name: 'web',
					private: true,
					version: '1.0.0',
					dependencies: {next: '^15.2.0'},
				}),
				'packages/web/next.config.mjs': 'export default {};\n',
				'packages/ui/package.json': pkgJson({
					name: 'ui',
					version: '1.0.0',
					exports: './index.js',
				}),
			},
		},
	]);
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('mixed');
	expect(found.apps.map(app => app.path)).toEqual(['packages/web']);
	expect(found.apps[0]!.kind.reasons).toContain('`next` in dependencies');
	expect(found.apps[0]!.framework?.name).toBe('Next.js');
	expect(found.libraries.map(pkg => pkg.path)).toEqual(['packages/ui']);
});

test('the SuiteApp is an app even with a main field', async () => {
	repo = await suiteAppMonorepo();
	const found = await detectLayout(repo.dir);
	expect(found.apps.map(app => app.path)).toEqual(['apps/backend', 'apps/web']);
	expect(found.libraries).toEqual([]);
	const backend = found.apps.find(app => app.path === 'apps/backend')!;
	expect(backend.kind.reasons[0]).toBe(
		'NetSuite SuiteApp (`apps/backend/src/manifest.xml`)',
	);
	expect(backend.framework?.id).toBe('netsuite-suiteapp');
	expect(backend.sdf?.applicationId).toBe('com.example.myapp');
	expect(found.sdf.map(project => project.path)).toEqual(['apps/backend']);
});

test('an SDF folder with no package.json is an app unit', async () => {
	repo = await templatedSuiteApp();
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('apps');
	expect(found.apps).toMatchObject([{path: 'apps/suiteapp', pkg: null}]);
	const facts = found.units.find(unit => unit.path === 'apps/suiteapp')!;
	expect(facts.versionFiles).toEqual(['apps/suiteapp/template/manifest.xml']);
	expect(facts.version).toBe('0.1.0');
	expect(facts.sdf?.type).toBe('suiteapp');
});

test('package.json and manifest versions that disagree are recorded', async () => {
	repo = await suiteAppMonorepo();
	const found = await detectLayout(repo.dir);
	const backend = found.units.find(unit => unit.name === 'backend')!;
	expect(backend.version).toBe('2.5.20');
	expect(backend.versionMismatch).toEqual({
		packageJson: '2.5.20',
		manifest: '2.10.34',
	});
	const web = found.units.find(unit => unit.name === 'web')!;
	expect(web.versionMismatch).toBeNull();
});

test('a library with react only as a peer stays a library with no framework', async () => {
	repo = await createRepo([
		{
			commit: 'x',
			files: {
				'package.json': pkgJson({
					name: 'root',
					private: true,
					workspaces: ['packages/*'],
				}),
				'packages/kit/package.json': pkgJson({
					name: 'kit',
					version: '1.0.0',
					peerDependencies: {react: '^19.0.0'},
				}),
				'packages/other/package.json': pkgJson({
					name: 'other',
					version: '1.0.0',
					exports: './index.js',
				}),
			},
		},
	]);
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('libraries');
	expect(found.candidates.map(unit => [unit.name, unit.kind.kind])).toEqual([
		['kit', 'library'],
		['other', 'library'],
	]);
	expect(found.candidates.every(unit => unit.framework === null)).toBe(true);
});

test('an Expo module is a library', async () => {
	repo = await createRepo([
		{
			commit: 'x',
			files: {
				'package.json': pkgJson({
					name: 'root',
					private: true,
					workspaces: ['packages/*'],
				}),
				'packages/native/package.json': pkgJson({
					name: 'native',
					version: '1.0.0',
					dependencies: {expo: '^52.0.0'},
				}),
				'packages/native/expo-module.config.json': '{}\n',
				'packages/other/package.json': pkgJson({
					name: 'other',
					version: '1.0.0',
					exports: './index.js',
				}),
			},
		},
	]);
	const found = await detectLayout(repo.dir);
	expect(found.kind).toBe('libraries');
	expect(found.libraries.map(pkg => pkg.path)).toEqual([
		'packages/native',
		'packages/other',
	]);
});
