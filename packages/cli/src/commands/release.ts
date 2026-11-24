import {
	applyRelease,
	discardPublishPlan,
	loadConfig,
	planRelease,
	pushRelease,
	type CommitClassifier,
	type PublishOutcome,
	type ReadyPlan,
} from '@chamoji/core';
import {stripControlLines} from '../text.js';
import {NO_RELEASE_NEEDED, type CommandContext} from './context.js';
import {
	announceHeld,
	checkRelease,
	DEFERRED,
	defersGithubRelease,
	githubReleaseStep,
	heldFacts,
	holdMajors,
	planningStep,
	printResult,
	publishAfterPush,
	publishedLines,
	pushStep,
	syncAfterRelease,
	uncheckRelease,
	unsettle,
	wouldPublish,
} from './release-steps.js';
import {
	monorepoHint,
	refuseUnitFlags,
	releasesUnits,
	releaseUnits,
} from './release-units.js';

/**
 * `chamoji release`: the unit release when the config releases units, else
 * the single one. Under --on-merge it does nothing unless release.trigger
 * is "merge".
 */
export async function releaseCommand(ctx: CommandContext): Promise<number> {
	const {io, flags, input, classify} = ctx;
	const config = await loadConfig(io.cwd, flags.config);
	if (flags.onMerge && config.release?.trigger !== 'merge') {
		io.stderr('chamoji: releases are manual here (release.trigger)\n');
		return NO_RELEASE_NEEDED;
	}

	if (releasesUnits(config)) {
		return await releaseUnits(ctx, config, input[1], classify);
	}

	refuseUnitFlags(ctx);
	await monorepoHint(ctx, config);
	return await release(ctx, input[1], classify);
}

async function release(
	ctx: CommandContext,
	version: string | undefined,
	classify: CommitClassifier | undefined,
): Promise<number> {
	const {io, flags} = ctx;
	const config = await loadConfig(io.cwd, flags.config);
	const plan = await planningStep(
		ctx,
		async options =>
			planRelease({
				cwd: io.cwd,
				config,
				...(version === undefined ? {} : {version}),
				...holdMajors(ctx, config),
				classify,
				...options,
			}),
		result => (result.status === 'nothing' ? undefined : result.tag),
	);

	if (plan.status === 'nothing') {
		announceHeld(ctx, plan.held);
		printResult(
			ctx,
			[
				`Nothing to release: no commit since ${plan.lastTag} implies a version bump.`,
				...(plan.unreleased.length > 0
					? [
							'Unreleased commits:',
							...plan.unreleased.map(subject => `- ${subject}`),
						]
					: ['No commits since that tag.']),
			],
			{
				status: 'nothing',
				lastTag: plan.lastTag,
				unreleased: plan.unreleased,
				...heldFacts(plan.held),
			},
		);
		return NO_RELEASE_NEEDED;
	}

	const summary = `${plan.tag} (${describeBump(plan)})`;
	const files = plan.changes.map(change => change.file);
	const checked = flags.publish
		? await checkRelease(ctx, plan, config, new Map([[plan.tag, plan.version]]))
		: undefined;
	if (flags.dryRun) {
		const would = wouldPublish(ctx, checked);
		printResult(
			ctx,
			[
				`Would release ${summary}.`,
				`files: ${files.join(', ')}`,
				...plan.warnings.map(warning => `warning: ${warning}`),
				'',
				plan.notes,
				...would.lines,
			],
			{
				status: 'dry-run',
				...facts(plan, files),
				notes: plan.notes,
				...would.json,
			},
		);
		return 0;
	}

	let commit: string;
	try {
		({commit} = await applyRelease(plan, {trailers: flags.trailer}));
	} catch (error) {
		await uncheckRelease(checked);
		throw error;
	}

	let pushed: string = `no; to ship: git push origin HEAD ${plan.tag}`;
	let pushError: string | undefined;
	let publishError: string | undefined;
	let published: PublishOutcome[] = [];
	let githubRelease: boolean | 'deferred' = false;
	let memory: string | undefined;
	if (flags.push || flags.publish) {
		try {
			await pushStep(ctx, plan.root, [plan.tag], async env =>
				pushRelease(plan, env),
			);
			pushed = `yes (HEAD and ${plan.tag})`;
			memory = await syncAfterRelease(ctx);
			if (checked) {
				({outcomes: published, error: publishError} = await publishAfterPush(
					ctx,
					checked,
				));
			}

			if (publishError) {
				pushed += published.some(outcome => outcome.status === 'failed')
					? '; no GitHub release, since the publish failed'
					: "; no GitHub release, since a package isn't on npm";
			} else if (defersGithubRelease(ctx, config)) {
				githubRelease = 'deferred';
				pushed += `; ${DEFERRED}`;
			} else {
				const result = unsettle(
					await githubReleaseStep(ctx, {
						root: plan.root,
						tag: plan.tag,
						title: plan.tag,
						notes: plan.notes,
						prerelease: plan.bump === 'prerelease',
					}),
				);
				githubRelease = result.ok;
				pushed += result.ok
					? '; GitHub release created'
					: `; GitHub release not created: ${stripControlLines(result.message)}`;
			}
		} catch (error) {
			pushError = stripControlLines((error as Error).message);
			pushed = `failed: ${pushError}`;
		} finally {
			// A push that failed leaves the tarballs; runPublish removed them otherwise.
			if (checked) await discardPublishPlan(checked.plan);
		}
	}

	if (publishError) io.stderr(`chamoji: ${publishError}\n`);

	const [changelog, ...manifests] = plan.changes;
	printResult(
		ctx,
		[
			`Released ${summary}.`,
			`changelog: ${changelog!.file}, ${changelog!.how}`,
			`bumped: ${manifests.map(change => change.file).join(', ') || 'no manifest carried the old version'}`,
			`commit: ${commit} ${plan.subject}`,
			`tag: ${plan.tag} (annotated)`,
			`pushed: ${pushed}`,
			...(checked && pushed.startsWith('yes') ? publishedLines(published) : []),
			...(memory === undefined ? [] : [`memory: ${memory}`]),
			...plan.warnings.map(warning => `warning: ${warning}`),
			...(githubRelease || pushed.startsWith('yes')
				? []
				: [
						`undo before pushing: git tag -d ${plan.tag} && git reset --hard ${plan.start.slice(0, 7)}`,
					]),
			'',
			plan.notes,
		],
		{
			status: 'released',
			...facts(plan, files),
			commit,
			pushed: pushed.startsWith('yes'),
			githubRelease,
			...(checked ? {published} : {}),
			...(pushError || publishError ? {error: pushError ?? publishError} : {}),
			...(memory === undefined ? {} : {memory}),
			notes: plan.notes,
		},
	);
	return pushError || publishError ? 1 : 0;
}

function describeBump(plan: ReadyPlan): string {
	if (plan.bump === 'first') {
		return 'first release';
	}

	return plan.lastTag ? `${plan.bump}, from ${plan.lastTag}` : plan.bump;
}

function facts(plan: ReadyPlan, files: string[]) {
	return {
		version: plan.version,
		tag: plan.tag,
		bump: plan.bump,
		from: plan.lastTag,
		files,
		warnings: plan.warnings,
	};
}
