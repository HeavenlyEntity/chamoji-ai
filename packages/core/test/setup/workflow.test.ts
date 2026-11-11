import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	checkCommand,
	defaultBranch,
	findReleaseWorkflow,
	privatizeEdit,
	releaseWorkflow,
	workflowLacks,
} from '../../src/index.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../helpers/fixture-repo.js';

const made: Array<{cleanup(): Promise<void>}> = [];
afterEach(async () => {
	for (const each of made.splice(0)) await each.cleanup();
});

async function withScripts(scripts: Record<string, string>) {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-workflow-'));
	made.push({cleanup: async () => rm(dir, {recursive: true, force: true})});
	await writeFile(path.join(dir, 'package.json'), JSON.stringify({scripts}));
	return dir;
}

const repo = async (steps: Parameters<typeof createRepo>[0]) => {
	const fixture: FixtureRepo = await createRepo(steps);
	made.push(fixture);
	return fixture.dir;
};

test('checkCommand per package manager', async () => {
	const both = await withScripts({check: 'tsc', test: 'vitest', build: 'tsup'});
	expect(await checkCommand(both, 'npm')).toBe('npm run check && npm test');
	expect(await checkCommand(both, 'pnpm')).toBe('pnpm check && pnpm test');
	// A bare `yarn check` or `bun test` is the tool's own command, so they say run.
	expect(await checkCommand(both, 'yarn')).toBe(
		'yarn run check && yarn run test',
	);
	expect(await checkCommand(both, 'bun')).toBe('bun run check && bun run test');
	const testOnly = await withScripts({test: 'vitest', build: 'tsup'});
	expect(await checkCommand(testOnly, 'pnpm')).toBe('pnpm test');
	expect(await checkCommand(testOnly, 'npm')).toBe('npm test');
	const checkOnly = await withScripts({check: 'tsc'});
	expect(await checkCommand(checkOnly, 'npm')).toBe('npm run check');
});

test('checkCommand falls back to build, then to nothing', async () => {
	const build = await withScripts({build: 'tsup', lint: 'eslint'});
	expect(await checkCommand(build, 'pnpm')).toBe('pnpm build');
	expect(await checkCommand(build, 'npm')).toBe('npm run build');
	const none = await withScripts({lint: 'eslint'});
	expect(await checkCommand(none, 'pnpm')).toBeNull();
	const empty = await mkdtemp(path.join(tmpdir(), 'chamoji-workflow-'));
	made.push({cleanup: async () => rm(empty, {recursive: true, force: true})});
	expect(await checkCommand(empty, 'npm')).toBeNull();
});

test('defaultBranch from origin/HEAD, else current, else main', async () => {
	// No origin: the current branch.
	const dir = await repo([{commit: '🎉 Start'}]);
	expect(await defaultBranch(dir)).toBe('main');
	await gitOutput(dir, ['switch', '-q', '-c', 'trunk']);
	expect(await defaultBranch(dir)).toBe('trunk');

	// origin/HEAD wins over where the clone is now.
	await gitOutput(dir, ['switch', '-q', 'main']);
	const clone = await createRepo([], {clone: dir});
	made.push(clone);
	await gitOutput(clone.dir, ['switch', '-q', '-c', 'feature']);
	expect(await defaultBranch(clone.dir)).toBe('main');

	// A detached HEAD with no origin: main.
	const detached = await repo([{commit: '🎉 Start'}]);
	await gitOutput(detached, ['checkout', '-q', '--detach']);
	expect(await defaultBranch(detached)).toBe('main');
});

const OIDC_WORKFLOW = `name: release
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        description: The version to release; empty picks it from the commits
        required: false
concurrency:
  group: chamoji-release
  cancel-in-progress: false
permissions:
  contents: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0
      - uses: HeavenlyEntity/chamoji-ai@v0.16.0
        with:
          release-version: \${{ inputs.version }}
          # npm-token: \${{ secrets.NPM_TOKEN }}
`;

test('the generated workflow matches the spec shape', () => {
	expect(
		releaseWorkflow({
			branch: 'main',
			cliVersion: '0.16.0',
			ciAuth: 'oidc',
			packageManager: 'npm',
		}),
	).toBe(OIDC_WORKFLOW);
});

