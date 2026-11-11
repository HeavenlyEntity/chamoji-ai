import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {
	classifyPackage,
	FRAMEWORKS,
	readWorkspace,
	type WorkspacePackage,
} from '../../src/index.js';
import {detectFramework, inspectPackage} from '../../src/publish/kind.js';
import {type FixtureRepo} from '../helpers/fixture-repo.js';
import {frameworkZoo} from '../helpers/setup-fixtures.js';

let repo: FixtureRepo;

beforeAll(async () => {
	repo = await frameworkZoo();
});

afterAll(async () => {
	await repo.cleanup();
});

test.each([
	['vite-react', 'Vite + React', '6.1', ['vite', 'react']],
	['next', 'Next.js', '15.2', ['react']],
	['astro', 'Astro', '5.3', ['vite']],
	['gatsby', 'Gatsby', '5.14', ['react']],
	['remix', 'Remix', '2.15', ['react']],
	['nestjs', 'NestJS', '11', []],
	['hydrogen', 'Hydrogen', '2025.1', ['remix', 'react-router', 'vite']],
	['qwik', 'Qwik', '1.12', ['vite']],
	['expo', 'Expo', '52', ['react-native']],
])(
	'%s is found with its name and version',
	async (id, name, version, basedOn) => {
		expect(await detectFramework(repo.dir, `apps/${id}`)).toEqual({
			id,
			name,
			version,
			basedOn,
		});
	},
);

test('only the most specific framework is shown', async () => {
	// The hydrogen package also depends on @remix-run/react and a React Router
	// package, so three rows match; Hydrogen is the one nothing is built on.
	const found = await detectFramework(repo.dir, 'apps/hydrogen');
	expect(found?.id).toBe('hydrogen');
});

test('a package with no match has no framework', async () => {
	expect(await detectFramework(repo.dir, 'apps/nothing')).toBeNull();
});

test('a framework only in peerDependencies shows nothing', async () => {
	expect(await detectFramework(repo.dir, 'apps/peer-only')).toBeNull();
});

test('every row has a unique id, and every basedOn names a row', () => {
	const ids = FRAMEWORKS.map(row => row.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (const row of FRAMEWORKS) {
		for (const base of row.basedOn) expect(ids).toContain(base);
	}
});

test('Salesforce DX, Shopify app and Forge are found from their files', async () => {
	expect((await detectFramework(repo.dir, 'apps/sfdx-project'))?.id).toBe(
		'salesforce-dx',
	);
	expect((await detectFramework(repo.dir, 'apps/shopify-app'))?.id).toBe(
		'shopify-app',
	);
	expect((await detectFramework(repo.dir, 'apps/forge'))?.id).toBe('forge');
	expect(await detectFramework(repo.dir, 'apps/forge-plain')).toBeNull();
});

test('the NetSuite rows are left to the SDF finder', () => {
	for (const id of ['netsuite-suiteapp', 'netsuite-acp']) {
		const row = FRAMEWORKS.find(found => found.id === id);
		expect(row?.detectedBy).toBe('sdf');
		expect(row?.packages).toEqual([]);
		expect(row?.configFiles).toEqual([]);
	}
});

test('classifyPackage keeps the framework name and adds the whole match', async () => {
	const kind = await classifyPackage(repo.dir, {
		name: '@zoo/next',
		path: 'apps/next',
		private: true,
		version: '0.0.0',
	} as WorkspacePackage);
	expect(kind.kind).toBe('app');
	expect(kind.framework).toBe('Next.js');
	expect(kind.detected).toEqual({
		id: 'next',
		name: 'Next.js',
		version: '15.2',
		basedOn: ['react'],
	});
});

test('Ionic is reported over Angular and React', async () => {
	expect((await detectFramework(repo.dir, 'apps/ionic-angular'))?.id).toBe(
		'ionic',
	);
	expect((await detectFramework(repo.dir, 'apps/ionic-react'))?.id).toBe(
		'ionic',
	);
});

test('a CRLF manifest.yml with app.id as its second child is Forge', async () => {
	expect((await detectFramework(repo.dir, 'apps/forge-crlf'))?.id).toBe(
		'forge',
	);
});

test('a huge manifest.yml with no app.id is rejected quickly', async () => {
	const started = Date.now();
	expect(await detectFramework(repo.dir, 'apps/forge-huge')).toBeNull();
	expect(Date.now() - started).toBeLessThan(1000);
});

test('an app.config.ts alone is no framework; with @solidjs/start it is SolidStart', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-appconfig-'));
	try {
		await mkdir(path.join(dir, 'bare'));
		await writeFile(
			path.join(dir, 'bare', 'package.json'),
			'{"name":"bare","version":"1.0.0"}\n',
		);
		await writeFile(
			path.join(dir, 'bare', 'app.config.ts'),
			'export default {};\n',
		);
		expect(await detectFramework(dir, 'bare')).toBeNull();

		await mkdir(path.join(dir, 'solid'));
		await writeFile(
			path.join(dir, 'solid', 'package.json'),
			'{"name":"solid","version":"1.0.0","dependencies":{"@solidjs/start":"1.0.0"}}\n',
		);
		await writeFile(
			path.join(dir, 'solid', 'app.config.ts'),
			'export default {};\n',
		);
		expect((await detectFramework(dir, 'solid'))?.id).toBe('solid-start');
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test('inspecting a package gives what classifying and detecting give separately', async () => {
	const packages = (await readWorkspace(repo.dir)).filter(
		pkg => pkg.path !== '',
	);
	expect(packages.length).toBeGreaterThan(5);
	for (const pkg of packages) {
		expect(await inspectPackage(repo.dir, pkg, new Set(), {})).toEqual({
			kind: await classifyPackage(repo.dir, pkg),
			framework: await detectFramework(repo.dir, pkg.path),
		});
	}
});

test('a library with strong signals still reports its framework when inspected', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-inspect-'));
	try {
		await mkdir(path.join(dir, 'ui'));
		await writeFile(
			path.join(dir, 'ui', 'package.json'),
			'{"name":"ui","version":"1.0.0","exports":"./index.js","dependencies":{"next":"^15.2.0"}}\n',
		);
		const pkg = {path: 'ui', name: 'ui', private: false} as WorkspacePackage;
		const inspected = await inspectPackage(dir, pkg, new Set(), {});
		expect(inspected.kind.kind).toBe('library');
		expect(inspected.framework?.id).toBe('next');
		expect(inspected.framework).toEqual(await detectFramework(dir, 'ui'));
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
