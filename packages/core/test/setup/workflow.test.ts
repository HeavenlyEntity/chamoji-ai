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
import {defaultBranch} from '../../src/git.js';
import {pnpmSetupVersion} from '../../src/publish/lockfile.js';
import {checkCommand} from '../../src/setup/package-scripts.js';
import {privatizeEdit} from '../../src/setup/privatize.js';
import {
	findReleaseWorkflow,
	releaseWorkflow,
	workflowLacking,
} from '../../src/setup/workflow.js';
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
          chamoji-version: '0.16.0'
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
			publishing: false,
		}),
	).toBe(OIDC_WORKFLOW);
});

test('a branch that is not plainly safe is quoted, a bad version refused', () => {
	const text = releaseWorkflow({
		branch: 'release/2026 #1',
		cliVersion: '0.16.0',
		ciAuth: 'oidc',
		packageManager: 'npm',
		publishing: false,
	});
	expect(text).toContain('branches: ["release/2026 #1"]');
	expect(text).toContain('ref: "release/2026 #1"');
	expect(() =>
		releaseWorkflow({
			branch: 'main',
			cliVersion: '1\n  evil: true',
			ciAuth: 'oidc',
			packageManager: 'npm',
			publishing: false,
		}),
	).toThrow("can't pin");
});

test('token method writes npm-token uncommented and keeps id-token: write', () => {
	const text = releaseWorkflow({
		branch: 'main',
		cliVersion: '0.16.0',
		ciAuth: 'token',
		packageManager: 'npm',
		publishing: false,
	});
	expect(text).toContain('          npm-token: ${{ secrets.NPM_TOKEN }}\n');
	expect(text).not.toContain('# npm-token');
	expect(text).toContain('  id-token: write\n');
});

/** The steps the generated workflow runs between checkout and the Action. */
function stepsBeforeAction(text: string): string {
	const from = text.indexOf('      - uses: actions/checkout@v4');
	const to = text.indexOf('      - uses: HeavenlyEntity/chamoji-ai@');
	return text.slice(from, to);
}

const CHECKOUT = `      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0
`;

const setupNode = (cache?: string) =>
	`      - uses: actions/setup-node@v4
        with:
          node-version: 24
${cache ? `          cache: ${cache}\n` : ''}`;

test.each([
	['npm', `${setupNode('npm')}      - run: npm ci\n`, undefined],
	[
		'pnpm',
		`      - uses: pnpm/action-setup@v4\n${setupNode('pnpm')}      - run: pnpm install --frozen-lockfile\n`,
		null,
	],
	[
		'yarn',
		`      - run: corepack enable\n${setupNode('yarn')}      - run: yarn install --immutable\n`,
		undefined,
	],
	[
		'bun',
		'      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n',
		undefined,
	],
] as const)(
	'with publishing on, %s sets up its manager and Node, then installs frozen; with it off, none of that',
	(packageManager, steps, pnpmVersion) => {
		const make = (publishing: boolean) =>
			releaseWorkflow({
				branch: 'main',
				cliVersion: '0.16.0',
				ciAuth: 'oidc',
				packageManager,
				publishing,
				pnpmVersion,
			});
		expect(stepsBeforeAction(make(true))).toBe(`${CHECKOUT}${steps}`);
		// Off: chamoji alone, whatever the package manager.
		expect(stepsBeforeAction(make(false))).toBe(CHECKOUT);
		expect(make(false)).toBe(OIDC_WORKFLOW);
		expect(make(true)).toContain("chamoji-version: '0.16.0'");
	},
);

test('pnpm/action-setup gets the version given when package.json has no packageManager', () => {
	const text = releaseWorkflow({
		branch: 'main',
		cliVersion: '0.16.0',
		ciAuth: 'oidc',
		packageManager: 'pnpm',
		publishing: true,
		pnpmVersion: 8,
	});
	expect(text).toContain(
		'      - uses: pnpm/action-setup@v4\n        with:\n          version: 8\n      - uses: actions/setup-node@v4',
	);
});

