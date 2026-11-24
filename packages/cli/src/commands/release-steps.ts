import {
	discardPublishPlan,
	fetchesMemory,
	isAuthFailure,
	listMemory,
	mask,
	planPublish,
	publishMethod,
	quietGitEnv,
	requireNpm,
	restoreChanges,
	runGit,
	scrubEnv,
	syncMemory,
	writeChanges,
	type ChamojiConfig,
	type FileChange,
	type PublishMethod,
	type PublishOutcome,
	type PublishPlan,
	type ReleaseOptions,
	type WrittenChanges,
} from '@chamoji/core';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gitStep, NO_FACE, runStep} from '../face.js';
import {relabel, SYNC_LABEL, syncOutcome, syncSummary} from '../memory.js';
import {stripControlLines} from '../text.js';
import {ghIn, type CommandContext} from './context.js';
import {
	dryRunLine,
	outcomeLine,
	publishAuth,
	publishPlan,
	publishTools,
	reportOutcomes,
	skippedLines,
	unpublished,
	withoutTarballs,
	type PublishTools,
} from './publish-tools.js';

export const DEFERRED = 'the GitHub release is created after the publish';

/** The options `planningStep` gives every release plan. */
export type PlanningOptions = Pick<
	ReleaseOptions,
	| 'anyBranch'
	| 'fetch'
	| 'allowDirty'
	| 'today'
	| 'onStep'
	| 'onCredentials'
	| 'env'
>;

/** A release checked for `--publish`, its changes still in the working tree. */
export type CheckedRelease = {
	plan: PublishPlan;
	method: PublishMethod;
	tools: PublishTools;
	written: WrittenChanges;
};

export type Settled<T> = {ok: true; value: T} | {ok: false; error: unknown};

/**
 * A failure as a value, so the step around it can end on a warning when the
 * failure is folded into the summary. A credential failure still throws, so
 * gitStep can run the work again where git may ask.
 */
export async function settle<T>(work: Promise<T>): Promise<Settled<T>> {
	try {
		return {ok: true, value: await work};
	} catch (error) {
		if (isAuthFailure(error)) throw error;
		return {ok: false, error};
	}
}

/** The value, or the failure thrown again. */
export function unsettle<T>(settled: Settled<T>): T {
	if (settled.ok) return settled.value;
	throw settled.error;
}

/** `held` in the JSON, only when something was held. */
export function heldFacts(held: string[] | undefined): {held?: string[]} {
	return held && held.length > 0 ? {held} : {};
}

/**
 * How a planning step ends: warn when Jev left commits unsorted, as Jev's
 * own step would, else ok with `text`, or `Nothing to release` without it.
 */
export function planned(
	ctx: CommandContext,
	text: string | undefined,
): {
	outcome: 'ok' | 'warn';
	text: string;
} {
	const {jev} = ctx;
	const left = jev.unsorted();
	return left
		? {outcome: 'warn', text: left}
		: {outcome: 'ok', text: text ?? 'Nothing to release'};
}

/** Prints a release command's result: the lines, or the JSON under --json. */
export function printResult(
	ctx: CommandContext,
	lines: string[],
	json: Record<string, unknown>,
): void {
	const {io, flags} = ctx;
	io.stdout(
		flags.json ? `${JSON.stringify(json, null, 2)}\n` : `${lines.join('\n')}\n`,
	);
}

/**
 * The planning step of `release`, with or without units. `plan` gets the
 * options every release plan shares, the face's credential handling
 * included; `ready` names what is ready to release, or undefined when
 * nothing is.
 */
export async function planningStep<T>(
	ctx: CommandContext,
	plan: (options: PlanningOptions) => Promise<T>,
	ready: (result: T) => string | undefined,
): Promise<T> {
	const {io, flags, face, jevHost} = ctx;
	// Under a face the tag fetch must not ask for a password, or the face
	// would draw over the prompt. When it needs one, the step ends first and
	// the planner fetches again where git can ask.
	const env = face === NO_FACE ? undefined : await quietGitEnv(io.cwd);
	return runStep(
		face,
		'Planning the release',
		async step => {
			jevHost.step = step;
			try {
				return await plan({
					anyBranch: flags.anyBranch,
					fetch: io.fetchTags ?? true,
					// --publish writes the release to the tree and puts it back with
					// git, which would lose uncommitted edits to those files.
					allowDirty: flags.dryRun && !flags.publish,
					today: io.today,
					onStep() {
						step.update('Fetching tags from origin');
					},
					async onCredentials() {
						// Jev, if it runs after this, starts a step of its own.
						jevHost.step = undefined;
						step.end('warn', 'git needs your credentials');
						// A theme question still open would read what is typed at
						// git's prompt, or its late reply would land there, so the
						// face lets go of the terminal before git asks.
						await face.release();
					},
					...(env ? {env} : {}),
				});
			} finally {
				jevHost.step = undefined;
			}
		},
		result => {
			const what = ready(result);
			return planned(
				ctx,
				what === undefined ? undefined : `Ready to release ${what}`,
			);
		},
	);
}

