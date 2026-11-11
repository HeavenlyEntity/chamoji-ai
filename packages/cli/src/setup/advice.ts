import {
	getRemoteWebUrl,
	processEnv,
	publishedVersions,
	type NpmRunner,
} from '@chamoji/core';
import type {GhRunner} from '../run.js';

/**
 * How long a lookup setup makes beyond reading files may take. Past it, setup
 * goes on without that lookup's advice.
 */
export const SETUP_NETWORK_TIMEOUT_MS = 5000;

/** `owner/name` from an origin on github.com, or undefined for anywhere else. */
export async function githubRepo(cwd: string): Promise<string | undefined> {
	const url = await getRemoteWebUrl(cwd);
	return /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url ?? '')?.[1];
}

/**
 * Runs `ask` against a timer: null when it doesn't answer within `timeoutMs`
 * or throws. The timer never keeps chamoji running on its own.
 */
export async function soft<T>(
	ask: () => Promise<T | null>,
	timeoutMs: number,
): Promise<T | null> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<null>(resolve => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		timer.unref();
	});
	try {
		return await Promise.race([ask(), late]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Branch rules that stop the release commit from being pushed. */
const BLOCKING = new Set([
	'pull_request',
	'update',
	'required_status_checks',
	'required_deployments',
]);

const pushAdvice = (branch: string): string =>
	`${branch} blocks direct pushes, so the release commit can't land. Let the GitHub Actions app bypass the ruleset, use a GitHub App token in checkout, or keep trigger "manual" for now. chamoji doesn't change repo settings.`;

/**
 * The advice line when rules on `branch` block the release commit's push.
 * Null with no gh, no GitHub origin, no such rule, any failure, or no answer
 * within `timeoutMs`.
 */
export async function checkPushRules(
	gh: GhRunner,
	root: string,
	branch: string,
	timeoutMs = SETUP_NETWORK_TIMEOUT_MS,
): Promise<string | null> {
	return soft(async () => {
		const repo = await githubRepo(root);
		if (!repo) return null;
		const answer = await gh(
			['api', `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`],
			{timeoutMs},
		);
		if (!answer.ok) return null;
		const rules: unknown = JSON.parse(answer.message);
		if (!Array.isArray(rules)) return null;
		const blocked = rules.some(
			rule =>
				typeof rule === 'object' &&
				rule !== null &&
				BLOCKING.has((rule as {type?: unknown}).type as string),
		);
		return blocked ? pushAdvice(branch) : null;
	}, timeoutMs);
}

/**
 * The npm sign-in steps for CI: a trusted publisher per package on npmjs.com,
 * or the token secret to add. Never prints a token.
 */
export function npmSignInSteps(input: {
	repo: string | null;
	workflowFile: string;
	ciAuth: 'oidc' | 'token';
	packages: Array<{name: string; registry: string}>;
	neverPublished: string[];
}): string {
	if (input.ciAuth === 'token') {
		return 'Create an npm granular access token with publish rights and add it as the NPM_TOKEN secret.';
	}

	const [owner, name] = input.repo?.split('/') ?? [];
	const where =
		owner && name
			? `owner ${owner}, repository ${name}, workflow ${input.workflowFile}`
			: `workflow ${input.workflowFile}, with your GitHub owner and repository`;
	const lines: string[] = [];
	for (const pkg of input.packages) {
		lines.push(
			`On npmjs.com, add a trusted publisher to ${pkg.name}: ${where}.`,
		);
		if (input.neverPublished.includes(pkg.name)) {
			lines.push(
				`${pkg.name} has never been published; publish its first version locally with chamoji publish, then add the trusted publisher.`,
			);
		}
	}

	return lines.join('\n');
}

/**
 * The packages the registry has no record of. A package npm can't answer for
 * is left out rather than guessed at. Null when npm doesn't answer within
 * `timeoutMs`.
 */
export async function neverPublished(
	npm: NpmRunner,
	packages: Array<{name: string; registry: string}>,
	cwd: string,
	timeoutMs = SETUP_NETWORK_TIMEOUT_MS,
): Promise<string[] | null> {
	return soft(async () => {
		const found = await Promise.all(
			packages.map(async pkg => {
				try {
					return (await publishedVersions(
						npm,
						pkg.name,
						pkg.registry,
						cwd,
						processEnv(),
						timeoutMs,
					)) === null
						? pkg.name
						: null;
				} catch {
					return null;
				}
			}),
		);
		return found.filter((name): name is string => name !== null);
	}, timeoutMs);
}
