import {afterEach, expect, test} from 'vitest';
import {classifyPackage, readWorkspace} from '../../src/index.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const json = (value: Record<string, unknown>): string =>
	JSON.stringify(value, null, 2);

/** Makes a repo with one package at `at`, plus any extra files, and classifies it. */
async function classify(
	at: string,
	manifest: Record<string, unknown>,
	files: Record<string, string> = {},
	others: Record<string, Record<string, unknown>> = {},
) {
	const prefix = at === '' ? '' : `${at}/`;
	const all: Record<string, string> = {
		[`${prefix}package.json`]: json({name: 'x', version: '1.0.0', ...manifest}),
	};
	for (const [file, content] of Object.entries(files)) {
		all[`${prefix}${file}`] = content;
	}

	for (const [otherAt, other] of Object.entries(others)) {
		all[`${otherAt}/package.json`] = json(other);
	}

	if (at !== '' || Object.keys(others).length > 0) {
		all['package.json'] = json({
			name: 'root',
			private: true,
			workspaces: ['*', 'apps/*', 'packages/*'],
		});
	}

	repo = await createRepo([{commit: 'x', files: all}]);
	const packages = await readWorkspace(repo.dir);
	const pkg = packages.find(candidate => candidate.path === at);
	if (!pkg) throw new Error(`no package at ${at}`);
	const dependedOn = new Set(packages.flatMap(p => p.runtimeDeps));
	return classifyPackage(repo.dir, pkg, dependedOn);
}

test('a Next.js app is an app', async () => {
	const result = await classify(
		'apps/web',
		{dependencies: {next: '^15.0.0'}},
		{'next.config.ts': 'export default {};'},
	);
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`next` in dependencies');
	expect(result.reasons).toContain('`next.config.ts`');
});

test('a public Expo app under packages/ is an app', async () => {
	const result = await classify(
		'packages/mobile',
		{dependencies: {expo: '^52.0.0'}},
		{'app.json': json({expo: {name: 'mobile'}})},
	);
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`expo` in dependencies');
});

test('a Vite app needs index.html', async () => {
	const withHtml = await classify(
		'packages/site',
		{dependencies: {vite: '^6.0.0'}},
		{'index.html': '<html></html>'},
	);
	expect(withHtml.kind).toBe('app');
	await repo?.cleanup();

	const without = await classify('packages/site', {
		dependencies: {vite: '^6.0.0'},
	});
	expect(without.kind).toBe('library');
});

test('entry points make a library even with a framework', async () => {
	const result = await classify(
		'packages/native-thing',
		{exports: './index.js', dependencies: {expo: '^52.0.0'}},
		{'expo-module.config.json': '{}'},
	);
	expect(result.kind).toBe('library');
	expect(result.reasons.join(' ')).toContain('exports');
});

test('a native module manifest makes a library without entry points', async () => {
	const result = await classify(
		'packages/native-thing',
		{dependencies: {expo: '^52.0.0'}},
		{'expo-module.config.json': '{}'},
	);
	expect(result.kind).toBe('library');
});

test('publishConfig and files make a library', async () => {
	const published = await classify('apps/x', {
		dependencies: {next: '^15.0.0'},
		publishConfig: {access: 'public'},
	});
	expect(published.kind).toBe('library');
	await repo?.cleanup();

	const files = await classify('apps/x', {
		dependencies: {next: '^15.0.0'},
		files: ['dist'],
	});
	expect(files.kind).toBe('library');
});

test('a framework only as a peer is a library', async () => {
	const result = await classify('packages/ui', {
		peerDependencies: {react: '^19.0.0', next: '^15.0.0'},
		exports: './index.js',
	});
	expect(result.kind).toBe('library');
});

test('a framework only as a peer or dev dependency is a library without entry points', async () => {
	const result = await classify('packages/ui', {
		peerDependencies: {next: '^15.0.0'},
		devDependencies: {next: '^15.0.0'},
	});
	expect(result.kind).toBe('library');
});