/**
 * Pushes HEAD and `tags` as a step. Each step from here on that goes wrong
 * is folded into the summary, so its face ends on a warning; the error is
 * thrown on as before.
 */
export async function pushStep(
	ctx: CommandContext,
	root: string,
	tags: string[],
	push: (env?: Record<string, string>) => Promise<void>,
): Promise<void> {
	const {face} = ctx;
	const what = tags.join(', ');
	unsettle(
		await gitStep(
			face,
			root,
			`Pushing HEAD and ${what}`,
			async env => settle(push(env)),
			result =>
				result.ok
					? {outcome: 'ok', text: `Pushed HEAD and ${what}`}
					: {
							outcome: 'warn',
							text: `The push failed; ${what} ${tags.length === 1 ? 'is' : 'are'} kept here`,
						},
		),
	);
}

/**
 * Creates one GitHub release as a step, with its notes in a file in the git
 * dir. Returns gh's answer, or what failed before gh could answer, as a
 * value; the step ends on a warning either way. `forTag` names the tag in
 * the step when there are several releases.
 */
export async function githubReleaseStep(
	ctx: CommandContext,
	release: {
		root: string;
		tag: string;
		title: string;
		notes: string;
		prerelease: boolean;
		forTag?: string;
	},
): Promise<Settled<{ok: boolean; message: string}>> {
	const {io, face} = ctx;
	const named = release.forTag === undefined ? '' : ` for ${release.forTag}`;
	return runStep(
		face,
		`Creating the GitHub release${named}`,
		async () =>
			settle(
				(async () => {
					const notesFile = path.join(
						(
							await runGit(['rev-parse', '--absolute-git-dir'], release.root)
						).trim(),
						'chamoji-release-notes.md',
					);
					await writeFile(notesFile, `${release.notes}\n`);
					return (io.gh ?? ghIn(io.cwd))([
						'release',
						'create',
						release.tag,
						'--title',
						release.title,
						'--notes-file',
						notesFile,
						...(release.prerelease ? ['--prerelease'] : []),
					]);
				})(),
			),
		created =>
			created.ok && created.value.ok
				? {outcome: 'ok', text: `Created the GitHub release${named}`}
				: {outcome: 'warn', text: `GitHub release${named} not created`},
	);
}

/**
 * `release --publish` before the commit: writes the release to the working
 * tree, runs every publish check on what it will commit (the check
 * command, packing, dependencies, apps) and checks the npm credentials.
 * Any failure puts the tree back and throws. Under --dry-run the tree is
 * put back and the tarballs removed at once; the plan is kept for its
 * targets.
 */
export async function checkRelease(
	ctx: CommandContext,
	ready: {root: string; changes: FileChange[]},
	config: ChamojiConfig,
	versions: Map<string, string>,
): Promise<CheckedRelease> {
	const {io, flags, face} = ctx;
	const tools = publishTools(ctx, config);
	await requireNpm(tools.npm, io.cwd, tools.env);
	const written = await writeChanges(ready);
	let keep = false;
	try {
		return await runStep(
			face,
			'Checking the packages',
			async () => {
				const plan = await planPublish({
					cwd: io.cwd,
					config,
					npm: tools.npm,
					env: tools.env,
					method: tools.method,
					registries: tools.registries,
					...(flags.tag === undefined ? {} : {tag: flags.tag}),
					versions,
					skipTagCheck: true,
				});
				if (flags.dryRun) {
					await discardPublishPlan(plan);
					return {
						plan,
						method: publishMethod(tools.env),
						tools,
						written,
					};
				}

				const method = await publishAuth(ctx, plan, tools);
				keep = true;
				return {plan, method, tools, written};
			},
			({plan}) => ({
				outcome: 'ok',
				text: `Checked ${plan.targets.length} package${plan.targets.length === 1 ? '' : 's'}`,
			}),
		);
	} finally {
		if (!keep) await restoreChanges(written);
	}
}

/**
 * Whether a plain --push leaves the GitHub release to the publish: with
 * `release.publish` set, the release isn't announced before it is on npm.
 * `CHAMOJI_PUBLISH=false` (the Action's `publish: false`) says no publish
 * follows, so the release is made at once.
 */
export function defersGithubRelease(
	ctx: CommandContext,
	config: ChamojiConfig,
): boolean {
	const {flags} = ctx;
	return (
		!flags.publish &&
		Boolean(config.release?.publish) &&
		envValue(ctx, 'CHAMOJI_PUBLISH') !== 'false'
	);
}

/** A variable of the environment, as io.env overrides process.env. */
function envValue(ctx: CommandContext, name: string): string | undefined {
	const {io} = ctx;
	return io.env && name in io.env ? io.env[name] : process.env[name];
}

/** A failed release commit after `checkRelease`: the tree and the tarballs go. */
export async function uncheckRelease(checked: CheckedRelease | undefined) {
	if (!checked) return;
	await restoreChanges(checked.written);
	await discardPublishPlan(checked.plan);
}

