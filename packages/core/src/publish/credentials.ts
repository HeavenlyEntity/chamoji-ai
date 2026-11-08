import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {DEFAULT_REGISTRY} from './npm.js';

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
 * Runs `body` with an npm user config that holds the token for each registry
 * that may have it: npmjs, and the `extra` ones the config lists. Registries
 * come from repo content, so any other is left out.
 *
 * so the token never sits in an argument or in the repo's `.npmrc`. The file
 * is owner-only and gone when `body` settles.
 */
export async function withTokenConfig<T>(
	env: Record<string, string>,
	registries: string[],
	body: (env: Record<string, string>) => Promise<T>,
	extra: string[] = [],
): Promise<T> {
	const token = env.CHAMOJI_NPM_TOKEN ?? '';
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-npm-'));
	try {
		const file = path.join(dir, 'npmrc');
		const allowed = new Set([DEFAULT_REGISTRY, ...extra]);
		const lines = [
			...new Set(registries.filter(url => allowed.has(url)).map(nerfDart)),
		].map(key => `${key}:_authToken=${token}`);
		await writeFile(file, `${lines.join('\n')}\n`, {mode: 0o600});
		await chmod(file, 0o600);
		return await body({...env, npm_config_userconfig: file});
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}
