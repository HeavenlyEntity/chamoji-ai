import {mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
	runPublish,
	type NpmRunner,
	type PublishPlan,
	type PublishTarget,
} from '../../src/index.js';

const TOKEN = 'npm_secretToken123';
const OIDC = {
	ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/token?x=1',
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
};

type Call = {
	args: string[];
	cwd: string;
	env: Record<string, string>;
	inheritStdio?: boolean;
	config?: string;
};

async function setup(
	targets: Array<Partial<PublishTarget> & {name: string}>,
): Promise<PublishPlan> {
	const workdir = await mkdtemp(path.join(tmpdir(), 'chamoji-run-test-'));
	const full: PublishTarget[] = [];
	for (const t of targets) {
		const published = t.published ?? false;
		const tarball = published
			? ''
			: path.join(workdir, `${t.name.replace(/\W+/g, '-')}-1.0.0.tgz`);
		if (tarball) await writeFile(tarball, 'x');
		full.push({
			path: t.name,
			version: '1.0.0',
			tag: `${t.name}@1.0.0`,
			registry: 'https://registry.npmjs.org/',
			distTag: 'latest',
			access: null,
			published,
			firstVersion: false,
			...t,
			tarball,
		});
	}

	return {
		root: workdir,
		pm: 'pnpm',
		targets: full,
		skipped: [],
		workdir,
		worktree: null,
	};
}

function fake(
	respond: (call: Call) => {
		ok: boolean;
		stdout?: string;
		stderr?: string;
	} = () => ({
		ok: true,
	}),
): {npm: NpmRunner; calls: Call[]} {
	const calls: Call[] = [];
	const npm: NpmRunner = async (args, options) => {
		const call: Call = {args, ...options};
		const userconfig = options.env.npm_config_userconfig;
		if (userconfig) call.config = await readFile(userconfig, 'utf8');
		calls.push(call);
		const r = respond(call);
		return {ok: r.ok, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};
	};

	return {npm, calls};
}

