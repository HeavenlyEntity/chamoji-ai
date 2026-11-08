import {ReleaseError} from '../release.js';
import {
	publishMethod,
	withTokenConfig,
	type PublishMethod,
} from './credentials.js';
import {mask} from './checks.js';
import {DEFAULT_REGISTRY, type NpmRunner} from './npm.js';
import type {PublishPlan} from './plan.js';

export type FetchLike = (
	url: string,
	init?: {method?: string; headers?: Record<string, string>},
) => Promise<{status: number; json(): Promise<unknown>}>;

const fail = (message: string): never => {
	throw new ReleaseError('publish-check', message);
};

/** npm's `message` or `error` from a response body, if it has one. */
async function reason(response: {json(): Promise<unknown>}): Promise<string> {
	try {
		const body = (await response.json()) as {
			message?: unknown;
			error?: unknown;
		};
		const text = body?.message ?? body?.error;
		return typeof text === 'string' ? text : '';
	} catch {
		return '';
	}
}

/** The job's OIDC token, requested for npm. Never put it in a message. */
async function idToken(
	env: Record<string, string>,
	fetchLike: FetchLike,
): Promise<string> {
	const url = `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npm:registry.npmjs.org`;
	let status = 0;
	try {
		const response = await fetchLike(url, {
			headers: {Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},
		});
		status = response.status;
		const body = (await response.json()) as {value?: unknown};
		if (status === 200 && typeof body?.value === 'string' && body.value) {
			return body.value;
		}
	} catch {
		// Fall through to the failure below.
	}

	return fail(
		`couldn't get an OIDC token from GitHub Actions${status ? ` (HTTP ${status})` : ''}; does the job grant \`id-token: write\`?`,
	);
}

async function checkOidc(
	plan: PublishPlan,
	env: Record<string, string>,
	fetchLike: FetchLike,
): Promise<void> {
	// `runPublish` skips first versions with OIDC; npm can't trust a package
	// that doesn't exist yet.
	const targets = plan.targets.filter(
		target => !target.published && !target.firstVersion,
	);
	if (targets.length === 0) return;
	const token = await idToken(env, fetchLike);
	for (const target of targets) {
		const secrets = [token, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ''].filter(
			Boolean,
		);
		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await fetchLike(
				`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(target.name)}`,
				{method: 'POST', headers: {Authorization: `Bearer ${token}`}},
			);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return fail(
				`${target.name}: couldn't reach npm (${mask(text, secrets)})`,
			);
		}

		if (response.status !== 200 && response.status !== 201) {
			const detail = mask(await reason(response), secrets);
			fail(
				`${target.name}: npm refused the trusted publishing exchange (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
			);
		}
	}
}

async function checkWhoami(
	plan: PublishPlan,
	env: Record<string, string>,
	npm: NpmRunner,
	extra: string[],
): Promise<void> {
	const registries = [...new Set(plan.targets.map(target => target.registry))];
	const run = async (runEnv: Record<string, string>) => {
		for (const registry of registries) {
			// eslint-disable-next-line no-await-in-loop
			const result = await npm(['whoami', '--registry', registry], {
				cwd: plan.root,
				env: runEnv,
			});
			if (!result.ok) {
				fail(
					`\`npm whoami --registry ${registry}\` failed; log in with \`npm login\`, or pass a token`,
				);
			}
		}
	};

	await (env.CHAMOJI_NPM_TOKEN
		? withTokenConfig(env, registries, run, extra)
		: run(env));
}

/**
 * Checks that this run can publish, before anything is tagged or pushed, and
 * says which way it will.
 */
export async function checkPublishAuth(
	plan: PublishPlan,
	options: {
		env: Record<string, string>;
		npm: NpmRunner;
		fetch: FetchLike;
		ci: boolean;
		/** `release.publish.registries`: extra registries the token may go to. */
		registries?: string[];
	},
): Promise<PublishMethod> {
	const method = publishMethod(options.env);
	const extra = options.registries ?? [];
	for (const target of plan.targets) {
		if (!target.registry.startsWith('https:')) {
			fail(
				`${target.name}: ${target.registry} isn't https; chamoji won't send credentials to it`,
			);
		}

		if (
			method === 'token' &&
			target.registry !== DEFAULT_REGISTRY &&
			!extra.includes(target.registry)
		) {
			fail(
				`${target.name}: ${target.registry} isn't a registry chamoji may send the npm token to; add it to \`release.publish.registries\``,
			);
		}
	}

	if (method === 'local' && options.ci) {
		fail(
			"this workflow can't publish: grant `id-token: write` for trusted publishing, or pass `npm-token`",
		);
	}

	if (method === 'oidc') {
		await checkOidc(plan, options.env, options.fetch);
	} else {
		await checkWhoami(plan, options.env, options.npm, extra);
	}

	return method;
}
