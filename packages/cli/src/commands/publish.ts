import {
	buildChangelog,
	catchUp,
	discardPublishPlan,
	loadConfig,
	planPublish,
	publishMethod,
	render,
	requireNpm,
	runGit,
	stripTitle,
	type CatchUpResult,
	type ChamojiConfig,
	type FetchLike,
	type PublishOutcome,
	type PublishTarget,
} from '@chamoji/core';
import semver from 'semver';
import {stripControlLines} from '../text.js';
import {ghIn, NO_RELEASE_NEEDED, type CommandContext} from './context.js';
import {
	dryRunLine,
	nothingToPublish,
	outcomeLine,
	publishAuth,
	publishPlan,
	publishTools,
	reportOutcomes,
	skippedLines,
	withoutTarballs,
} from './publish-tools.js';
import {githubReleaseStep, printResult} from './release-steps.js';
import {releasesUnits} from './release-units.js';

/**
 * `publish --catch-up`: for each unit's latest tag (or the repo's), publishes
 * what that tag released and npm lacks, then creates its GitHub release when
 * everything is on npm and the release is missing. A tag that fails is
 * reported and the rest go on; the exit is 1 if any failed, else 0.
 */
async function publishCatchUp(ctx: CommandContext): Promise<number> {
	const {io, flags, froms} = ctx;
	if (froms.length > 0 || flags.dryRun) {
		throw new Error(
			`--catch-up looks at the latest tags itself; it doesn't take ${froms.length > 0 ? '--from' : '--dry-run'}`,
		);
	}

	const config = await loadConfig(io.cwd, flags.config);
	const tools = publishTools(ctx, config);
	await requireNpm(tools.npm, io.cwd, tools.env);
	const results = await catchUp({
		cwd: io.cwd,
		config,
		...(flags.unit.length > 0 ? {units: flags.unit} : {}),
		...(flags.tag === undefined ? {} : {tag: flags.tag}),
		npm: tools.npm,
		env: tools.env,
		method: tools.method,
		fetch: io.fetch ?? (fetch as FetchLike),
		ci: tools.ci,
		registries: tools.registries,
	});

	const lines: string[] = [];
	const tags: Array<
		CatchUpResult & {githubRelease?: 'created' | 'exists' | string}
	> = [];
	for (const result of results) {
		const {tag, outcomes, error} = result;
		const missing = outcomes.filter(outcome => outcome.status !== 'already');
		const complete =
			error === undefined &&
			outcomes.length > 0 &&
			outcomes.every(
				outcome =>
					outcome.status === 'published' || outcome.status === 'already',
			);
		const count = (
			status: PublishOutcome['status'],
			label: string = status,
		) => {
			const n = outcomes.filter(outcome => outcome.status === status).length;
			return n > 0 ? [`${label} ${n}`] : [];
		};

		let release: string | undefined;
		if (complete) release = await catchUpRelease(ctx, config, tag);

		const summary = error
			? `error: ${stripControlLines(error)}`
			: missing.length === 0
				? 'nothing missing'
				: [
						...count('published'),
						...count('failed'),
						...count('skipped'),
						...count('already', 'already on npm'),
					].join(', ');
		lines.push(
			`${tag}: ${summary}${release === undefined || release === 'exists' ? '' : `; ${releaseText(release)}`}`,
			...missing.map(outcome => `  ${outcomeLine(outcome)}`),
		);
		for (const item of result.skipped ?? []) {
			io.stderr(`chamoji: skipped ${item.name}: ${item.reason}\n`);
		}

		reportOutcomes(ctx, outcomes);
		tags.push({
			...result,
			...(error === undefined ? {} : {error: stripControlLines(error)}),
			...(release === undefined ? {} : {githubRelease: release}),
		});
	}

	const anyFailed = results.some(
		result =>
			result.error !== undefined ||
			result.outcomes.some(outcome => outcome.status === 'failed'),
	);
	const anyPublished = results.some(result =>
		result.outcomes.some(outcome => outcome.status === 'published'),
	);
	const status = anyFailed ? 'failed' : anyPublished ? 'caught-up' : 'nothing';
	printResult(
		ctx,
		lines.length > 0 ? lines : ['no release tag to catch up on'],
		{
			status,
			tags,
		},
	);
	return anyFailed ? 1 : 0;

	function releaseText(release: string): string {
		return release === 'created'
			? 'GitHub release created'
			: `GitHub release not created: ${release}`;
	}
}

/**
 * Creates the GitHub release for `tag` when there is none: 'exists' when gh
 * finds it, 'created', or why it wasn't. Without gh, or when gh can't say
 * the release is missing, nothing is created and the answer is undefined.
 */
async function catchUpRelease(
	ctx: CommandContext,
	config: ChamojiConfig,
	tag: string,
): Promise<string | undefined> {
	const {io} = ctx;
	const gh = io.gh ?? ghIn(io.cwd);
	const viewed = await gh(['release', 'view', tag]);
	if (viewed.ok) return 'exists';
	if (/no gh CLI/i.test(viewed.message)) return undefined;
	try {
		const root = (
			await runGit(['rev-parse', '--show-toplevel'], io.cwd)
		).trim();
		const settled = await githubReleaseStep(ctx, {
			root,
			tag,
			title: tag,
			notes: await catchUpNotes(ctx, config, root, tag),
			prerelease:
				semver.prerelease(
					semver.coerce(tag, {includePrerelease: true})?.version ?? '',
				) !== null,
			forTag: tag,
		});
		const result = settled.ok
			? settled.value
			: {ok: false, message: (settled.error as Error).message};
		return result.ok ? 'created' : stripControlLines(result.message);
	} catch (error) {
		return stripControlLines((error as Error).message);
	}
}