test('pnpmSetupVersion: none with packageManager, else from the lockfile version, else 10', async () => {
	const withFiles = async (files: Record<string, string>) => {
		const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-pnpm-'));
		made.push({cleanup: async () => rm(dir, {recursive: true, force: true})});
		for (const [name, text] of Object.entries(files)) {
			// eslint-disable-next-line no-await-in-loop
			await writeFile(path.join(dir, name), text);
		}

		return dir;
	};

	const lock = (version: string) => `lockfileVersion: '${version}'\n`;
	expect(
		await pnpmSetupVersion(
			await withFiles({
				'package.json': '{"packageManager":"pnpm@9.1.0"}',
				'pnpm-lock.yaml': lock('9.0'),
			}),
		),
	).toBeNull();
	for (const [version, major] of [
		['9.0', 10],
		['6.0', 8],
		['6.1', 8],
		['5.4', 7],
		['7.0', 10],
		['10.0', 10],
	] as const) {
		expect(
			// eslint-disable-next-line no-await-in-loop
			await pnpmSetupVersion(
				// eslint-disable-next-line no-await-in-loop
				await withFiles({
					'package.json': '{"name":"x"}',
					'pnpm-lock.yaml': lock(version),
				}),
			),
		).toBe(major);
	}

	expect(await pnpmSetupVersion(await withFiles({}))).toBe(10);
	expect(
		await pnpmSetupVersion(
			await withFiles({'pnpm-lock.yaml': 'lockfileVersion: 9.0\n'}),
		),
	).toBe(10);
});

async function withWorkflows(files: Record<string, string>): Promise<string> {
	return repo([{commit: '🎉 Start', files}]);
}

