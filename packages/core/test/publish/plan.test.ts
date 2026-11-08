import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	DEFAULT_GROUP_CONFIG,
	DEFAULT_REGISTRY,
	discardPublishPlan,
	parseReleaseSettings,
	planPublish,
	mask,
	ReleaseError,
	scrubEnv,
	type NpmRunner,
	type PublishOptions,
	type PublishPlan,
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

const repos: FixtureRepo[] = [];
const plans: PublishPlan[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		plans.splice(0).map(async plan => discardPublishPlan(plan)),
	);
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
	await Promise.all(
		dirs.splice(0).map(async dir => rm(dir, {recursive: true, force: true})),
	);
});

const json = (value: unknown): string =>
	`${JSON.stringify(value, null, '\t')}\n`;

function config(release?: Record<string, unknown>): ChamojiConfig {
	return {
		groups: DEFAULT_GROUP_CONFIG,
		...(release
			? {release: parseReleaseSettings(release, 'chamoji.config.json')}
			: {}),
	};
}

/** A fake npm that answers `npm view` from `registry`, and E404 otherwise. */
function fakeNpm(
	registry: Record<string, {versions: string[]; latest: string}> = {},
): NpmRunner & {calls: string[][]} {
	const calls: string[][] = [];
	const run: NpmRunner = async args => {
		calls.push(args);
		if (args[0] === 'view') {
			const known = registry[args[1]!];
			if (!known) {
				return {
					ok: false,
					stdout: '',
					stderr: 'npm error code E404\nnpm error 404 Not Found',
				};
			}

			return {
				ok: true,
				stdout: JSON.stringify({
					versions: known.versions,
					'dist-tags': {latest: known.latest},
				}),
				stderr: '',
			};
		}

		return {ok: false, stdout: '', stderr: `unexpected npm ${args.join(' ')}`};
	};
	return Object.assign(run, {calls});
}

const lib = (
	name: string,
	version: string,
	extra: Record<string, unknown> = {},
): string => json({name, version, main: 'index.js', ...extra});

