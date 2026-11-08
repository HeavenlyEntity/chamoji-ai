import {readFile, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {registryVersions} from '../../src/publish/credentials.js';
import {
	checkPublishAuth,
	publishMethod,
	ReleaseError,
	withTokenConfig,
	type FetchLike,
	type NpmRunner,
	type PublishPlan,
	type PublishTarget,
} from '../../src/index.js';

const target = (
	name: string,
	registry = 'https://registry.npmjs.org/',
	extra: Partial<PublishTarget> = {},
): PublishTarget => ({
	name,
	path: name,
	version: '1.0.0',
	tag: `${name}@1.0.0`,
	registry,
	distTag: 'latest',
	tarball: '/tmp/x.tgz',
	access: 'public',
	published: false,
	firstVersion: false,
	...extra,
});

const planOf = (...targets: PublishTarget[]): PublishPlan => ({
	root: process.cwd(),
	pm: 'pnpm',
	targets,
	skipped: [],
	workdir: '',
	worktree: null,
});

const OIDC_ENV = {
	ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/token?x=1',
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
};

const idToken = 'id-token-secret';

function oidcFetch(
	status: number,
	body: unknown,
	calls: Array<{url: string; headers?: Record<string, string>}> = [],
): FetchLike {
	return async (url, init) => {
		calls.push({url, headers: init?.headers});
		if (url.startsWith('https://actions.test')) {
			return {status: 200, json: async () => ({value: idToken})};
		}

		return {status, json: async () => body};
	};
}

const neverFetch: FetchLike = async () => {
	throw new Error('no network');
};

const okNpm: NpmRunner = async () => ({ok: true, stdout: 'me\n', stderr: ''});

describe('publishMethod', () => {
	it('the token wins over OIDC', () => {
		expect(publishMethod({...OIDC_ENV, CHAMOJI_NPM_TOKEN: 'tok'})).toBe(
			'token',
		);
		expect(publishMethod(OIDC_ENV)).toBe('oidc');
		expect(publishMethod({ACTIONS_ID_TOKEN_REQUEST_URL: 'x'})).toBe('local');
		expect(publishMethod({})).toBe('local');
	});
});

describe('withTokenConfig', () => {
	let seen = '';
	afterEach(() => {
		seen = '';
	});

	it('writes one line per registry and deletes the file, even when body throws', async () => {
		let file = '';
		await withTokenConfig(
			{CHAMOJI_NPM_TOKEN: 'tok-1', PATH: '/bin'},
			['https://registry.npmjs.org/', 'https://npm.acme.dev/scope/'],
			async env => {
				file = env.npm_config_userconfig!;
				seen = await readFile(file, 'utf8');
				expect(env.PATH).toBe('/bin');
				if (process.platform !== 'win32') {
					expect((await stat(file)).mode & 0o777).toBe(0o600);
				}
			},
			['https://npm.acme.dev/scope/'],
		);
		expect(seen.trim().split('\n')).toEqual([
			'//registry.npmjs.org/:_authToken=tok-1',
			'//npm.acme.dev/scope/:_authToken=tok-1',
		]);
		await expect(stat(file)).rejects.toThrow();

		let thrown = '';
		await expect(
			withTokenConfig(
				{CHAMOJI_NPM_TOKEN: 'tok-1'},
				['https://a.dev/'],
				async env => {
					thrown = env.npm_config_userconfig!;
					throw new Error('boom');
				},
			),
		).rejects.toThrow('boom');
		await expect(stat(thrown)).rejects.toThrow();
	});
});

describe('checkPublishAuth', () => {
	it("a refused exchange names the status and npm's message, not the token", async () => {
		const error = await checkPublishAuth(planOf(target('@acme/core')), {
			env: OIDC_ENV,
			npm: okNpm,
			fetch: oidcFetch(404, {message: 'no trusted publisher here'}),
			ci: true,
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(ReleaseError);
		const message = (error as ReleaseError).message;
		expect(message).toContain('HTTP 404');
		expect(message).toContain('no trusted publisher here');
		expect(message).toContain('@acme/core');
		expect(message).not.toContain(idToken);
		expect(message).not.toContain('request-secret');
	});

	it('a network failure on the exchange is a publish-check error without tokens', async () => {
		const fetchLike: FetchLike = async url => {
			if (url.startsWith('https://actions.test')) {
				return {status: 200, json: async () => ({value: idToken})};
			}

			throw new TypeError('fetch failed');
		};
		const error = await checkPublishAuth(planOf(target('@acme/core')), {
			env: OIDC_ENV,
			npm: okNpm,
			fetch: fetchLike,
			ci: true,
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(ReleaseError);
		expect((error as ReleaseError).code).toBe('publish-check');
		const message = (error as ReleaseError).message;
		expect(message).toContain('@acme/core');
		expect(message).toContain("couldn't reach npm");
		expect(message).not.toContain(idToken);
		expect(message).not.toContain('request-secret');
	});

	it('a non-JSON exchange body falls back to the status', async () => {
		const fetchLike: FetchLike = async url => {
			if (url.startsWith('https://actions.test')) {
				return {status: 200, json: async () => ({value: idToken})};
			}

			return {
				status: 500,
				json() {
					throw new SyntaxError('Unexpected token <');
				},
			};
		};
		const error = await checkPublishAuth(planOf(target('@acme/core')), {
			env: OIDC_ENV,
			npm: okNpm,
			fetch: fetchLike,
			ci: true,
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(ReleaseError);
		expect((error as ReleaseError).message).toContain('HTTP 500');
		expect((error as ReleaseError).message).not.toContain(idToken);
	});

	it('passes OIDC on 200 and posts the encoded name with the id token', async () => {
		const calls: Array<{url: string; headers?: Record<string, string>}> = [];
		const method = await checkPublishAuth(
			planOf(
				target('@acme/core'),
				target('@acme/new', undefined, {firstVersion: true}),
			),
			{env: OIDC_ENV, npm: okNpm, fetch: oidcFetch(201, {}, calls), ci: true},
		);
		expect(method).toBe('oidc');
		const exchanges = calls.filter(call => call.url.includes('/oidc/'));
		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]!.url).toBe(
			'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40acme%2Fcore',
		);
		expect(exchanges[0]!.headers?.Authorization).toBe(`Bearer ${idToken}`);
		expect(calls[0]!.url).toBe(
			'https://actions.test/token?x=1&audience=npm:registry.npmjs.org',
		);
		expect(calls[0]!.headers?.Authorization).toBe('bearer request-secret');
	});

	it('the token config has only the npmjs line by default, and listed registries', async () => {
		const read = async (extra?: string[]) =>
			withTokenConfig(
				{CHAMOJI_NPM_TOKEN: 'tok-1'},
				['https://registry.npmjs.org/', 'https://npm.acme.dev/'],
				async env => readFile(env.npm_config_userconfig!, 'utf8'),
				extra,
			);
		expect((await read()).trim().split('\n')).toEqual([
			'//registry.npmjs.org/:_authToken=tok-1',
		]);
		expect((await read(['https://npm.acme.dev/'])).trim().split('\n')).toEqual([
			'//registry.npmjs.org/:_authToken=tok-1',
			'//npm.acme.dev/:_authToken=tok-1',
		]);
	});

	it('refuses an unlisted registry under the token method, with no request', async () => {
		let requests = 0;
		const npm: NpmRunner = async () => {
			requests++;
			return {ok: true, stdout: '', stderr: ''};
		};
		const options = {
			env: {CHAMOJI_NPM_TOKEN: 'tok-1'},
			npm,
			fetch: neverFetch,
			ci: true,
		};
		const plan = planOf(target('a', 'https://evil.example/'));
		const error = await checkPublishAuth(plan, options).catch(
			(error_: unknown) => error_,
		);
		expect(error).toBeInstanceOf(ReleaseError);
		expect((error as ReleaseError).message).toContain('https://evil.example/');
		expect((error as ReleaseError).message).toContain(
			'release.publish.registries',
		);
		expect((error as ReleaseError).message).not.toContain('tok-1');
		expect(requests).toBe(0);
		await expect(
			checkPublishAuth(plan, {
				...options,
				registries: ['https://evil.example/'],
			}),
		).resolves.toBe('token');
		expect(requests).toBe(1);
	});

	it('refuses an http registry before any request', async () => {
		let requests = 0;
		const npm: NpmRunner = async () => {
			requests++;
			return {ok: true, stdout: '', stderr: ''};
		};
		const envs: Array<Record<string, string>> = [
			{CHAMOJI_NPM_TOKEN: 'tok-1'},
			{},
		];
		for (const env of envs) {
			const error = await checkPublishAuth(
				planOf(target('a', 'http://npm.acme.dev/')),
				{
					env,
					npm,
					fetch: neverFetch,
					ci: false,
					registries: ['http://npm.acme.dev/'],
				},
			).catch((error_: unknown) => error_);
			expect((error as ReleaseError).message).toBe(
				"a: http://npm.acme.dev/ isn't https; chamoji won't send credentials to it",
			);
		}

		expect(requests).toBe(0);
	});

	it('whoami runs once per registry with the token config', async () => {
		const runs: Array<{args: string[]; config: string}> = [];
		const npm: NpmRunner = async (args, options) => {
			const file = options.env.npm_config_userconfig;
			runs.push({args, config: file ? await readFile(file, 'utf8') : ''});
			return {ok: true, stdout: 'me', stderr: ''};
		};
		const method = await checkPublishAuth(
			planOf(target('a'), target('b'), target('c', 'https://npm.acme.dev/')),
			{
				env: {CHAMOJI_NPM_TOKEN: 'tok-9', ...OIDC_ENV},
				npm,
				fetch: neverFetch,
				ci: true,
				registries: ['https://npm.acme.dev/'],
			},
		);
		expect(method).toBe('token');
		expect(runs.map(run => run.args)).toEqual([
			['whoami', '--registry', 'https://registry.npmjs.org/'],
			['whoami', '--registry', 'https://npm.acme.dev/'],
		]);
		for (const run of runs) {
			expect(run.config).toContain('//npm.acme.dev/:_authToken=tok-9');
		}
	});

	it('whoami under a token gets no npm token variable, only the token config', async () => {
		const seen: Array<Record<string, string>> = [];
		const npm: NpmRunner = async (_args, options) => {
			seen.push(options.env);
			return {ok: true, stdout: 'me', stderr: ''};
		};
		await checkPublishAuth(planOf(target('a')), {
			env: {
				CHAMOJI_NPM_TOKEN: 'tok-9',
				NPM_TOKEN: 'tok-8',
				NODE_AUTH_TOKEN: 'tok-7',
			},
			npm,
			fetch: neverFetch,
			ci: true,
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]!.npm_config_userconfig).toBeTruthy();
		expect(seen[0]!.CHAMOJI_NPM_TOKEN).toBeUndefined();
		expect(seen[0]!.NPM_TOKEN).toBeUndefined();
		expect(seen[0]!.NODE_AUTH_TOKEN).toBeUndefined();
		expect(JSON.stringify(seen[0])).not.toContain('tok-');
	});

	it("whoami under a token runs outside the repo, so its .npmrc can't proxy the token", async () => {
		const cwds: string[] = [];
		const npm: NpmRunner = async (_args, options) => {
			cwds.push(options.cwd);
			return {ok: true, stdout: 'me', stderr: ''};
		};
		const plan = planOf(target('a'));
		await checkPublishAuth(plan, {
			env: {CHAMOJI_NPM_TOKEN: 'tok-9'},
			npm,
			fetch: neverFetch,
			ci: true,
		});
		expect(cwds).toHaveLength(1);
		expect(cwds[0]).not.toBe(plan.root);
		expect(path.relative(plan.root, cwds[0]!).startsWith('..')).toBe(true);
		expect(path.relative(os.tmpdir(), cwds[0]!).startsWith('..')).toBe(false);
	});

	it("npm view under a token runs outside the repo, so its .npmrc can't proxy the token", async () => {
		const cwds: string[] = [];
		const npm: NpmRunner = async (_args, options) => {
			cwds.push(options.cwd);
			return {ok: true, stdout: '{"versions":["1.0.0"]}', stderr: ''};
		};
		const root = process.cwd();
		await registryVersions(npm, 'a', 'https://registry.npmjs.org/', root, {
			env: {CHAMOJI_NPM_TOKEN: 'tok-9'},
			method: 'token',
			extra: [],
		});
		expect(cwds).toHaveLength(1);
		expect(path.relative(root, cwds[0]!).startsWith('..')).toBe(true);
	});

	it('a failed whoami says to log in, without the token', async () => {
		const npm: NpmRunner = async () => ({
			ok: false,
			stdout: '',
			stderr: 'npm error code E401 tok-9',
		});
		const error = await checkPublishAuth(planOf(target('a')), {
			env: {CHAMOJI_NPM_TOKEN: 'tok-9'},
			npm,
			fetch: neverFetch,
			ci: true,
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(ReleaseError);
		expect((error as ReleaseError).message).toContain('npm whoami');
		expect((error as ReleaseError).message).not.toContain('tok-9');
	});

	it('local runs whoami without a token config', async () => {
		const seenEnv: Array<string | undefined> = [];
		const npm: NpmRunner = async (_args, options) => {
			seenEnv.push(options.env.npm_config_userconfig);
			return {ok: true, stdout: 'me', stderr: ''};
		};
		const method = await checkPublishAuth(planOf(target('a')), {
			env: {},
			npm,
			fetch: neverFetch,
			ci: false,
		});
		expect(method).toBe('local');
		expect(seenEnv).toEqual([undefined]);
	});

	it('CI with nothing set throws the exact message', async () => {
		const error = await checkPublishAuth(planOf(target('a')), {
			env: {},
			npm: okNpm,
			fetch: neverFetch,
			ci: true,
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(ReleaseError);
		expect((error as ReleaseError).code).toBe('publish-check');
		expect((error as ReleaseError).message).toBe(
			"this workflow can't publish: grant `id-token: write` for trusted publishing, or pass `npm-token`",
		);
	});
});
