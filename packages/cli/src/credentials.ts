/**
 * The variables that let a process publish: the npm token, and the job's OIDC
 * request, which can mint a trusted-publishing token.
 */
export const CREDENTIAL_NAMES = [
	'CHAMOJI_NPM_TOKEN',
	'ACTIONS_ID_TOKEN_REQUEST_URL',
	'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
] as const;

/**
 * Takes the publish credentials out of `env` (process.env in the binary) and
 * returns them. Everything chamoji starts inherits process.env, git and its
 * hooks included, so the credentials must not stay there; the publish tools
 * get them back from `io.credentials`.
 */
export function takeCredentials(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const taken: Record<string, string> = {};
	for (const name of CREDENTIAL_NAMES) {
		const value = env[name];
		if (value) taken[name] = value;
		delete env[name];
	}

	return taken;
}