/** Like chamoji-ai: a private root, and core and cli at 1.0.0. */
const MONOREPO: Record<string, string> = {
	'package.json': json({name: 'acme', private: true}),
	'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
	'.gitignore': 'node_modules\n',
	'packages/core/package.json': lib('@acme/core', '1.0.0'),
	'packages/core/index.js': 'export {};\n',
	'packages/cli/package.json': lib('@acme/cli', '1.0.0', {
		dependencies: {'@acme/core': '^1.0.0'},
	}),
	'packages/cli/index.js': 'export {};\n',
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

async function plan(
	options: Partial<PublishOptions> & {cwd: string},
): Promise<PublishPlan> {
	const made = await planPublish({
		config: config(),
		npm: fakeNpm(),
		env: {},
		...options,
	});
	plans.push(made);
	return made;
}

const names = (made: PublishPlan): string[] =>
	made.targets.map(target => target.name);

describe.skipIf(!has('npm'))('planPublish', () => {
	it('single repo publishes every public package at the released version', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const made = await plan({cwd: dir});

		expect(names(made)).toEqual(['@acme/core', '@acme/cli']);
		expect(made.pm).toBe('npm');
		expect(made.worktree).toBeNull();
		for (const target of made.targets) {
			expect(target).toMatchObject({
				version: '1.0.0',
				tag: 'v1.0.0',
				registry: DEFAULT_REGISTRY,
				distTag: 'latest',
				access: null,
				published: false,
				firstVersion: true,
			});
			expect(existsSync(target.tarball)).toBe(true);
			expect(path.dirname(target.tarball)).toBe(made.workdir);
		}
	});

	it('skips a public Next.js app and names why', async () => {
		const dir = await repoWith({...MONOREPO, ...NEXT_APP}, ['v1.0.0']);
		const made = await plan({cwd: dir});

		expect(names(made)).toEqual(['@acme/core', '@acme/cli']);
		expect(made.skipped).toContainEqual({
			name: 'web',
			reason: expect.stringMatching(
				/^Next\.js app \(`next` in dependencies, `next\.config\.ts`\)$/,
			) as string,
		});
	});

	it('an app named in --from is refused', async () => {
		const dir = await repoWith({...MONOREPO, ...NEXT_APP}, ['web/v1.0.0']);
		const release = {
			schema: 2,
			shape: 'apps',
			units: {web: {path: 'apps/web'}, core: {path: 'packages/core'}},
		};
		const refused = plan({
			cwd: dir,
			config: config(release),
			from: ['web/v1.0.0'],
		});

		await expect(refused).rejects.toThrow(ReleaseError);
		await expect(refused).rejects.toThrow(
			'apps/web looks like a Next.js app (`next` in dependencies, `next.config.ts`), and apps aren\'t published. Mark it `"private": true`, or list it in `release.publish.packages` if it really is a package.',
		);
	});

	it('publish.packages lets an app through', async () => {
		const dir = await repoWith({...MONOREPO, ...NEXT_APP}, ['v1.0.0']);
		const made = await plan({
			cwd: dir,
			config: config({
				schema: 2,
				shape: 'single',
				publish: {packages: ['web']},
			}),
		});

		expect(names(made)).toContain('web');
		expect(made.skipped).toEqual([]);
	});

	it('refuses a dependency on a private workspace package', async () => {
		const dir = await repoWith(
			{
				...MONOREPO,
				'packages/util/package.json': json({
					name: '@acme/util',
					version: '1.0.0',
					private: true,
				}),
				'packages/cli/package.json': lib('@acme/cli', '1.0.0', {
					dependencies: {'@acme/core': '^1.0.0', '@acme/util': '^1.0.0'},
				}),
			},
			['v1.0.0'],
		);
		const refused = plan({cwd: dir});

		await expect(refused).rejects.toMatchObject({code: 'publish-check'});
		await expect(refused).rejects.toThrow(
			/^@acme\/cli: depends on @acme\/util, which is private/,
		);
	});

	it('refuses a dependency on an internal package in a units repo', async () => {
		const dir = await repoWith(
			{
				...MONOREPO,
				'packages/cli/package.json': lib('@acme/cli', '1.0.0', {
					dependencies: {'@acme/core': '^1.0.0'},
				}),
			},
			['@acme/cli@1.0.0'],
		);
		const release = {
			schema: 2,
			shape: 'libraries',
			units: {cli: {path: 'packages/cli'}},
		};

		await expect(plan({cwd: dir, config: config(release)})).rejects.toThrow(
			/^@acme\/cli: depends on @acme\/core, an internal workspace package/,
		);
	});

	it("refuses a version that doesn't match the tag", async () => {
		const dir = await repoWith(MONOREPO, ['@acme/core@1.1.0']);
		const release = {
			schema: 2,
			shape: 'libraries',
			units: {core: {path: 'packages/core'}},
		};
		const refused = plan({cwd: dir, config: config(release)});

		await expect(refused).rejects.toMatchObject({code: 'publish-check'});
		await expect(refused).rejects.toThrow(
			"@acme/core: its version is 1.0.0, which doesn't match the tag @acme/core@1.1.0",
		);
	});

	it("refuses a single package whose version doesn't match the tag", async () => {
		const dir = await repoWith(
			{'package.json': lib('solo', '0.9.0'), 'index.js': ''},
			['v1.0.0'],
		);

		await expect(plan({cwd: dir})).rejects.toThrow(
			"solo: its version is 0.9.0, which doesn't match the tag v1.0.0",
		);
	});

	it('a failing check command publishes nothing', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const npm = fakeNpm();
		const refused = plan({
			cwd: dir,
			npm,
			config: config({schema: 2, shape: 'single', publish: {check: 'exit 1'}}),
		});

		await expect(refused).rejects.toMatchObject({code: 'publish-check'});
		await expect(refused).rejects.toThrow(/publish\.check/);
		expect(npm.calls.some(args => args[0] === 'publish')).toBe(false);
	});

	it('runs a passing check command at the root', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const made = await plan({
			cwd: path.join(dir, 'packages'),
			config: config({
				schema: 2,
				shape: 'single',
				publish: {
					check: `node -e "require('fs').accessSync('pnpm-workspace.yaml')"`,
				},
			}),
		});

		expect(names(made)).toEqual(['@acme/core', '@acme/cli']);
	});

	it('refuses an uncommitted change', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		await writeFile(path.join(dir, 'packages/core/index.js'), 'changed\n');

		await expect(plan({cwd: dir})).rejects.toThrow(/uncommitted changes/);
	});

	it('marks versions already on npm as published and new packages as firstVersion', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const made = await plan({
			cwd: dir,
			npm: fakeNpm({
				'@acme/core': {versions: ['0.9.0', '1.0.0'], latest: '1.0.0'},
			}),
		});

		const [core, cli] = made.targets;
		expect(core).toMatchObject({published: true, firstVersion: false});
		expect(cli).toMatchObject({published: false, firstVersion: true});
	});

	it('refuses a dependency that npm has no version for', async () => {
		const dir = await repoWith(
			{
				...MONOREPO,
				'packages/cli/package.json': lib('@acme/cli', '1.0.0', {
					dependencies: {'@acme/core': '^2.0.0'},
				}),
			},
			['v1.0.0'],
		);

		await expect(plan({cwd: dir})).rejects.toThrow(
			"@acme/cli: depends on @acme/core ^2.0.0, which isn't on npm and isn't published in this run",
		);
	});

	it('plans versions set in the working tree, not yet tagged', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		for (const [file, name] of [
			['packages/core/package.json', '@acme/core'],
			['packages/cli/package.json', '@acme/cli'],
		] as const) {
			await writeFile(
				path.join(dir, file),
				lib(name, '1.1.0', {
					...(name === '@acme/cli'
						? {dependencies: {'@acme/core': '^1.1.0'}}
						: {}),
				}),
			);
		}

		const made = await plan({
			cwd: dir,
			versions: new Map([['v1.1.0', '1.1.0']]),
			skipTagCheck: true,
		});

		expect(names(made)).toEqual(['@acme/core', '@acme/cli']);
		expect(made.targets.map(target => [target.version, target.tag])).toEqual([
			['1.1.0', 'v1.1.0'],
			['1.1.0', 'v1.1.0'],
		]);
	});

	it('refuses a release below latest unless --tag names another', async () => {
		const dir = await repoWith(MONOREPO, ['v1.0.0']);
		const npm = fakeNpm({
			'@acme/core': {versions: ['2.0.0'], latest: '2.0.0'},
		});

		await expect(plan({cwd: dir, npm})).rejects.toThrow(
			/^@acme\/core: 1\.0\.0 is lower than latest \(2\.0\.0\)/,
		);
		const made = await plan({cwd: dir, npm, tag: 'v1'});
		expect(made.targets.map(target => target.distTag)).toEqual(['v1', 'v1']);
	});

	it.skipIf(process.platform === 'win32')(
		'keeps the npm token from the check command and its output',
		async () => {
			const dir = await repoWith(MONOREPO, ['v1.0.0']);
			const refused = plan({
				cwd: dir,
				env: {CHAMOJI_NPM_TOKEN: 'npm_secret123'},
				config: config({
					schema: 2,
					shape: 'single',
					publish: {
						check:
							'echo "seen:${CHAMOJI_NPM_TOKEN:-none}"; echo npm_secret123; exit 3',
					},
				}),
			});

			await expect(refused).rejects.toThrow(/exit code 3:\nseen:none\n\*\*\*/);
			await expect(refused).rejects.not.toThrow(/npm_secret123/);
		},
	);

	it('single repo --from skips an app, as a plain publish does', async () => {
		const dir = await repoWith({...MONOREPO, ...NEXT_APP}, ['v1.0.0']);
		const made = await plan({cwd: dir, from: ['v1.0.0']});

		expect(names(made)).toEqual(['@acme/core', '@acme/cli']);
		expect(made.skipped).toContainEqual({
			name: 'web',
			reason: 'Next.js app (`next` in dependencies, `next.config.ts`)',
		});
	});

	it.skipIf(process.platform === 'win32')(
		'keeps npm tokens from the check command and masks them',
		async () => {
			const dir = await repoWith(MONOREPO, ['v1.0.0']);
			const refused = plan({
				cwd: dir,
				env: {NPM_TOKEN: 'tok-npm-111', NODE_AUTH_TOKEN: 'tok-node-222'},
				config: config({
					schema: 2,
					shape: 'single',
					publish: {
						check:
							'echo "seen:${NPM_TOKEN:-}:${NODE_AUTH_TOKEN:-}"; echo tok-npm-111 tok-node-222; exit 4',
					},
				}),
			});

			await expect(refused).rejects.toThrow(
				/exit code 4:\nseen::\n\*\*\* \*\*\*/,
			);
			await expect(refused).rejects.not.toThrow(/tok-npm-111|tok-node-222/);
		},
	);

	it.skipIf(!has('pnpm'))(
		'--from an older tag plans from a temporary worktree',
		async () => {
			const files: Record<string, string> = {
				...MONOREPO,
				'packages/cli/package.json': lib('@acme/cli', '1.0.0', {
					dependencies: {'@acme/core': 'workspace:^'},
				}),
			};
			// The lockfile, made once outside the repo.
			const scratch = await mkdtemp(path.join(tmpdir(), 'chamoji-lock-'));
			dirs.push(scratch);
			for (const [file, text] of Object.entries(files)) {
				const target = path.join(scratch, ...file.split('/'));
				await mkdir(path.dirname(target), {recursive: true});
				await writeFile(target, text);
			}

			execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], {
				cwd: scratch,
				stdio: 'ignore',
			});
			const lockfile = await readFile(
				path.join(scratch, 'pnpm-lock.yaml'),
				'utf8',
			);

			const repo = await createRepo([
				{commit: '✨ Start', files: {...files, 'pnpm-lock.yaml': lockfile}},
				{tag: 'v1.0.0'},
				{
					commit: '🔖 Release v1.1.0',
					files: {
						'packages/core/package.json': lib('@acme/core', '1.1.0'),
						'packages/cli/package.json': lib('@acme/cli', '1.1.0', {
							dependencies: {'@acme/core': 'workspace:^'},
						}),
					},
				},
				{tag: 'v1.1.0'},
			]);
			repos.push(repo);

			const made = await plan({cwd: repo.dir, from: ['v1.0.0']});

			expect(made.pm).toBe('pnpm');
			expect(made.worktree).not.toBeNull();
			expect(made.root).toBe(made.worktree);
			expect(names(made)).toEqual(['@acme/core', '@acme/cli']);
			expect(made.targets.map(target => target.version)).toEqual([
				'1.0.0',
				'1.0.0',
			]);

			await discardPublishPlan(made);
			expect(existsSync(made.worktree!)).toBe(false);
			expect(existsSync(made.workdir)).toBe(false);
			const listed = execFileSync('git', ['worktree', 'list'], {
				cwd: repo.dir,
				encoding: 'utf8',
			});
			expect(listed.trim().split('\n')).toHaveLength(1);
		},
		60_000,
	);
});

