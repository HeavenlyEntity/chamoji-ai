import {execFileSync} from 'node:child_process';
import type {FetchLike, NpmRunner} from '@chamoji/core';
import {run, type GhRunner} from '../../src/run.js';

/** Whether `tool` runs here; `release --publish` packs with the real npm. */
export const has = (tool: string): boolean => {
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

export const TOKEN = 'npm_releaseSecretToken789';

/**
 * A fake npm and a fake gh that write to one call log, so a test can check
 * the order: `npm publish <tarball>` and `gh release create <tag>`. The
 * registry has only the `versions` given (the last is latest), else never
 * saw any package. `failPublish` makes every publish fail, and `failWhoami`
 * every whoami.
 */
export function fakeTools(
	options: {
		failPublish?: boolean;
		failWhoami?: boolean;
		onPublish?: () => Promise<void>;
		versions?: string[];
	} = {},
) {
	const log: string[] = [];
	const npm: NpmRunner = async args => {
		log.push(`npm ${args.join(' ')}`);
		if (args[0] === '--version') {
			return {ok: true, stdout: '11.6.0', stderr: ''};
		}

		if (args[0] === 'whoami') {
			return options.failWhoami
				? {ok: false, stdout: '', stderr: 'npm error code E401'}
				: {ok: true, stdout: 'dev', stderr: ''};
		}

		if (args[0] === 'view') {
			const versions = options.versions ?? [];
			return versions.length > 0
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

		if (args[0] === 'publish') {
			await options.onPublish?.();
			return options.failPublish
				? {ok: false, stdout: '', stderr: `npm error code E403 for ${TOKEN}`}
				: {ok: true, stdout: '', stderr: ''};
		}

		return {ok: false, stdout: '', stderr: `unexpected npm ${args.join(' ')}`};
	};

	const gh: GhRunner = async args => {
		log.push(`gh ${args.slice(0, 3).join(' ')}`);
		return {ok: true, message: 'https://github.com/acme/x/releases'};
	};

	return {
		npm,
		gh,
		log,
		published: () => log.filter(line => line.startsWith('npm publish')),
		releases: () => log.filter(line => line.startsWith('gh release create')),
	};
}

const fetchNever: FetchLike = async () => {
	throw new Error('no network in tests');
};

/**
 * Runs chamoji with the fake tools, a token, and no CI or OIDC from the real
 * environment; `env` changes that environment.
 */
export async function chamojiPublishing(
	argv: string[],
	cwd: string,
	tools: {npm: NpmRunner; gh: GhRunner},
	today = '2026-10-28',
	env: Record<string, string | undefined> = {},
) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today,
		fetchTags: false,
		npm: tools.npm,
		gh: tools.gh,
		fetch: fetchNever,
		env: {
			CI: undefined,
			ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
			CHAMOJI_NPM_TOKEN: TOKEN,
			...env,
		},
	});
	return {code, stdout, stderr};
}
