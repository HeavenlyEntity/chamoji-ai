import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ReleaseError} from '../release.js';
import {DEFAULT_REGISTRY, publishedVersions, type NpmRunner} from './npm.js';

export type PublishMethod = 'oidc' | 'token' | 'local';

/** How this run authenticates: a token wins, then the job's OIDC token. */
export function publishMethod(env: Record<string, string>): PublishMethod {
	if (env.CHAMOJI_NPM_TOKEN) return 'token';
	if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
		return 'oidc';
	}

	return 'local';
}

/** `//host/path/` for a registry URL, the key npm's `_authToken` hangs on. */
function nerfDart(registry: string): string {
	const url = new URL(registry);
	const pathname = url.pathname.endsWith('/')
		? url.pathname
		: `${url.pathname}/`;
	return `//${url.host}${pathname}`;
}

/**
 * Runs `body` with `npm_config_userconfig` pointing at a temporary npm user
 * config that holds the token for each of `registries` that may have it:
 * npmjs, and the `extra` ones `release.publish.registries` lists. Registries
 * come from repo content, so any other is left out. The token never sits in
 * an argument or in the repo's `.npmrc`; the file is owner-only and gone when
 * `body` settles. `body` also gets `cwd`, an empty directory to run npm in: run
 * from the repo, npm would read the repo's `.npmrc`, whose `proxy`,
 * `strict-ssl` or `cafile` could expose the token on its way to the registry.
 */
export async function withTokenConfig<T>(
	env: Record<string, string>,
	registries: string[],
	body: (env: Record<string, string>, cwd: string) => Promise<T>,
	extra: string[] = [],
): Promise<T> {
	const token = env.CHAMOJI_NPM_TOKEN ?? '';
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-npm-'));
	try {
		const cwd = path.join(dir, 'cwd');
		await mkdir(cwd);
		const file = path.join(dir, 'npmrc');
		const allowed = new Set([DEFAULT_REGISTRY, ...extra]);
		const lines = [
			...new Set(registries.filter(url => allowed.has(url)).map(nerfDart)),
		].map(key => `${key}:_authToken=${token}`);
		await writeFile(file, `${lines.join('\n')}\n`, {mode: 0o600});
		await chmod(file, 0o600);
		return await body({...env, npm_config_userconfig: file}, cwd);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}

/**
 * Refuses a registry chamoji mustn't send credentials to: one that isn't
 * https, or, under a token, one other than npmjs that
 * `release.publish.registries` doesn't list. A registry comes from repo
 * content (`publishConfig.registry`, `.npmrc`), which anyone can change in a
 * pull request.
 */
export function checkRegistry(
	name: string,
	registry: string,
	method: PublishMethod,
	extra: string[],
): void {
	if (!registry.startsWith('https:')) {
		throw new ReleaseError(
			'publish-check',
			`${name}: ${registry} isn't https; chamoji won't send credentials to it`,
		);
	}

	if (
		method === 'token' &&
		registry !== DEFAULT_REGISTRY &&
		!extra.includes(registry)
	) {
		throw new ReleaseError(
			'publish-check',
			`${name}: ${registry} isn't a registry chamoji may send the npm token to; add it to \`release.publish.registries\``,
		);
	}
}

/**
 * `publishedVersions` for a run that publishes with `method`: the registry is
 * checked first, and under a token npm reads with the token config, so a
 * restricted package or a private registry answers; it never gets the token
 * in its environment.
 */
export async function registryVersions(
	npm: NpmRunner,
	name: string,
	registry: string,
	cwd: string,
	options: {
		env: Record<string, string>;
		method: PublishMethod;
		extra: string[];
	},
): ReturnType<typeof publishedVersions> {
	checkRegistry(name, registry, options.method, options.extra);
	if (options.method !== 'token') {
		return publishedVersions(npm, name, registry, cwd, options.env);
	}

	return withTokenConfig(
		options.env,
		[registry],
		async (tokenEnv, neutral) =>
			publishedVersions(npm, name, registry, neutral, tokenEnv),
		options.extra,
	);
}
