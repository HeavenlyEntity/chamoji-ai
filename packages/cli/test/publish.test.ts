import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import type {FetchLike, NpmRunner} from '@chamoji/core';
import type {GhRunner} from '../src/run.js';
import {
	createRepo,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

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

const TOKEN = 'npm_cliSecretToken456';

const repos: FixtureRepo[] = [];
afterEach(async () => {
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
});

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, '\t')}\n`;

const lib = (
	name: string,
	version: string,
	extra: Record<string, unknown> = {},
): string => json({name, version, main: 'index.js', ...extra});

const MONOREPO: Record<string, string> = {
	'package.json': json({name: 'acme', private: true}),
	'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
	'.gitignore': 'node_modules\n',
	'packages/core/package.json': lib('@acme/core', '1.0.0'),
	'packages/core/index.js': 'export {};\n',
	'packages/util/package.json': lib('@acme/util', '1.0.0'),
	'packages/util/index.js': 'export {};\n',
};

const NEXT_APP: Record<string, string> = {
	'apps/web/package.json': json({
		name: 'web',
		version: '1.0.0',
		dependencies: {next: '^15.0.0'},
	}),
	'apps/web/next.config.ts': 'export default {};\n',
};

async function repoWith(
	files: Record<string, string>,
	tags: string[],
): Promise<string> {
	const repo = await createRepo([
		{commit: '✨ Start', files},
		...tags.map(tag => ({tag})),
	]);
	repos.push(repo);
	return repo.dir;
}

/** A fake npm: `registry` answers `npm view`, and `publish` is recorded. */
function fakeNpm(registry: Record<string, string[]> = {}) {
	const calls: string[][] = [];
	const npm: NpmRunner = async args => {
		calls.push(args);
		if (args[0] === '--version')
			return {ok: true, stdout: '11.6.0', stderr: ''};
		if (args[0] === 'whoami') return {ok: true, stdout: 'dev', stderr: ''};
		if (args[0] === 'publish') return {ok: true, stdout: '', stderr: ''};
		if (args[0] === 'view') {
			const versions = registry[args[1]!];
			return versions
				? {
						ok: true,
						stdout: JSON.stringify({
							versions,
							'dist-tags': {latest: versions.at(-1)},
						}),
						stderr: '',
					}
				: {ok: false, stdout: '', stderr: 'npm error code E404'};
		}

		return {ok: false, stdout: '', stderr: `unexpected npm ${args.join(' ')}`};
	};

	return {npm, calls, published: () => calls.filter(c => c[0] === 'publish')};
}

const fetchNever: FetchLike = async () => {
	throw new Error('no network in tests');
};

async function chamoji(
	argv: string[],
	cwd: string,
	npm: NpmRunner,
	env: Record<string, string | undefined> = {CHAMOJI_NPM_TOKEN: TOKEN},
	gh?: GhRunner,
) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-10-28',
		fetchTags: false,
		npm,
		...(gh ? {gh} : {}),
		fetch: fetchNever,
		// An unset value removes the variable that the real environment has.
		env: {
			CI: undefined,
			ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
			CHAMOJI_NPM_TOKEN: undefined,
			...env,
		},
	});
	return {code, stdout, stderr};
}

const UNITS = json({
	release: {
		schema: 2,
		shape: 'libraries',
		units: {core: {path: 'packages/core'}, util: {path: 'packages/util'}},
	},
});

describe.skipIf(!has('npm'))('chamoji publish', () => {
	it('--dry-run lists each package, version, dist-tag and whether it is on npm', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0']});
		const {code, stdout} = await chamoji(
			['publish', '--dry-run'],
			dir,
			fake.npm,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('@acme/core 1.0.0 → latest: already on npm');
		expect(stdout).toContain('@acme/util 1.0.0 → latest: would publish');
		expect(fake.published()).toEqual([]);
		expect(stdout).not.toContain(TOKEN);
	});

	it('publishes and prints JSON', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm();
		const {code, stdout, stderr} = await chamoji(
			['publish', '--json'],
			dir,
			fake.npm,
		);

		expect(code).toBe(0);
		const result = JSON.parse(stdout) as {
			status: string;
			method: string;
			packages: Array<{name: string; status: string}>;
			skipped: unknown[];
		};
		expect(result.status).toBe('published');
		expect(result.method).toBe('token');
		expect(result.packages.map(p => [p.name, p.status])).toEqual([
			['@acme/core', 'published'],
			['@acme/util', 'published'],
		]);
		expect(result.skipped).toEqual([]);
		expect(fake.published()).toHaveLength(2);
		expect(stdout + stderr).not.toContain(TOKEN);
	});

	it('prints one line per package without --json', async () => {
		const dir = await repoWith({...MONOREPO, ...NEXT_APP}, ['v1.0.0']);
		const {code, stdout, stderr} = await chamoji(
			['publish'],
			dir,
			fakeNpm().npm,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('@acme/core 1.0.0 → latest: published');
		expect(stderr).toContain('web');
		expect(stderr).toContain('Next.js app');
	});

	it('exits 3 when everything is on npm', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0'], '@acme/util': ['1.0.0']});
		const {code, stdout, stderr} = await chamoji(['publish'], dir, fake.npm);

		expect(code).toBe(3);
		expect(stdout).toContain('@acme/core 1.0.0 → latest: already');
		expect(stderr).toContain('nothing to publish');
		expect(fake.published()).toEqual([]);
	});

	it('exits 2 and says why for a Next.js app tag', async () => {
		const config = json({
			release: {
				schema: 2,
				shape: 'apps',
				units: {web: {path: 'apps/web'}, core: {path: 'packages/core'}},
			},
		});
		const repo = await repoWith(
			{...MONOREPO, ...NEXT_APP, 'chamoji.config.json': config},
			['web/v1.0.0'],
		);
		const fake = fakeNpm();
		const {code, stderr} = await chamoji(
			['publish', '--from', 'web/v1.0.0'],
			repo,
			fake.npm,
		);

		expect(code).toBe(2);
		expect(stderr).toContain('looks like a Next.js app');
		expect(fake.published()).toEqual([]);
	});

	it('--from twice publishes both tags', async () => {
		const dir = await repoWith({...MONOREPO, 'chamoji.config.json': UNITS}, [
			'@acme/core@1.0.0',
			'@acme/util@1.0.0',
		]);
		const fake = fakeNpm();
		const {code, stdout} = await chamoji(
			['publish', '--from', '@acme/core@1.0.0', '--from', '@acme/util@1.0.0'],
			dir,
			fake.npm,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('@acme/core 1.0.0 → latest: published');
		expect(stdout).toContain('@acme/util 1.0.0 → latest: published');
		expect(fake.published()).toHaveLength(2);
	});

	it('--unit limits what is published', async () => {
		const dir = await repoWith({...MONOREPO, 'chamoji.config.json': UNITS}, [
			'@acme/core@1.0.0',
			'@acme/util@1.0.0',
		]);
		const fake = fakeNpm();
		const {code, stdout} = await chamoji(
			['publish', '--unit', 'util'],
			dir,
			fake.npm,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('@acme/util');
		expect(stdout).not.toContain('@acme/core');
	});

	it('exits 1 when a package fails to publish', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const base = fakeNpm();
		const npm: NpmRunner = async (args, options) =>
			args[0] === 'publish'
				? {ok: false, stdout: '', stderr: `E403 for ${TOKEN}`}
				: base.npm(args, options);
		const {code, stdout, stderr} = await chamoji(['publish'], dir, npm);

		expect(code).toBe(1);
		expect(stdout).toContain('@acme/core 1.0.0 → latest: failed');
		expect(stdout + stderr).not.toContain(TOKEN);
	});

	/** A recording fake gh: `releases` already exist; `view` of any other fails, `create` is recorded. */
	function fakeGh(existing: string[] = [], available = true) {
		const calls: string[][] = [];
		const gh: GhRunner = async args => {
			calls.push(args);
			if (!available)
				return {ok: false, message: 'no gh CLI, so no GitHub release'};
			if (args[1] === 'view') {
				return existing.includes(args[2]!)
					? {ok: true, message: ''}
					: {ok: false, message: 'release not found'};
			}

			return {ok: true, message: 'https://github.com/acme/x/releases/tag/x'};
		};

		return {gh, calls, created: () => calls.filter(c => c[1] === 'create')};
	}

	it('--catch-up publishes a release that never reached npm, then creates its GitHub release', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm();
		const gh = fakeGh();
		const {code, stdout, stderr} = await chamoji(
			['publish', '--catch-up'],
			dir,
			fake.npm,
			undefined,
			gh.gh,
		);

		expect(code).toBe(0);
		expect(fake.published()).toHaveLength(2);
		expect(stdout).toContain('v1.0.0: published 2');
		expect(stdout).toContain('GitHub release created');
		expect(gh.created()).toHaveLength(1);
		expect(gh.created()[0]!.slice(0, 3)).toEqual([
			'release',
			'create',
			'v1.0.0',
		]);
		expect(stdout + stderr).not.toContain(TOKEN);
	});

	it('--catch-up publishes what is missing from a tag whose other package is on npm', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0']});
		const {code, stdout} = await chamoji(
			['publish', '--catch-up'],
			dir,
			fake.npm,
			undefined,
			fakeGh(['v1.0.0']).gh,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('@acme/util 1.0.0 → latest: published');
		expect(stdout).toContain('v1.0.0: published 1, already on npm 1');
		expect(fake.published()).toHaveLength(1);
	});

	it('--catch-up with nothing missing exits 0 and creates nothing', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0'], '@acme/util': ['1.0.0']});
		const gh = fakeGh(['v1.0.0']);
		const {code, stdout} = await chamoji(
			['publish', '--catch-up'],
			dir,
			fake.npm,
			undefined,
			gh.gh,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('v1.0.0: nothing missing');
		expect(fake.published()).toEqual([]);
		expect(gh.created()).toEqual([]);
	});

	it('--catch-up creates a missing GitHub release when everything is already on npm', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0'], '@acme/util': ['1.0.0']});
		const gh = fakeGh();
		const {code, stdout} = await chamoji(
			['publish', '--catch-up'],
			dir,
			fake.npm,
			undefined,
			gh.gh,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('v1.0.0: nothing missing; GitHub release created');
		expect(gh.created()).toHaveLength(1);
	});

	it('--catch-up creates no GitHub release when gh is not available', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const gh = fakeGh([], false);
		const {code, stdout} = await chamoji(
			['publish', '--catch-up'],
			dir,
			fakeNpm().npm,
			undefined,
			gh.gh,
		);

		expect(code).toBe(0);
		expect(stdout).toContain('v1.0.0: published 2');
		expect(stdout).not.toContain('GitHub release created');
		expect(gh.created()).toEqual([]);
	});

	it('--catch-up keeps going after a failed tag and exits 1', async () => {
		const dir = await repoWith({...MONOREPO, 'chamoji.config.json': UNITS}, [
			'@acme/core@1.0.0',
			'@acme/util@1.0.0',
		]);
		const base = fakeNpm();
		const npm: NpmRunner = async (args, options) =>
			args[0] === 'publish' && args[1]!.includes('acme-core')
				? {ok: false, stdout: '', stderr: `E403 for ${TOKEN}`}
				: base.npm(args, options);
		const gh = fakeGh();
		const {code, stdout, stderr} = await chamoji(
			['publish', '--catch-up'],
			dir,
			npm,
			undefined,
			gh.gh,
		);

		expect(code).toBe(1);
		expect(stdout).toContain('@acme/core@1.0.0: failed 1');
		expect(stdout).toContain('@acme/util@1.0.0: published 1');
		expect(gh.created().map(c => c[2])).toEqual(['@acme/util@1.0.0']);
		expect(stdout + stderr).not.toContain(TOKEN);
	});

	it('--catch-up exits 1 for a tag that could not be checked', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const base = fakeNpm();
		const npm: NpmRunner = async (args, options) =>
			args[0] === 'view'
				? {ok: false, stdout: '', stderr: 'npm error code ETIMEDOUT'}
				: base.npm(args, options);
		const {code, stdout} = await chamoji(
			['publish', '--catch-up'],
			dir,
			npm,
			undefined,
			fakeGh().gh,
		);

		expect(code).toBe(1);
		expect(stdout).toContain('v1.0.0: error:');
	});

	it('--catch-up --json lists each tag', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const {code, stdout} = await chamoji(
			['publish', '--catch-up', '--json'],
			dir,
			fakeNpm().npm,
			undefined,
			fakeGh().gh,
		);

		expect(code).toBe(0);
		const result = JSON.parse(stdout) as {
			status: string;
			tags: Array<{tag: string; outcomes: Array<{status: string}>}>;
		};
		expect(result.status).toBe('caught-up');
		expect(result.tags).toHaveLength(1);
		expect(result.tags[0]!.tag).toBe('v1.0.0');
		expect(result.tags[0]!.outcomes.map(o => o.status)).toEqual([
			'published',
			'published',
		]);
	});

	it('--catch-up --json says nothing when nothing is missing', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0'], '@acme/util': ['1.0.0']});
		const {code, stdout} = await chamoji(
			['publish', '--catch-up', '--json'],
			dir,
			fake.npm,
			undefined,
			fakeGh(['v1.0.0']).gh,
		);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({status: 'nothing'});
	});

	it("--catch-up uses a unit tag's own notes for its GitHub release", async () => {
		const dir = await repoWith({...MONOREPO, 'chamoji.config.json': UNITS}, [
			'@acme/core@1.0.0',
		]);
		const gh = fakeGh();
		const {code} = await chamoji(
			['publish', '--catch-up'],
			dir,
			fakeNpm().npm,
			undefined,
			gh.gh,
		);

		expect(code).toBe(0);
		expect(gh.created().map(c => c[2])).toEqual(['@acme/core@1.0.0']);
	});

	it('--catch-up skips a public app unit and exits 0', async () => {
		const config = json({
			release: {
				schema: 2,
				shape: 'apps',
				units: {web: {path: 'apps/web'}, core: {path: 'packages/core'}},
			},
		});
		const dir = await repoWith(
			{...MONOREPO, ...NEXT_APP, 'chamoji.config.json': config},
			['web/v1.0.0'],
		);
		const fake = fakeNpm();
		const {code, stdout, stderr} = await chamoji(
			['publish', '--catch-up', '--json'],
			dir,
			fake.npm,
			undefined,
			fakeGh(['web/v1.0.0']).gh,
		);

		expect(code).toBe(0);
		const result = JSON.parse(stdout) as {
			status: string;
			tags: Array<{tag: string; error?: string; skipped: unknown[]}>;
		};
		expect(result.status).toBe('nothing');
		expect(result.tags[0]!.error).toBeUndefined();
		expect(result.tags[0]!.skipped).toEqual([
			{name: 'web', reason: expect.stringMatching(/^Next\.js app/) as string},
		]);
		expect(stderr).toContain('skipped web: Next.js app');
		expect(fake.published()).toEqual([]);
	});

	it('--catch-up refuses --from and --dry-run', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		for (const extra of [['--from', 'v1.0.0'], ['--dry-run']]) {
			// eslint-disable-next-line no-await-in-loop
			const {code, stderr} = await chamoji(
				['publish', '--catch-up', ...extra],
				dir,
				fakeNpm().npm,
			);
			expect(code).toBe(1);
			expect(stderr).toContain('--catch-up');
		}
	});
});

describe('changelog --from', () => {
	it('fails with the one-tag message when given twice', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const {code, stderr} = await chamoji(
			['changelog', '--from', 'v1.0.0', '--from', 'v0.9.0'],
			dir,
			fakeNpm().npm,
		);

		expect(code).toBe(1);
		expect(stderr).toContain('chamoji: --from takes one tag for changelog');
	});
});
