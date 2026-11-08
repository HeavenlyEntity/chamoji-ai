import path from 'node:path';
import {mask, scrubEnv, tail} from './checks.js';
import {isDistTag} from './tag-name.js';
import {withTokenConfig, type PublishMethod} from './credentials.js';
import {DEFAULT_REGISTRY, type NpmResult, type NpmRunner} from './npm.js';
import {discardPublishPlan, type PublishPlan} from './plan.js';

export type PublishOutcome = {
	name: string;
	version: string;
	distTag: string;
	registry: string;
	status: 'published' | 'already' | 'skipped' | 'failed';
	message?: string;
};

export type RunPublishOptions = {
	method: PublishMethod;
	npm: NpmRunner;
	/** The complete environment npm runs in (PATH included); `runNpm` adds nothing. */
	env: Record<string, string>;
	/** Running in CI: provenance is asked for when the method allows it. */
	ci: boolean;
	/** The registries beyond npmjs that may hold the token (`release.publish.registries`). */
	registries?: string[];
};

/**
 * The env `npm publish` gets under a token or OIDC: no npm credential, so a
 * token in the caller's env can't reach npm or anything it starts, except the
 * two variables npm itself needs for the OIDC exchange and for provenance.
 */
function npmEnv(env: Record<string, string>): Record<string, string> {
	const clean = scrubEnv(env).env;
	for (const key of [
		'ACTIONS_ID_TOKEN_REQUEST_URL',
		'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
	]) {
		if (env[key]) clean[key] = env[key];
	}

	return clean;
}

/**
 * Publishes each target's tarball in order, skipping what is already on the
 * registry. The first failure stops the run. The plan's tarballs and temporary
 * worktree are removed when it ends, however it ends.
 */
export async function runPublish(
	plan: PublishPlan,
	options: RunPublishOptions,
): Promise<PublishOutcome[]> {
	const {method, npm, env, ci} = options;
	const secrets = [
		...scrubEnv(env).secrets,
		env.CHAMOJI_NPM_TOKEN,
		env.ACTIONS_ID_TOKEN_REQUEST_URL,
		env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
	].filter((secret): secret is string => Boolean(secret));
	const outcomes: PublishOutcome[] = [];

	try {
		for (const target of plan.targets) {
			const base = {
				name: target.name,
				version: target.version,
				distTag: target.distTag,
				registry: target.registry,
			};
			if (target.published) {
				outcomes.push({...base, status: 'already'});
				continue;
			}

			if (method === 'oidc' && target.firstVersion) {
				outcomes.push({
					...base,
					status: 'skipped',
					message: mask(
						`${target.name} ${target.version} has never been published; publish its first version locally with \`chamoji publish\`, or use an npm token, then add the trusted publisher on npmjs.com`,
						secrets,
					),
				});
				continue;
			}

			if (!isDistTag(target.distTag)) {
				outcomes.push({
					...base,
					status: 'failed',
					message: `"${target.distTag}" can't be a dist-tag`,
				});
				break;
			}

			const registryUrl = target.registry;
			// `target.access` is the manifest's `publishConfig.access`; null when
			// unset, which is when a scoped name needs `--access public`.
			const scope = target.name.startsWith('@')
				? target.name.split('/')[0]
				: null;
			const scopedDefault =
				scope !== null && !target.access && registryUrl === DEFAULT_REGISTRY;
			const args = [
				'publish',
				`./${path.basename(target.tarball)}`,
				`--tag=${target.distTag}`,
				`--registry=${registryUrl}`,
				...(scope ? [`--${scope}:registry=${registryUrl}`] : []),
				...(ci && method !== 'local' ? ['--provenance'] : []),
				...(scopedDefault ? ['--access', 'public'] : []),
				'--ignore-scripts',
			];
			const cwd = path.dirname(target.tarball);
			const run = (publishEnv: Record<string, string>): Promise<NpmResult> =>
				npm(args, {
					cwd,
					env: publishEnv,
					...(method === 'local' ? {inheritStdio: true} : {}),
				});

			const result =
				method === 'token'
					? await withTokenConfig(
							env,
							[target.registry],
							async tokenEnv =>
								run({
									...npmEnv(env),
									npm_config_userconfig: tokenEnv.npm_config_userconfig!,
								}),
							options.registries ?? [],
						)
					: await run(method === 'oidc' ? npmEnv(env) : env);

			if (result.ok) {
				outcomes.push({...base, status: 'published'});
				continue;
			}

			const output = tail(result.stderr || result.stdout);
			outcomes.push({
				...base,
				status: 'failed',
				message: mask(
					output || "npm publish failed; npm's output is above",
					secrets,
				),
			});
			break;
		}
	} finally {
		await discardPublishPlan(plan);
	}

	return outcomes;
}