test('a branch that is not plainly safe is quoted, a bad version refused', () => {
	const text = releaseWorkflow({
		branch: 'release/2026 #1',
		cliVersion: '0.16.0',
		ciAuth: 'oidc',
		packageManager: 'npm',
	});
	expect(text).toContain('branches: ["release/2026 #1"]');
	expect(text).toContain('ref: "release/2026 #1"');
	expect(() =>
		releaseWorkflow({
			branch: 'main',
			cliVersion: '1\n  evil: true',
			ciAuth: 'oidc',
			packageManager: 'npm',
		}),
	).toThrow("can't pin");
});

test('token method writes npm-token uncommented and keeps id-token: write', () => {
	const text = releaseWorkflow({
		branch: 'main',
		cliVersion: '0.16.0',
		ciAuth: 'token',
		packageManager: 'npm',
	});
	expect(text).toContain('          npm-token: ${{ secrets.NPM_TOKEN }}\n');
	expect(text).not.toContain('# npm-token');
	expect(text).toContain('  id-token: write\n');
});

test('pnpm adds pnpm/action-setup@v4 before the Action; bun adds oven-sh/setup-bun@v2; yarn adds `corepack enable`', () => {
	const make = (packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun') =>
		releaseWorkflow({
			branch: 'main',
			cliVersion: '0.16.0',
			ciAuth: 'oidc',
			packageManager,
		});
	const before = (text: string, step: string) => {
		expect(text).toContain(step);
		expect(text.indexOf(step)).toBeLessThan(
			text.indexOf('HeavenlyEntity/chamoji-ai@v0.16.0'),
		);
		expect(text.indexOf(step)).toBeGreaterThan(
			text.indexOf('actions/checkout@v4'),
		);
	};

	before(make('pnpm'), '- uses: pnpm/action-setup@v4');
	before(make('bun'), '- uses: oven-sh/setup-bun@v2');
	before(make('yarn'), '- run: corepack enable');
	expect(make('npm')).toBe(OIDC_WORKFLOW);
});

async function withWorkflows(files: Record<string, string>): Promise<string> {
	return repo([{commit: '🎉 Start', files}]);
}

test('findReleaseWorkflow finds a hand-written workflow using the Action', async () => {
	const dir = await withWorkflows({
		'.github/workflows/ci.yml': 'name: ci\non: push\n',
		'.github/workflows/publish.yaml': `jobs:
  x:
    steps:
      - uses: HeavenlyEntity/chamoji-ai@v0.15.0
        with:
          npm-token: \${{ secrets.NPM_TOKEN }}
`,
	});
	expect(await findReleaseWorkflow(dir)).toEqual({
		file: '.github/workflows/publish.yaml',
		ciAuth: 'token',
	});
});

test('findReleaseWorkflow reads the sign-in: a commented npm-token is trusted publishing', async () => {
	const dir = await withWorkflows({
		'.github/workflows/release.yml': OIDC_WORKFLOW,
	});
	expect(await findReleaseWorkflow(dir)).toEqual({
		file: '.github/workflows/release.yml',
		ciAuth: 'oidc',
	});
});

test('findReleaseWorkflow also knows a CLI release step', async () => {
	for (const line of ['npx @chamoji/cli release --push', 'chamoji release']) {
		// eslint-disable-next-line no-await-in-loop
		const dir = await withWorkflows({
			'.github/workflows/r.yml': `steps:\n  - run: ${line}\n`,
		});
		// eslint-disable-next-line no-await-in-loop
		expect(await findReleaseWorkflow(dir)).toEqual({
			file: '.github/workflows/r.yml',
			ciAuth: 'oidc',
		});
	}
});

test('findReleaseWorkflow ignores untracked files, other folders and a workflow that does not run chamoji', async () => {
	const dir = await withWorkflows({
		'.github/workflows/ci.yml': 'name: ci\n',
		'docs/r.yml': 'chamoji release\n',
	});
	await writeFile(
		path.join(dir, '.github/workflows/untracked.yml'),
		'chamoji release\n',
	);
	expect(await findReleaseWorkflow(dir)).toBeNull();
});

const manifest = (indent: string, withVersion = true) =>
	`{\n${indent}"name": "web",\n${withVersion ? `${indent}"version": "1.2.3",\n` : ''}${indent}"scripts": {\n${indent}${indent}"build": "x"\n${indent}}\n}\n`;

async function withManifest(text: string, rel = 'apps/web'): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-privatize-'));
	made.push({cleanup: async () => rm(dir, {recursive: true, force: true})});
	await mkdir(path.join(dir, rel), {recursive: true});
	await writeFile(path.join(dir, rel, 'package.json'), text);
	return dir;
}

