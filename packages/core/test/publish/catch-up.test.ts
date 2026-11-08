import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {
	catchUp,
	DEFAULT_GROUP_CONFIG,
	latestReleaseTags,
	parseReleaseSettings,
	processEnv,
	type FetchLike,
	type NpmRunner,
} from '../../src/index.js';
import type {ChamojiConfig} from '../../src/types.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';

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

const TOKEN = 'npm_catchUpSecret789';

const repos: FixtureRepo[] = [];
afterEach(async () => {
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
});

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, '\t')}\n`;

const lib = (name: string, version: string): string =>
	json({name, version, main: 'index.js'});

const MONOREPO: Record<string, string> = {
	'package.json': json({name: 'acme', private: true}),
	'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
	'.gitignore': 'node_modules\n',
	'packages/core/package.json': lib('@acme/core', '1.0.0'),
	'packages/core/index.js': 'export {};\n',
	'packages/util/package.json': lib('@acme/util', '1.0.0'),
	'packages/util/index.js': 'export {};\n',
};

const UNITS = {
	schema: 2,
	shape: 'libraries',
	units: {core: {path: 'packages/core'}, util: {path: 'packages/util'}},
};

function config(release?: Record<string, unknown>): ChamojiConfig {
	return {
		groups: DEFAULT_GROUP_CONFIG,
		...(release
			? {release: parseReleaseSettings(release, 'chamoji.config.json')}
			: {}),
	};
}

async function repoWith(tags: string[]): Promise<string> {
	const repo = await createRepo([
		{commit: '✨ Start', files: MONOREPO},
		...tags.map(tag => ({tag})),
	]);
	repos.push(repo);
	return repo.dir;
}

/** A fake npm: `registry` answers `npm view`; publishes are recorded and may fail. */
function fakeNpm(
	registry: Record<string, string[]> = {},
	failing: string[] = [],
) {
	const calls: string[][] = [];
	const npm: NpmRunner = async args => {
		calls.push(args);
		if (args[0] === 'whoami') return {ok: true, stdout: 'dev', stderr: ''};
		if (args[0] === 'publish') {
			return failing.some(name => args[1]!.includes(name))
				? {ok: false, stdout: '', stderr: 'E403 forbidden'}
				: {ok: true, stdout: '', stderr: ''};
		}

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

	return {npm, published: () => calls.filter(c => c[0] === 'publish')};
}

const fetchNever: FetchLike = async () => {
	throw new Error('no network in tests');
};

const env = (): Record<string, string> => ({
	...processEnv(),
	CHAMOJI_NPM_TOKEN: TOKEN,
});

describe('latestReleaseTags', () => {
	it('returns one tag per unit', async () => {
		const dir = await repoWith([
			'@acme/core@0.9.0',
			'@acme/core@1.0.0',
			'@acme/util@1.0.0',
		]);

		expect((await latestReleaseTags(dir, config(UNITS))).sort()).toEqual([
			'@acme/core@1.0.0',
			'@acme/util@1.0.0',
		]);
	});

	it('returns the newest version tag in a single repo', async () => {
		const dir = await repoWith(['v0.9.0', 'v1.0.0', 'v1.0.0-rc.1']);

		expect(await latestReleaseTags(dir, config())).toEqual(['v1.0.0']);
	});

	it('returns nothing when no release was tagged', async () => {
		const dir = await repoWith([]);

		expect(await latestReleaseTags(dir, config())).toEqual([]);
	});
});

describe.skipIf(!has('npm') || !has('pnpm'))('catchUp', () => {
	const options = (
		dir: string,
		cfg: ChamojiConfig,
		fake: {npm: NpmRunner},
	) => ({
		cwd: dir,
		config: cfg,
		npm: fake.npm,
		env: env(),
		fetch: fetchNever,
		ci: false,
	});

	it('publishes a tag whose second package is missing', async () => {
		const dir = await repoWith(['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0']});

		const results = await catchUp(options(dir, config(), fake));

		expect(results).toHaveLength(1);
		expect(results[0]!.tag).toBe('v1.0.0');
		expect(results[0]!.error).toBeUndefined();
		expect(
			results[0]!.outcomes.map(o => `${o.name}:${o.status}`).sort(),
		).toEqual(['@acme/core:already', '@acme/util:published']);
		expect(fake.published()).toHaveLength(1);
	});

	it('keeps going after a tag that fails', async () => {
		const dir = await repoWith(['@acme/core@1.0.0', '@acme/util@1.0.0']);
		const base = fakeNpm();
		// An unreachable registry fails core's plan, which is an error for its tag.
		const npm: NpmRunner = async (args, runOptions) =>
			args[0] === 'view' && args[1] === '@acme/core'
				? {ok: false, stdout: '', stderr: 'npm error code ETIMEDOUT'}
				: base.npm(args, runOptions);

		const results = await catchUp(options(dir, config(UNITS), {npm}));
		const byTag = new Map(results.map(r => [r.tag, r]));

		expect(byTag.get('@acme/core@1.0.0')!.error).toBeTruthy();
		expect(byTag.get('@acme/util@1.0.0')!.error).toBeUndefined();
		expect(byTag.get('@acme/util@1.0.0')!.outcomes[0]!.status).toBe(
			'published',
		);
		expect(base.published()).toHaveLength(1);
	});

	it('reports a failed publish as an outcome and still does the other tag', async () => {
		const dir = await repoWith(['@acme/core@1.0.0', '@acme/util@1.0.0']);
		const fake = fakeNpm({}, ['acme-core']);

		const results = await catchUp(options(dir, config(UNITS), fake));
		const byTag = new Map(results.map(r => [r.tag, r]));

		expect(byTag.get('@acme/core@1.0.0')!.outcomes[0]!.status).toBe('failed');
		expect(byTag.get('@acme/util@1.0.0')!.outcomes[0]!.status).toBe(
			'published',
		);
		expect(JSON.stringify(results)).not.toContain(TOKEN);
	});

	it('does nothing for a tag whose packages are all on npm', async () => {
		const dir = await repoWith(['v1.0.0']);
		const fake = fakeNpm({'@acme/core': ['1.0.0'], '@acme/util': ['1.0.0']});

		const results = await catchUp(options(dir, config(), fake));

		expect(results).toHaveLength(1);
		expect(results[0]!.outcomes.every(o => o.status === 'already')).toBe(true);
		expect(fake.published()).toEqual([]);
	});

	it('skips never-published packages under trusted publishing', async () => {
		const dir = await repoWith(['v1.0.0']);
		const fake = fakeNpm();

		const results = await catchUp({
			...options(dir, config(), fake),
			env: {
				...processEnv(),
				ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/token?x=1',
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
			},
			ci: true,
		});

		expect(results[0]!.error).toBeUndefined();
		expect(results[0]!.outcomes.map(o => o.status)).toEqual([
			'skipped',
			'skipped',
		]);
		expect(fake.published()).toEqual([]);
	});

	const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/core: {}

  packages/util: {}
`;

	/** A tag with a commit after it, so the tag is behind HEAD. */
	async function repoBehind(lockfile = true): Promise<string> {
		const repo = await createRepo([
			{
				commit: '✨ Start',
				files: lockfile ? {...MONOREPO, 'pnpm-lock.yaml': LOCK} : MONOREPO,
			},
			{tag: 'v1.0.0'},
			{commit: '✨ More', files: {'README.md': 'more\n'}},
		]);
		repos.push(repo);
		return repo.dir;
	}

	const worktrees = (dir: string): string[] =>
		execFileSync('git', ['worktree', 'list', '--porcelain'], {
			cwd: dir,
			encoding: 'utf8',
		})
			.split('\n')
			.filter(line => line.startsWith('worktree '));

	it('finds nothing missing for a tag behind HEAD without a worktree or install', async () => {
		// No lockfile: an install would fail, so only the cheap check can pass.
		const dir = await repoBehind(false);
		const fake = fakeNpm({'@acme/core': ['1.0.0'], '@acme/util': ['1.0.0']});
		const calls: string[][] = [];
		const npm: NpmRunner = async (args, runOptions) => {
			calls.push(args);
			return fake.npm(args, runOptions);
		};

		const results = await catchUp(options(dir, config(), {npm}));

		expect(results).toHaveLength(1);
		expect(results[0]!.error).toBeUndefined();
		expect(results[0]!.outcomes.map(o => o.status)).toEqual([
			'already',
			'already',
		]);
		expect(worktrees(dir)).toHaveLength(1);
		expect(calls.every(c => c[0] === 'view')).toBe(true);
		expect(fake.published()).toEqual([]);
	});

	it('publishes the missing package of a tag behind HEAD from a worktree and removes it', async () => {
		const dir = await repoBehind();
		const fake = fakeNpm({'@acme/core': ['1.0.0']});

		const results = await catchUp(options(dir, config(), fake));

		expect(results[0]!.error).toBeUndefined();
		expect(
			results[0]!.outcomes.map(o => `${o.name}:${o.status}`).sort(),
		).toEqual(['@acme/core:already', '@acme/util:published']);
		expect(fake.published()).toHaveLength(1);
		expect(worktrees(dir)).toHaveLength(1);
	});
});
