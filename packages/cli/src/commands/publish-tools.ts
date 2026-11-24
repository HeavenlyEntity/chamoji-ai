import {
	checkPublishAuth,
	discardPublishPlan,
	processEnv,
	publishMethod,
	runNpm,
	runPublish,
	type ChamojiConfig,
	type FetchLike,
	type NpmRunner,
	type PublishMethod,
	type PublishOutcome,
	type PublishPlan,
	type PublishTarget,
} from '@chamoji/core';
import type {CommandContext} from './context.js';

const outcomeText = (outcome: PublishOutcome): string =>
	outcome.status === 'already' ? 'already on npm' : outcome.status;

/** `name version → distTag`, the start of every publish line. */
const targetLine = (item: {
	name: string;
	version: string;
	distTag: string;
}): string => `${item.name} ${item.version} → ${item.distTag}`;

export const outcomeLine = (outcome: PublishOutcome): string =>
	`${targetLine(outcome)}: ${outcomeText(outcome)}`;

/** Targets for a dry run's JSON: its tarballs are gone, so their paths aren't listed. */
export const withoutTarballs = (
	targets: PublishTarget[],
): Array<Omit<PublishTarget, 'tarball'>> =>
	targets.map(({tarball: _gone, ...rest}) => rest);

export const dryRunLine = (target: PublishTarget): string =>
	`${targetLine(target)}: ${target.published ? 'already on npm' : 'would publish'}`;

/**
 * What a publish after the push that left a package off npm says, and how to
 * finish it. A first version that trusted publishing skipped needs a person.
 */
export const unpublished = (
	tag: string,
	name: string,
	version: string,
	firstVersion = false,
): string =>
	firstVersion
		? `${tag} is tagged and pushed; ${name} ${version} isn't on npm: trusted publishing can't publish a package's first version. Publish it from your machine with \`chamoji publish --from ${tag}\`, or with an npm token, then add the trusted publisher on npmjs.com.`
		: `${tag} is tagged and pushed; ${name} ${version} isn't on npm. Run \`chamoji publish --from ${tag}\` to publish it.`;

export const nothingToPublish = (count: number): string =>
	count === 0
		? 'chamoji: nothing to publish (no package to publish here)'
		: 'chamoji: nothing to publish (every package is already on npm, or was skipped)';

/** What a publish runs with; see `publishTools`. */
export type PublishTools = {
	method: PublishMethod;
	env: Record<string, string>;
	npm: NpmRunner;
	ci: boolean;
	registries: string[];
};

/**
 * What a publish runs with: the complete environment (`runNpm` adds
 * nothing, and an unset entry in io.env removes the variable the process
 * has) with the credentials only this gets, how it will publish, npm,
 * whether this is CI, and the registries that may hold a token.
 */
export function publishTools(
	ctx: CommandContext,
	config: ChamojiConfig,
): PublishTools {
	const {io} = ctx;
	const env = processEnv();
	for (const [key, value] of Object.entries(io.env ?? {})) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}

	Object.assign(env, io.credentials);
	return {
		env,
		method: publishMethod(env),
		npm: io.npm ?? runNpm,
		ci: env['CI'] === 'true',
		registries: config.release?.publish?.registries ?? [],
	};
}

/**
 * The method `plan` publishes with, once the credentials are checked.
 * Nothing to publish needs no credentials. A failed check discards the
 * plan and throws.
 */
export async function publishAuth(
	ctx: CommandContext,
	plan: PublishPlan,
	tools: PublishTools,
): Promise<PublishMethod> {
	const {io} = ctx;
	try {
		return plan.targets.some(target => !target.published)
			? await checkPublishAuth(plan, {
					env: tools.env,
					npm: tools.npm,
					fetch: io.fetch ?? (fetch as FetchLike),
					ci: tools.ci,
					registries: tools.registries,
				})
			: publishMethod(tools.env);
	} catch (error) {
		await discardPublishPlan(plan);
		throw error;
	}
}

/** Publishes a checked plan; `runPublish` removes its tarballs, however it ends. */
export async function publishPlan(
	plan: PublishPlan,
	method: PublishMethod,
	tools: PublishTools,
): Promise<PublishOutcome[]> {
	return runPublish(plan, {
		method,
		npm: tools.npm,
		env: tools.env,
		ci: tools.ci,
		registries: tools.registries,
	});
}

/** One stderr line per package a plan skips, such as an app. */
export function skippedLines(plan: PublishPlan): string[] {
	return plan.skipped.map(
		item => `chamoji: skipped ${item.name}: ${item.reason}\n`,
	);
}

/** What a publish said about each package it didn't publish, on stderr. */
export function reportOutcomes(
	ctx: CommandContext,
	outcomes: PublishOutcome[],
): void {
	const {io} = ctx;
	for (const outcome of outcomes) {
		if (outcome.message && outcome.status !== 'published') {
			io.stderr(`chamoji: ${outcome.name}: ${outcome.message}\n`);
		}
	}
}