/** The release notes for a tag already cut: what `changelog --for-tag` says, or the tag's own section in a repo without units. */
async function catchUpNotes(
	ctx: CommandContext,
	config: ChamojiConfig,
	root: string,
	tag: string,
): Promise<string> {
	const {io, flags, run} = ctx;
	if (releasesUnits(config)) {
		let notes = '';
		let problem = '';
		const code = await run(
			[
				'changelog',
				'--for-tag',
				tag,
				...(flags.config === undefined ? [] : ['--config', flags.config]),
			],
			{
				...io,
				stdout: text => (notes += text),
				stderr: text => (problem += text),
			},
		);
		if (code !== 0) throw new Error(problem.trim() || `no notes for ${tag}`);
		return notes.trim();
	}

	const changelog = await buildChangelog({
		cwd: root,
		config,
		to: tag,
		today: io.today,
	});
	const release = changelog.releases.find(item => item.tag === tag);
	if (!release) throw new Error(`no notes for ${tag}`);
	return stripTitle(render({...changelog, releases: [release]}, 'markdown'));
}

/**
 * `publish --from`: the GitHub release of each tag whose packages are now
 * all on npm, made when it is missing, as catch-up makes it. A tag with a
 * package not on npm gets none. Without gh, a note says it wasn't checked.
 */
async function fromReleases(
	ctx: CommandContext,
	config: ChamojiConfig,
	targets: PublishTarget[],
	outcomes: PublishOutcome[],
): Promise<Record<string, string>> {
	const {io, froms} = ctx;
	const releases: Record<string, string> = {};
	for (const tag of froms) {
		const own = targets.filter(target => target.tag === tag);
		const onNpm = own.every(target =>
			outcomes.some(
				outcome =>
					outcome.name === target.name &&
					outcome.version === target.version &&
					(outcome.status === 'published' || outcome.status === 'already'),
			),
		);
		if (own.length === 0 || !onNpm) continue;
		// eslint-disable-next-line no-await-in-loop
		const release = await catchUpRelease(ctx, config, tag);
		if (release === undefined) {
			io.stderr(
				`chamoji: note: no gh CLI, so ${tag}'s GitHub release wasn't checked\n`,
			);
		} else {
			releases[tag] = release;
		}
	}

	return releases;
}

/** What `chamoji publish` and the Action's publish step run. */
export async function publish(ctx: CommandContext): Promise<number> {
	const {io, flags, froms} = ctx;
	if (flags.catchUp) return publishCatchUp(ctx);

	const config = await loadConfig(io.cwd, flags.config);
	const tools = publishTools(ctx, config);
	const {env, npm} = tools;
	await requireNpm(npm, io.cwd, env);
	const plan = await planPublish({
		cwd: io.cwd,
		config,
		...(froms.length > 0 ? {from: froms} : {}),
		...(flags.unit.length > 0 ? {units: flags.unit} : {}),
		...(flags.tag === undefined ? {} : {tag: flags.tag}),
		npm,
		env,
		method: tools.method,
		registries: tools.registries,
	});
	const skipped = plan.skipped;

	if (flags.dryRun) {
		await discardPublishPlan(plan);
		const lines = plan.targets.map(target => dryRunLine(target));
		for (const text of skippedLines(plan)) io.stderr(text);
		const nothing = plan.targets.every(target => target.published);
		if (flags.json) {
			printResult(ctx, [], {
				status: 'dry-run',
				method: publishMethod(env),
				packages: withoutTarballs(plan.targets),
				skipped,
			});
		} else {
			if (lines.length > 0) printResult(ctx, lines, {});
			if (nothing) io.stderr(`${nothingToPublish(plan.targets.length)}\n`);
		}

		return nothing ? NO_RELEASE_NEEDED : 0;
	}

	const method = await publishAuth(ctx, plan, tools);
	const outcomes = await publishPlan(plan, method, tools);
	for (const text of skippedLines(plan)) io.stderr(text);
	reportOutcomes(ctx, outcomes);
	const releases = await fromReleases(ctx, config, plan.targets, outcomes);

	const failed = outcomes.some(outcome => outcome.status === 'failed');
	const published = outcomes.some(outcome => outcome.status === 'published');
	const status = failed ? 'failed' : published ? 'published' : 'nothing';
	const releaseLines = Object.entries(releases).flatMap(([tag, result]) =>
		result === 'exists'
			? []
			: [
					`${tag}: ${result === 'created' ? 'GitHub release created' : `GitHub release not created: ${result}`}`,
				],
	);
	if (flags.json || outcomes.length > 0 || releaseLines.length > 0) {
		printResult(
			ctx,
			[...outcomes.map(outcome => outcomeLine(outcome)), ...releaseLines],
			{
				status,
				method,
				packages: outcomes,
				skipped,
				...(Object.keys(releases).length > 0 ? {githubReleases: releases} : {}),
			},
		);
	}

	if (failed) return 1;
	if (published) return 0;
	if (!flags.json) io.stderr(`${nothingToPublish(outcomes.length)}\n`);
	return NO_RELEASE_NEEDED;
}
