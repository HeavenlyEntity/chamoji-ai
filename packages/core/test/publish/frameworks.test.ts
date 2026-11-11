import {afterAll, beforeAll, expect, test} from 'vitest';
import {
	classifyPackage,
	detectFramework,
	FRAMEWORKS,
	type WorkspacePackage,
} from '../../src/index.js';
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