/** What `release --dry-run --publish` adds: the targets, as `publish --dry-run` lists them. */
export function wouldPublish(
	ctx: CommandContext,
	checked: CheckedRelease | undefined,
): {
	lines: string[];
	json: Record<string, unknown>;
} {
	const {io} = ctx;
	if (!checked) return {lines: [], json: {}};
	const {targets, skipped} = checked.plan;
	for (const text of skippedLines(checked.plan)) io.stderr(text);
	return {
		lines: [
			'',
			'Would publish:',
			...(targets.length > 0
				? targets.map(target => dryRunLine(target))
				: ['nothing; no package to publish here']),
		],
		json: {packages: withoutTarballs(targets), skipped},
	};
}

/**
 * Publishes the checked tarballs after the push. Returns the outcomes,
 * and the error to exit 1 with when a package isn't on npm (it failed, or
 * trusted publishing skipped its first version): the tag is pushed by
 * then, so the error says how to finish.
 */
export async function publishAfterPush(
	ctx: CommandContext,
	checked: CheckedRelease,
): Promise<{outcomes: PublishOutcome[]; error?: string}> {
	const {io, face} = ctx;
	const {plan, method, tools} = checked;
	const failure = (outcome: {
		name: string;
		version: string;
		status?: PublishOutcome['status'];
	}): string => {
		const target = plan.targets.find(
			item => item.name === outcome.name && item.version === outcome.version,
		);
		return unpublished(
			target?.tag ?? '',
			outcome.name,
			outcome.version,
			outcome.status === 'skipped',
		);
	};

	let outcomes: PublishOutcome[];
	try {
		if (method === 'local') {
			// npm may ask for a one-time password on the terminal.
			await face.release();
			outcomes = await publishPlan(plan, method, tools);
		} else {
			outcomes = await runStep(
				face,
				'Publishing to npm',
				async () => publishPlan(plan, method, tools),
				done =>
					done.some(outcome => outcome.status === 'failed')
						? {outcome: 'warn', text: 'The publish failed'}
						: {outcome: 'ok', text: 'Published to npm'},
			);
		}
	} catch (error) {
		const first = plan.targets.find(target => !target.published);
		// The npm credentials are in this env; none of them is printed.
		const message = mask(
			stripControlLines((error as Error).message),
			scrubEnv(tools.env).secrets,
		);
		io.stderr(`chamoji: ${message}\n`);
		return {
			outcomes: [],
			...(first ? {error: failure(first)} : {}),
		};
	}

	for (const text of skippedLines(plan)) io.stderr(text);
	reportOutcomes(ctx, outcomes);
	// A first version that trusted publishing skipped isn't on npm either,
	// so it gets no GitHub release.
	const missing =
		outcomes.find(outcome => outcome.status === 'failed') ??
		outcomes.find(outcome => outcome.status === 'skipped');
	return {outcomes, ...(missing ? {error: failure(missing)} : {})};
}

/** The npm lines of a release's summary. */
export function publishedLines(outcomes: PublishOutcome[]): string[] {
	return outcomes.length > 0
		? outcomes.map(outcome => `npm: ${outcomeLine(outcome)}`)
		: ['npm: nothing to publish'];
}

/** What `--on-merge` asks planning to hold back: a breaking change, when the config says majors wait for a person. */
export function holdMajors(
	ctx: CommandContext,
	config: ChamojiConfig,
): {holdMajors?: true} {
	const {flags} = ctx;
	return flags.onMerge && config.release?.majors === 'manual'
		? {holdMajors: true}
		: {};
}

export function announceHeld(
	ctx: CommandContext,
	held: string[] | undefined,
): void {
	const {io} = ctx;
	for (const name of held ?? []) {
		io.stderr(
			`chamoji: ${name} has a breaking change and waits for a manual release (release.majors)\n`,
		);
	}
}

/**
 * Syncs only a clone that opted in with `chamoji init`, and otherwise says
 * how to, if there's anything to share. The release is out by now, so a
 * problem here is only ever reported.
 */
export async function syncAfterRelease(
	ctx: CommandContext,
): Promise<string | undefined> {
	const {io, face} = ctx;
	try {
		if (await fetchesMemory(io.cwd)) {
			const result = unsettle(
				await gitStep(
					face,
					io.cwd,
					SYNC_LABEL,
					async (env, step) =>
						settle(syncMemory(io.cwd, {env, onStep: relabel(step)})),
					synced =>
						synced.ok
							? syncOutcome(synced.value)
							: {outcome: 'warn', text: 'Memory was not synced'},
				),
			);
			return syncSummary(result);
		}

		const entries = await listMemory(io.cwd, {archived: true});
		return entries.length > 0
			? 'not synced; run chamoji init to share it with origin'
			: undefined;
	} catch (error) {
		return `not synced: ${stripControlLines((error as Error).message)}`;
	}
}