test('privatizeEdit keeps tabs and key order', async () => {
	const dir = await withManifest(manifest('\t'));
	const change = await privatizeEdit(dir, 'apps/web');
	expect(change.file).toBe('apps/web/package.json');
	expect(change.text).toBe(
		'{\n\t"name": "web",\n\t"version": "1.2.3",\n\t"private": true,\n\t"scripts": {\n\t\t"build": "x"\n\t}\n}\n',
	);
	expect(JSON.parse(change.text)).toMatchObject({private: true});
});

test('privatizeEdit goes after name when there is no version, keeps two-space indents and CRLF', async () => {
	const dir = await withManifest(
		manifest('  ', false).replaceAll('\n', '\r\n'),
	);
	const {text} = await privatizeEdit(dir, 'apps/web');
	expect(text).toBe(
		'{\r\n  "name": "web",\r\n  "private": true,\r\n  "scripts": {\r\n    "build": "x"\r\n  }\r\n}\r\n',
	);
});

test('privatizeEdit on the root package, a minified file, false and already true', async () => {
	const root = await withManifest(manifest('\t'), '');
	expect((await privatizeEdit(root, '')).file).toBe('package.json');

	const minified = await withManifest('{"name":"web","version":"1.0.0"}\n');
	expect((await privatizeEdit(minified, 'apps/web')).text).toBe(
		'{\n\t"name": "web",\n\t"version": "1.0.0",\n\t"private": true\n}\n',
	);

	const off = await withManifest(
		'{\n\t"name": "web",\n\t"private": false\n}\n',
	);
	expect((await privatizeEdit(off, 'apps/web')).text).toBe(
		'{\n\t"name": "web",\n\t"private": true\n}\n',
	);

	const already = await withManifest(
		'{\n\t"name": "web",\n\t"private": true\n}\n',
	);
	const same = await privatizeEdit(already, 'apps/web');
	expect(same.text).toBe('{\n\t"name": "web",\n\t"private": true\n}\n');
});

test.skipIf(process.platform === 'win32')(
	'privatizeEdit refuses a symlinked package.json or folder',
	async () => {
		const dir = await withManifest(manifest('\t'), 'real');
		await mkdir(path.join(dir, 'apps/web'), {recursive: true});
		await symlink(
			path.join(dir, 'real/package.json'),
			path.join(dir, 'apps/web/package.json'),
		);
		await expect(privatizeEdit(dir, 'apps/web')).rejects.toThrow(
			'apps/web/package.json is a symlink',
		);
		await symlink(path.join(dir, 'real'), path.join(dir, 'apps/linked'));
		await expect(privatizeEdit(dir, 'apps/linked')).rejects.toThrow(
			'apps/linked is a symlink',
		);
		expect(await readFile(path.join(dir, 'real/package.json'), 'utf8')).toBe(
			manifest('\t'),
		);
	},
);

test('workflowLacks: the generated file has it all; a bare Action step does not', () => {
	expect(workflowLacks(OIDC_WORKFLOW, 'oidc')).toBe(false);
	// The generated file comments the token out, so the token method lacks it.
	expect(workflowLacks(OIDC_WORKFLOW, 'token')).toBe(true);
	expect(
		workflowLacks(OIDC_WORKFLOW.replace('# npm-token', 'npm-token'), 'token'),
	).toBe(false);
	expect(
		workflowLacks(
			'steps:\n  - uses: HeavenlyEntity/chamoji-ai@v0.15.0\n',
			'oidc',
		),
	).toBe(true);
});