describe('scrubEnv', () => {
	it('removes npm credentials, whatever their case, and lists their values', () => {
		const {env, secrets} = scrubEnv({
			PATH: '/bin',
			CHAMOJI_NPM_TOKEN: 'a1',
			npm_token: 'b2',
			NODE_AUTH_TOKEN: 'c3',
			'npm_config_//registry.npmjs.org/:_authToken': 'd4',
			'NPM_CONFIG_//npm.acme.dev/:_AUTHTOKEN': 'e5',
			npm_config__auth: 'f6',
			npm_config__authIdent: 'g7',
			npm_config_registry: 'https://registry.npmjs.org/',
			EMPTY_TOKEN: undefined,
		});

		expect(env).toEqual({
			PATH: '/bin',
			npm_config_registry: 'https://registry.npmjs.org/',
		});
		expect([...secrets].sort()).toEqual([
			'a1',
			'b2',
			'c3',
			'd4',
			'e5',
			'f6',
			'g7',
		]);
	});

	it('drops every npm credential setting, scoped or not, and masks it', () => {
		const dropped: Record<string, string> = {
			'npm_config_//npm.acme.dev/:_password': 'h8',
			'npm_config_//host/:_auth': 'i9',
			'npm_config_//host/:username': 'j10',
			'NPM_CONFIG_//host/:always-auth': 'k11',
			npm_config__password: 'l12',
			npm_config_password: 'm13',
			npm_config_username: 'n14',
			npm_config_certfile: 'o15',
			NPM_CONFIG_KEYFILE: 'p16',
			npm_config_auth: 'q17',
			npm_config__authtoken: 'r18',
			npm_config_AuthToken: 's19',
			npm_config_key: 't20',
			NPM_CONFIG_CERT: 'u21',
			npm_config_otp: 'v22',
			YARN_NPM_AUTH_TOKEN: 'w23',
			yarn_npm_auth_ident: 'x24',
			ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/t?x=1',
			actions_id_token_request_token: 'z26',
		};
		const {env, secrets} = scrubEnv({
			...dropped,
			npm_config_registry: 'https://registry.npmjs.org/',
			npm_config_cafile: '/etc/ca.pem',
		});

		expect(env).toEqual({
			npm_config_registry: 'https://registry.npmjs.org/',
			npm_config_cafile: '/etc/ca.pem',
		});
		expect([...secrets].sort()).toEqual(Object.values(dropped).sort());
		const output = Object.values(dropped).join(' ');
		expect(mask(output, secrets)).toBe(
			Object.values(dropped)
				.map(() => '***')
				.join(' '),
		);
	});
});