test('no signals falls back to the layout rule', async () => {
	const underApps = await classify('apps/x', {});
	expect(underApps.kind).toBe('app');
	await repo?.cleanup();

	const topLevel = await classify('tool', {private: true});
	expect(topLevel.kind).toBe('app');
	await repo?.cleanup();

	const dependedOn = await classify(
		'tool',
		{name: 'tool', private: true},
		{},
		{other: {name: 'other', dependencies: {tool: '1.0.0'}}},
	);
	expect(dependedOn.kind).toBe('library');
	await repo?.cleanup();

	const publicTop = await classify('tool', {});
	expect(publicTop.kind).toBe('library');
	await repo?.cleanup();

	const nested = await classify('packages/x', {private: true});
	expect(nested.kind).toBe('library');
});

test('NestJS, Hydrogen, Qwik and Remix are apps', async () => {
	const cases: Array<[Record<string, unknown>, string]> = [
		[
			{dependencies: {'@nestjs/core': '^11.0.0'}},
			'`@nestjs/core` in dependencies',
		],
		[
			{dependencies: {'@shopify/hydrogen': '^2025.1.0'}},
			'`@shopify/hydrogen` in dependencies',
		],
		[
			{dependencies: {'@builder.io/qwik-city': '^1.0.0'}},
			'`@builder.io/qwik-city` in dependencies',
		],
		[
			{dependencies: {'@remix-run/node': '^2.0.0'}},
			'`@remix-run/node` in dependencies',
		],
	];
	for (const [manifest, reason] of cases) {
		// eslint-disable-next-line no-await-in-loop
		const result = await classify('packages/svc', manifest);
		expect(result.kind).toBe('app');
		expect(result.reasons).toContain(reason);
		// eslint-disable-next-line no-await-in-loop
		await repo?.cleanup();
	}
});

test('React Router is an app through its config file', async () => {
	const result = await classify(
		'packages/web',
		{dependencies: {'react-router': '^7.0.0'}},
		{'react-router.config.ts': 'export default {};'},
	);
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`react-router.config.ts`');
});

test('Electron in devDependencies with a builder config is an app despite main', async () => {
	const result = await classify(
		'packages/desktop',
		{main: 'dist/main.js', devDependencies: {electron: '^33.0.0'}},
		{'electron-builder.yml': 'appId: x'},
	);
	expect(result.kind).toBe('app');
	await repo?.cleanup();

	const byKey = await classify('packages/desktop', {
		main: 'dist/main.js',
		devDependencies: {electron: '^33.0.0'},
		build: {appId: 'x'},
	});
	expect(byKey.kind).toBe('app');
});

test('an Expo Router app with main is an app', async () => {
	const result = await classify('packages/mobile', {
		main: 'expo-router/entry',
		dependencies: {expo: '^52.0.0'},
	});
	expect(result.kind).toBe('app');
});

test('an Express server with main is an app', async () => {
	const result = await classify('packages/api', {
		main: 'index.js',
		dependencies: {express: '^5.0.0'},
	});
	expect(result.kind).toBe('app');
});

test('a bare main with no framework is a library', async () => {
	const result = await classify('packages/lib', {main: 'index.js'});
	expect(result.kind).toBe('library');
});

test('a framework-dependent package with exports is still a library', async () => {
	const result = await classify('packages/api', {
		exports: './index.js',
		main: 'index.js',
		dependencies: {express: '^5.0.0'},
	});
	expect(result.kind).toBe('library');
});

test('app.json with an expo key is an app, without one it is not', async () => {
	const result = await classify(
		'packages/mobile',
		{},
		{'app.json': json({expo: {name: 'm'}})},
	);
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`app.json` with an `expo` key');
	await repo?.cleanup();

	const plain = await classify(
		'packages/mobile',
		{},
		{'app.json': json({name: 'm'})},
	);
	expect(plain.kind).toBe('library');
});

test('ios and android folders make an app when react-native is a dependency', async () => {
	const files = {'ios/Podfile': '', 'android/build.gradle': ''};
	const result = await classify(
		'packages/mobile',
		{devDependencies: {'react-native': '^0.76.0'}},
		files,
	);
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`ios/` and `android/` folders');
	await repo?.cleanup();

	const without = await classify('packages/mobile', {}, files);
	expect(without.kind).toBe('library');
});