describe('runPublish', () => {
	it('publishes in order and passes tag, provenance and access', async () => {
		const plan = await setup([
			{name: 'a', distTag: 'next'},
			{name: '@s/b', access: null},
			{name: '@s/c', access: 'restricted'},
		]);
		const {npm, calls} = fake();
		const out = await runPublish(plan, {
			method: 'token',
			npm,
			env: {CHAMOJI_NPM_TOKEN: TOKEN, ...OIDC},
			ci: true,
		});
		expect(out.map(o => o.status)).toEqual([
			'published',
			'published',
			'published',
		]);
		expect(calls.map(c => c.args)).toEqual([
			[
				'publish',
				'./a-1.0.0.tgz',
				'--tag=next',
				'--registry=https://registry.npmjs.org/',
				'--provenance',
				'--ignore-scripts',
			],
			[
				'publish',
				'./-s-b-1.0.0.tgz',
				'--tag=latest',
				'--registry=https://registry.npmjs.org/',
				'--@s:registry=https://registry.npmjs.org/',
				'--provenance',
				'--access',
				'public',
				'--ignore-scripts',
			],
			[
				'publish',
				'./-s-c-1.0.0.tgz',
				'--tag=latest',
				'--registry=https://registry.npmjs.org/',
				'--@s:registry=https://registry.npmjs.org/',
				'--provenance',
				'--ignore-scripts',
			],
		]);
		expect(calls[0]!.cwd).toBe(path.dirname(plan.targets[0]!.tarball));
	});

	it('only adds provenance in ci with a non-local method', async () => {
		const plan = await setup([{name: 'a'}]);
		const {npm, calls} = fake();
		await runPublish(plan, {method: 'local', npm, env: {}, ci: true});
		expect(calls[0]!.args).not.toContain('--provenance');
		expect(calls[0]!.inheritStdio).toBe(true);

		const plan2 = await setup([{name: 'a'}]);
		const second = fake();
		await runPublish(plan2, {
			method: 'token',
			npm: second.npm,
			env: {CHAMOJI_NPM_TOKEN: TOKEN},
			ci: false,
		});
		expect(second.calls[0]!.args).not.toContain('--provenance');
		expect(second.calls[0]!.inheritStdio).toBeFalsy();
	});

	it('asks for provenance only when the job can mint an OIDC token', async () => {
		const argsWith = async (env: Record<string, string>) => {
			const {npm, calls} = fake();
			await runPublish(await setup([{name: 'a'}]), {
				method: 'token',
				npm,
				env: {CHAMOJI_NPM_TOKEN: TOKEN, ...env},
				ci: true,
			});
			return calls[0]!.args;
		};

		// Without id-token: write, npm would refuse --provenance.
		expect(await argsWith({})).not.toContain('--provenance');
		expect(
			await argsWith({
				ACTIONS_ID_TOKEN_REQUEST_URL: OIDC.ACTIONS_ID_TOKEN_REQUEST_URL,
			}),
		).not.toContain('--provenance');
		expect(await argsWith(OIDC)).toContain('--provenance');
		// A private repository can't have provenance.
		expect(
			await argsWith({...OIDC, CHAMOJI_PROVENANCE: 'false'}),
		).not.toContain('--provenance');

		const {npm, calls} = fake();
		await runPublish(await setup([{name: 'a'}]), {
			method: 'oidc',
			npm,
			env: {...OIDC, CHAMOJI_PROVENANCE: 'false'},
			ci: true,
		});
		expect(calls[0]!.args).not.toContain('--provenance');
	});

	it('a re-run publishes only what is missing', async () => {
		const plan = await setup([{name: 'a', published: true}, {name: 'b'}]);
		const {npm, calls} = fake();
		const out = await runPublish(plan, {
			method: 'local',
			npm,
			env: {},
			ci: false,
		});
		expect(out.map(o => o.status)).toEqual(['already', 'published']);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args[1]).toBe('./b-1.0.0.tgz');
	});

	it('skips never-published packages under OIDC and publishes them with a token', async () => {
		const oidc = fake();
		const plan = await setup([{name: 'new', firstVersion: true}]);
		const out = await runPublish(plan, {
			method: 'oidc',
			npm: oidc.npm,
			env: OIDC,
			ci: true,
		});
		expect(out[0]).toMatchObject({status: 'skipped'});
		expect(out[0]!.message).toBe(
			'new 1.0.0 has never been published; publish its first version locally with `chamoji publish`, or use an npm token, then add the trusted publisher on npmjs.com',
		);
		expect(oidc.calls).toHaveLength(0);

		const tok = fake();
		const plan2 = await setup([{name: 'new', firstVersion: true}]);
		const out2 = await runPublish(plan2, {
			method: 'token',
			npm: tok.npm,
			env: {CHAMOJI_NPM_TOKEN: TOKEN},
			ci: true,
		});
		expect(out2[0]!.status).toBe('published');
		expect(tok.calls).toHaveLength(1);
	});

	it('keeps the token only in the temp config, and the OIDC vars under OIDC', async () => {
		const plan = await setup([{name: 'a', registry: 'https://r.example/'}]);
		const {npm, calls} = fake();
		await runPublish(plan, {
			method: 'token',
			npm,
			env: {CHAMOJI_NPM_TOKEN: TOKEN},
			ci: false,
			registries: ['https://r.example/'],
		});
		expect(calls[0]!.env.CHAMOJI_NPM_TOKEN).toBeUndefined();
		expect(calls[0]!.config).toContain(`//r.example/:_authToken=${TOKEN}`);

		const oidcPlan = await setup([{name: 'a'}]);
		const o = fake();
		await runPublish(oidcPlan, {
			method: 'oidc',
			npm: o.npm,
			env: OIDC,
			ci: true,
		});
		expect(o.calls[0]!.env).toMatchObject(OIDC);
	});

	it('stops at the first failure and redacts the secrets', async () => {
		const plan = await setup([{name: 'a'}, {name: 'b'}, {name: 'c'}]);
		const {npm, calls} = fake(call =>
			call.args[1] === './b-1.0.0.tgz'
				? {
						ok: false,
						stderr: `bad ${TOKEN} and request-secret at ${OIDC.ACTIONS_ID_TOKEN_REQUEST_URL}`,
					}
				: {ok: true},
		);
		const out = await runPublish(plan, {
			method: 'token',
			npm,
			env: {CHAMOJI_NPM_TOKEN: TOKEN, ...OIDC},
			ci: false,
		});
		expect(out.map(o => o.status)).toEqual(['published', 'failed']);
		expect(calls).toHaveLength(2);
		expect(out[1]!.message).toContain('***');
		expect(out[1]!.message).not.toContain(TOKEN);
		expect(out[1]!.message).not.toContain('request-secret');
		expect(out[1]!.message).not.toContain('actions.test');
	});

	it('says npm printed its own output when it was inherited', async () => {
		const plan = await setup([{name: 'a'}]);
		const {npm} = fake(() => ({ok: false}));
		const out = await runPublish(plan, {
			method: 'local',
			npm,
			env: {},
			ci: false,
		});
		expect(out[0]).toMatchObject({
			status: 'failed',
			message: "npm publish failed; npm's output is above",
		});
	});

	it('removes the tarball dir afterwards, even on failure', async () => {
		const plan = await setup([{name: 'a'}]);
		const {npm} = fake(() => ({ok: false, stderr: 'boom'}));
		await runPublish(plan, {method: 'local', npm, env: {}, ci: false});
		await expect(stat(plan.workdir)).rejects.toThrow();
	});

	it('hands npm publish no npm credential under a token, only the OIDC pair and the temp config', async () => {
		const plan = await setup([{name: 'a'}]);
		const {npm, calls} = fake();
		await runPublish(plan, {
			method: 'token',
			npm,
			env: {
				PATH: '/usr/bin',
				CHAMOJI_NPM_TOKEN: TOKEN,
				NPM_TOKEN: TOKEN,
				NODE_AUTH_TOKEN: TOKEN,
				...OIDC,
			},
			ci: true,
		});
		const env = calls[0]!.env;
		expect(env.CHAMOJI_NPM_TOKEN).toBeUndefined();
		expect(env.NPM_TOKEN).toBeUndefined();
		expect(env.NODE_AUTH_TOKEN).toBeUndefined();
		expect(env.npm_config_userconfig).toBeTruthy();
		expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(
			OIDC.ACTIONS_ID_TOKEN_REQUEST_URL,
		);
		expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
			OIDC.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
		);
		expect(env.PATH).toBe('/usr/bin');
	});

	it('passes the env unchanged under local, and --ignore-scripts under every method', async () => {
		const localEnv = {PATH: '/usr/bin', NPM_TOKEN: 'mine', OTHER: 'x'};
		const local = fake();
		await runPublish(await setup([{name: 'a'}]), {
			method: 'local',
			npm: local.npm,
			env: localEnv,
			ci: false,
		});
		expect(local.calls[0]!.env).toEqual(localEnv);
		expect(local.calls[0]!.args).toContain('--ignore-scripts');

		const oidc = fake();
		await runPublish(await setup([{name: 'a'}]), {
			method: 'oidc',
			npm: oidc.npm,
			env: {PATH: '/usr/bin', NPM_TOKEN: 'x', ...OIDC},
			ci: true,
		});
		expect(oidc.calls[0]!.args).toContain('--ignore-scripts');
		expect(oidc.calls[0]!.env.NPM_TOKEN).toBeUndefined();
		expect(oidc.calls[0]!.env).toMatchObject(OIDC);
	});

	it('pins the registry, and gives no --access public on a private one', async () => {
		const plan = await setup([{name: '@s/p', registry: 'https://r.example/'}]);
		const {npm, calls} = fake();
		await runPublish(plan, {
			method: 'token',
			npm,
			env: {CHAMOJI_NPM_TOKEN: TOKEN},
			ci: false,
			registries: ['https://r.example/'],
		});
		expect(calls[0]!.args).toEqual([
			'publish',
			'./-s-p-1.0.0.tgz',
			'--tag=latest',
			'--registry=https://r.example/',
			'--@s:registry=https://r.example/',
			'--ignore-scripts',
		]);
	});

	it('refuses a dist-tag that could be an option', async () => {
		const plan = await setup([{name: 'a', distTag: '--registry=https://evil'}]);
		const {npm, calls} = fake();
		const out = await runPublish(plan, {
			method: 'local',
			npm,
			env: {},
			ci: false,
		});
		expect(out[0]!.status).toBe('failed');
		expect(calls).toHaveLength(0);
	});

	it('uses the exact argv under oidc and local', async () => {
		const o = fake();
		await runPublish(await setup([{name: 'a'}]), {
			method: 'oidc',
			npm: o.npm,
			env: OIDC,
			ci: true,
		});
		expect(o.calls[0]!.args).toEqual([
			'publish',
			'./a-1.0.0.tgz',
			'--tag=latest',
			'--registry=https://registry.npmjs.org/',
			'--provenance',
			'--ignore-scripts',
		]);
		const l = fake();
		await runPublish(await setup([{name: 'a'}]), {
			method: 'local',
			npm: l.npm,
			env: {},
			ci: true,
		});
		expect(l.calls[0]!.args).toEqual([
			'publish',
			'./a-1.0.0.tgz',
			'--tag=latest',
			'--registry=https://registry.npmjs.org/',
			'--ignore-scripts',
		]);
	});
});