test('findReleaseWorkflow finds a hand-written workflow using the Action', async () => {
	const dir = await withWorkflows({
		'.github/workflows/ci.yml': 'name: ci\non: push\n',
		'.github/workflows/publish.yaml': `on:
  push:
    branches: [main]
jobs:
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
			'.github/workflows/r.yml': `on: workflow_dispatch\njobs:\n  r:\n    steps:\n      - run: ${line}\n`,
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

const LACK = {branch: 'main', merge: true, publishing: true};

test('workflowLacking: the generated file has it all; a bare Action step lacks the rest', () => {
	expect(workflowLacking(OIDC_WORKFLOW, {...LACK, ciAuth: 'oidc'})).toEqual([]);
	// The generated file comments the token out, so the token method lacks it.
	expect(workflowLacking(OIDC_WORKFLOW, {...LACK, ciAuth: 'token'})).toEqual([
		'with: npm-token: ${{ secrets.NPM_TOKEN }}',
	]);
	expect(
		workflowLacking(OIDC_WORKFLOW.replace('# npm-token', 'npm-token'), {
			...LACK,
			ciAuth: 'token',
		}),
	).toEqual([]);
	expect(
		workflowLacking(
			'on: workflow_dispatch\njobs:\n  r:\n    steps:\n      - uses: HeavenlyEntity/chamoji-ai@v0.15.0\n',
			{...LACK, ciAuth: 'oidc'},
		),
	).toEqual([
		'on: push: branches: [main]',
		'permissions: contents: write',
		'permissions: id-token: write',
		'with: release-version: ${{ inputs.version }}',
	]);
	// Without a merge trigger, the push trigger isn't asked for.
	expect(
		workflowLacking(
			OIDC_WORKFLOW.replace('  push:\n    branches: [main]\n', ''),
			{
				...LACK,
				merge: false,
				ciAuth: 'oidc',
			},
		),
	).toEqual([]);
	// Without publishing, id-token: write isn't asked for.
	const bare =
		'on: workflow_dispatch\njobs:\n  r:\n    steps:\n      - uses: HeavenlyEntity/chamoji-ai@v0.15.0\n';
	expect(
		workflowLacking(bare, {...LACK, publishing: false, ciAuth: 'oidc'}),
	).not.toContain('permissions: id-token: write');
	expect(workflowLacking(bare, {...LACK, ciAuth: 'oidc'})).toContain(
		'permissions: id-token: write',
	);
});

const NOTES = `name: changelog
on:
  pull_request:
  push:
    tags: ['v*']
jobs:
  chamoji:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: HeavenlyEntity/chamoji-ai@v0.14.0
`;

test('T6-a: a notes and PR-comment workflow does not count; the Action on push to main does', async () => {
	const notes = await withWorkflows({'.github/workflows/changelog.yml': NOTES});
	expect(await findReleaseWorkflow(notes)).toBeNull();
	const onMain = await withWorkflows({
		'.github/workflows/changelog.yml': NOTES,
		'.github/workflows/release.yml': NOTES.replace(
			"  push:\n    tags: ['v*']",
			'  push:\n    branches: [main]',
		),
	});
	expect(await findReleaseWorkflow(onMain)).toEqual({
		file: '.github/workflows/release.yml',
		ciAuth: 'oidc',
	});
	// Another branch's push, or a different branch name, doesn't count.
	const other = await withWorkflows({
		'.github/workflows/release.yml': NOTES.replace(
			"  push:\n    tags: ['v*']",
			'  push:\n    branches: [dev]',
		),
	});
	expect(await findReleaseWorkflow(other)).toBeNull();
	expect(await findReleaseWorkflow(other, 'dev')).not.toBeNull();
});

test('T6-a: workflow_dispatch alone counts, and a file that does not parse is matched by text', async () => {
	const dispatch = await withWorkflows({
		'.github/workflows/d.yml': NOTES.replace(
			"  pull_request:\n  push:\n    tags: ['v*']",
			'  workflow_dispatch:',
		),
	});
	expect((await findReleaseWorkflow(dispatch))?.file).toBe(
		'.github/workflows/d.yml',
	);
	const broken = await withWorkflows({
		'.github/workflows/b.yml':
			'steps: [\n  uses: HeavenlyEntity/chamoji-ai@v1\n',
	});
	expect((await findReleaseWorkflow(broken))?.file).toBe(
		'.github/workflows/b.yml',
	);
});

test('privatizeEdit never flips a nested "private": false', async () => {
	const nested = await withManifest(
		'{\n\t"name": "web",\n\t"version": "1.0.0",\n\t"x": {\n\t\t"private": false\n\t}\n}\n',
	);
	expect((await privatizeEdit(nested, 'apps/web')).text).toBe(
		'{\n\t"name": "web",\n\t"version": "1.0.0",\n\t"private": true,\n\t"x": {\n\t\t"private": false\n\t}\n}\n',
	);
	const both = await withManifest(
		'{\n\t"name": "web",\n\t"x": {\n\t\t"private": false\n\t},\n\t"private": false\n}\n',
	);
	expect((await privatizeEdit(both, 'apps/web')).text).toBe(
		'{\n\t"name": "web",\n\t"x": {\n\t\t"private": false\n\t},\n\t"private": true\n}\n',
	);
});

test('privatizeEdit makes a minified false, or a non-boolean private, true', async () => {
	const minified = await withManifest(
		'{"name":"web","version":"1.0.0","private":false}\n',
	);
	const {text} = await privatizeEdit(minified, 'apps/web');
	expect(JSON.parse(text)).toEqual({
		name: 'web',
		version: '1.0.0',
		private: true,
	});
	const string = await withManifest(
		'{\n\t"name": "web",\n\t"version": "1.0.0",\n\t"private": "false"\n}\n',
	);
	expect(JSON.parse((await privatizeEdit(string, 'apps/web')).text)).toEqual({
		name: 'web',
		version: '1.0.0',
		private: true,
	});
});