test('vercel.json makes an app', async () => {
	const result = await classify('packages/site', {}, {'vercel.json': '{}'});
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`vercel.json`');
});

test('Angular needs angular.json with @angular/core in dependencies', async () => {
	const result = await classify(
		'packages/web',
		{dependencies: {'@angular/core': '^19.0.0'}},
		{'angular.json': '{}'},
	);
	expect(result.kind).toBe('app');
	await repo?.cleanup();

	const onlyDep = await classify('packages/web', {
		dependencies: {'@angular/core': '^19.0.0'},
	});
	expect(onlyDep.kind).toBe('library');
	await repo?.cleanup();

	const onlyFile = await classify('packages/web', {}, {'angular.json': '{}'});
	expect(onlyFile.kind).toBe('library');
});

test('a podspec makes a library even with a framework', async () => {
	const result = await classify(
		'packages/native',
		{dependencies: {'react-native': '^0.76.0'}},
		{'native.podspec': ''},
	);
	expect(result.kind).toBe('library');
});

test('react-native.config.js with a dependency section makes a library', async () => {
	const result = await classify(
		'packages/native',
		{dependencies: {'react-native': '^0.76.0'}},
		{'react-native.config.js': 'module.exports = {dependency: {}};'},
	);
	expect(result.kind).toBe('library');
});

test('a framework only as a peer is a library even under apps/', async () => {
	const result = await classify('apps/x', {
		peerDependencies: {next: '^15.0.0'},
	});
	expect(result.kind).toBe('library');
	expect(result.reasons).toContain('`next` only in peerDependencies');
});

test('a peer framework with its config file is still an app', async () => {
	const result = await classify(
		'apps/x',
		{peerDependencies: {next: '^15.0.0'}},
		{'next.config.ts': 'export default {};'},
	);
	expect(result.kind).toBe('app');
});

test('svelte.config counts only with @sveltejs/kit', async () => {
	const result = await classify(
		'packages/site',
		{devDependencies: {'@sveltejs/kit': '^2.0.0'}},
		{'svelte.config.js': 'export default {};'},
	);
	expect(result.kind).toBe('app');
	await repo?.cleanup();

	const plain = await classify(
		'packages/site',
		{devDependencies: {svelte: '^5.0.0'}},
		{'svelte.config.js': 'export default {};'},
	);
	expect(plain.kind).toBe('library');
});

test('a Vite app with vite in devDependencies and index.html is an app', async () => {
	const manifest = {
		dependencies: {react: '^19.0.0'},
		devDependencies: {vite: '^6.0.0', '@vitejs/plugin-react': '^4.0.0'},
	};
	const result = await classify('packages/spa', manifest, {
		'index.html': '<html></html>',
	});
	expect(result.kind).toBe('app');
	expect(result.reasons).toContain('`index.html`');
	await repo?.cleanup();

	const without = await classify('packages/spa', manifest);
	expect(without.kind).toBe('library');
	await repo?.cleanup();

	const withConfig = await classify(
		'packages/spa',
		{devDependencies: {vite: '^6.0.0'}},
		{'vite.config.ts': 'export default {};', 'index.html': '<html></html>'},
	);
	expect(withConfig.kind).toBe('app');
});

test('an app names its most specific framework', async () => {
	const next = await classify(
		'apps/web',
		{dependencies: {next: '^15.0.0', react: '^19.0.0'}},
		{'next.config.ts': 'export default {};'},
	);
	expect(next.framework).toBe('Next.js');
	await repo?.cleanup();

	const vite = await classify(
		'packages/spa',
		{
			dependencies: {react: '^19.0.0'},
			devDependencies: {vite: '^6.0.0', '@vitejs/plugin-react': '^4.0.0'},
		},
		{'index.html': '<html></html>'},
	);
	expect(vite.framework).toBe('Vite + React');
	await repo?.cleanup();

	const fallback = await classify('apps/x', {});
	expect(fallback).toEqual({kind: 'app', reasons: ['under `apps/`']});
});
