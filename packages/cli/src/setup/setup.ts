import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
	answersFromSection,
	assertGitRepo,
	CONFIG_FILE,
	detect,
	getRemoteWebUrl,
	loadConfig,
	previewReleases,
	readReleaseSection,
	recommend,
	releaseSection,
	replayReleases,
	runGit,
	summary,
	writeReleaseSection,
	type Detection,
	type Preview,
	type ReplayLine,
	type SetupAnswers,
	type Source,
} from '@chamoji/core';
import {writeAtomically} from '../init.js';
import type {GhRunner, Io} from '../run.js';
import {stripControlLines} from '../text.js';
import {
	asksReleases,
	plannedResult,
	runStep,
	STEP_NAMES,
	stepPrompts,
	stepStates,
	type StepName,
	type StepResult,
	type StepState,
} from './steps.js';

/** What the screen hands back: the answers to save and the steps picked, or a cancel. */
export type ScreenResult =
	{saved: true; answers: SetupAnswers; steps: StepName[]} | {saved: false};

/**
 * What `io.setupScreen` gets. The screen shows `detection` through `initial`
 * (the recommended answers, or the existing section's), offers the steps in
 * `states` that aren't done, and calls `preview` and `replay` as the answers
 * change. It draws on stderr, `columns` wide.
 *
 * Every string in these props can come from the repo (folder, package, tag
 * and remote names, versions, notes), so the screen must pass each one
 * through `stripControlLines` before drawing it. Setup hands them over as
 * detected, since the same values are matched against tags and paths.
 *
 * `states` holds only the steps in scope. The releases state is done when the
 * config already has a section or a single package needs none; then releases
 * has nothing to ask and the screen offers only the per-clone steps that
 * aren't done (ruling R16). `chamoji setup releases` asks it again, so there
 * the releases state comes as not done. With nothing to ask at all, setup
 * doesn't open the screen.
 */
export type SetupScreenProps = {
	detection: Detection;
	initial: SetupAnswers;
	states: StepState[];
	preview: (answers: SetupAnswers) => Promise<Preview>;
	replay: (answers: SetupAnswers) => Promise<ReplayLine[]>;
	columns: number;
};

/** The interactive setup screen (Task 7). Setup only calls it when stderr is a terminal. */
export type SetupScreen = (props: SetupScreenProps) => Promise<ScreenResult>;

const NO_TERMINAL =
	'chamoji: setup needs a terminal to ask; run chamoji setup --yes to take every recommended answer';
const SINGLE =
	"One package, so chamoji release already knows what to do; there's nothing to set up for releases.";
const WROTE = `Wrote ${CONFIG_FILE}. Review it and commit it; git restore ${CONFIG_FILE} undoes this.`;
const UP_TO_DATE = `${CONFIG_FILE} is already up to date.`;
const CANCELLED = 'Setup cancelled; nothing was saved.';
const SQUASH_ADVICE =
	'Squash merges here keep only the PR title or its description, which drops the commits\' Release:, Workstream: and intent-card lines. In the repo\'s Settings → General → Pull Requests, set "Default commit message" for squash merges to "Default message" or "Pull request title and commit details".';
const SQUASH_QUERY =
	'[.allow_squash_merge, .squash_merge_commit_title, .squash_merge_commit_message] | @tsv';
/**
 * GitHub's squash_merge_commit_message values that keep no commit bodies:
 * BLANK ("Pull request title") and PR_BODY ("Pull request title and
 * description"). COMMIT_MESSAGES keeps them.
 */
const BODILESS = new Set(['BLANK', 'PR_BODY']);
/** How long the squash-merge check may take before setup goes on without it. */
const SQUASH_TIMEOUT_MS = 5000;

/** What a step would do, said when there's no terminal to ask. */
const WOULD: Record<Exclude<StepName, 'releases'>, string> = {
	memory: 'Setup would also share memory through origin, as chamoji init does.',
	agents:
		'Setup would also connect Claude Code here, as chamoji init --agents does.',
	hook: 'Setup would also install the commit composer hook in this clone.',
};
const WOULD_OFFER =
	'Setup would also offer the commit composer hook for this clone.';
/**
 * Results that mean a step would change nothing (ruling R15). Skipped is a
 * step not offered; offered is the hook, which is never assumed (R17).
 */
const SETTLED = new Set<StepResult>([
	'unchanged',
	'nothing-to-do',
	'skipped',
	'offered',
]);

/** `owner/name` from an origin on github.com, or undefined for anywhere else. */
export async function githubRepo(cwd: string): Promise<string | undefined> {
	const url = await getRemoteWebUrl(cwd);
	return /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url ?? '')?.[1];
}

/**
 * The advice line when this repo's squash merges keep only the PR title or
 * description, which drops the commit lines chamoji reads. Null with no gh, no GitHub origin,
 * any other setting, any failure, or no answer within `timeoutMs`.
 */
export async function checkSquashMerge(
	gh: GhRunner,
	root: string,
	timeoutMs = SQUASH_TIMEOUT_MS,
): Promise<string | null> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<null>(resolve => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		// The check never keeps chamoji running on its own.
		timer.unref();
	});
	const ask = async (): Promise<string | null> => {
		const repo = await githubRepo(root);
		if (!repo) return null;
		const answer = await gh(['api', `repos/${repo}`, '--jq', SQUASH_QUERY], {
			timeoutMs,
		});
		if (!answer.ok) return null;
		const [allowed, , message = ''] = answer.message.trim().split('\t');
		return allowed === 'true' && BODILESS.has(message) ? SQUASH_ADVICE : null;
	};

	try {
		return await Promise.race([ask(), late]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

type ReleasesPlan = {
	result: Extract<StepResult, 'written' | 'unchanged' | 'nothing-to-do'>;
	section: Record<string, unknown>;
	/** The config file's new text when `result` is written. */
	text: string;
};

/** What the releases step writes for these answers. A single package with no section gets nothing. */
function planReleases(
	original: string | null,
	existing: unknown,
	detection: Detection,
	answers: SetupAnswers,
): ReleasesPlan {
	const section = releaseSection(answers);
	if (existing === undefined && detection.layout.kind === 'single') {
		return {result: 'nothing-to-do', section, text: original ?? ''};
	}

	const {text, changed} = writeReleaseSection(original, section);
	return {result: changed ? 'written' : 'unchanged', section, text};
}

/**
 * chamoji.config.json's text and permissions, or null text when there's none.
 * Refuses a symlink or anything but a file: git commits the link, not what
 * it points to, so setup would change a file the repo doesn't hold.
 */
async function readConfigFile(
	file: string,
): Promise<{original: string | null; mode?: number}> {
	const found = await lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (!found) return {original: null};
	if (found.isSymbolicLink()) {
		throw new Error(
			`${CONFIG_FILE} is a symlink; chamoji won't write through links`,
		);
	}

	if (!found.isFile()) throw new Error(`${CONFIG_FILE} is not a file`);
	return {original: await readFile(file, 'utf8'), mode: found.mode};
}

/** `chamoji setup [step]`: see the help text and the spec's "chamoji setup". */
export async function runSetup(
	args: {step?: StepName; yes: boolean; json: boolean; explain: boolean},
	io: Io,
): Promise<number> {
	await assertGitRepo(io.cwd);
	const root = (await runGit(['rev-parse', '--show-toplevel'], io.cwd)).trim();
	const file = path.join(root, CONFIG_FILE);
	const releases = args.step === undefined || args.step === 'releases';
	// Only the releases step reads or writes the config.
	const {original, mode} = releases
		? await readConfigFile(file)
		: {original: null, mode: undefined};
	const existing = readReleaseSection(original).release;
	// Started first, so the network never holds up detection or the screen.
	const squashing =
		releases && io.gh ? checkSquashMerge(io.gh, root) : Promise.resolve(null);
	const detection = releases ? await detect(root) : null;
	let answers =
		detection &&
		(existing === undefined
			? recommend(detection)
			: answersFromSection(existing, detection));
	const states = await stepStates(io, detection, existing);
	const scope = args.step ? [args.step] : [...STEP_NAMES];
	// Names, versions and paths come from the repo; none reaches the terminal raw.
	const out = args.json
		? () => {}
		: (text: string) => io.stdout(stripControlLines(text));
	const terminal = Boolean(io.setupScreen) && process.stderr.isTTY === true;
	// What the screen is given: the steps in scope, with a named releases step
	// asked again whatever its state (ruling R16).
	const asked = states
		.filter(state => scope.includes(state.step))
		.map(state =>
			state.step === 'releases' && args.step === 'releases'
				? {...state, done: false}
				: state,
		);
	// The screen opens only with something to ask; it shows the states itself.
	const screening =
		!args.yes &&
		!args.json &&
		terminal &&
		releases &&
		(asksReleases(detection!, asked) || stepPrompts(asked).length > 0);

	if (!args.step && !screening) {
		out(`${states.map(state => state.line).join('\n')}\n\n`);
	}

	// Which per-clone steps run: the named one, the ones the screen picked, or
	// with --yes every offered one that isn't done, never the hook.
	let picked: StepName[];
	if (args.yes) {
		picked = args.step
			? [args.step]
			: states
					.filter(
						state => state.step !== 'hook' && state.offered && !state.done,
					)
					.map(state => state.step);
	} else if (!args.json && terminal) {
		if (!releases) {
			picked = [args.step!];
		} else if (!screening) {
			picked = [];
		} else {
			const result = await io.setupScreen!({
				detection: detection!,
				initial: answers!,
				states: asked,
				...previews(root, io),
				columns: process.stderr.columns ?? 80,
			});
			if (!result.saved) {
				io.stderr(`${CANCELLED}\n`);
				return 1;
			}

			answers = result.answers;
			picked = result.steps.filter(step => scope.includes(step));
		}
	} else {
		return report(await squashing);
	}

	const squash = await squashing;

	// Doing it.
	const plan = releases
		? planReleases(original, existing, detection!, answers!)
		: null;
	const results: Array<{step: StepName; result: StepResult}> = [];
	const wrote: string[] = [];
	let code = 0;
	if (plan) {
		describeReleases(plan, true);
		if (plan.result === 'written') {
			await writeAtomically(file, plan.text, mode);
			wrote.push(CONFIG_FILE);
			out(`${WROTE}\n`);
		}

		results.push({step: 'releases', result: plan.result});
	}

	const quiet: Io = args.json ? {...io, stdout: () => {}} : io;
	for (const state of states) {
		if (state.step === 'releases' || !scope.includes(state.step)) continue;
		if (!picked.includes(state.step)) {
			const planned = plannedResult(state, false);
			results.push({
				step: state.step,
				result: planned === 'written' ? 'skipped' : planned,
			});
			continue;
		}

		const ran = await runStep(state.step, state, quiet);
		results.push({step: state.step, result: ran.result});
		wrote.push(...ran.wrote);
		if (code === 0) code = ran.code;
	}

	if (squash) out(`${squash}\n`);
	if (args.json) printReport(plan, results, wrote, squash);
	return code;

	/** No --yes and no terminal, or --json without --yes: say what setup would do. */
	function report(squash: string | null): number {
		const plan = releases
			? planReleases(original, existing, detection!, answers!)
			: null;
		const results: Array<{step: StepName; result: StepResult}> = [];
		if (plan) {
			describeReleases(plan, false);
			results.push({step: 'releases', result: plan.result});
		}

		for (const state of states) {
			if (state.step === 'releases' || !scope.includes(state.step)) continue;
			const result = plannedResult(state, Boolean(args.step));
			results.push({step: state.step, result});
			if (result === 'written') out(`${WOULD[state.step]}\n`);
			if (result === 'offered') out(`${WOULD_OFFER}\n`);
		}

		if (squash) out(`${squash}\n`);
		// Nothing would change: exit 0 in both modes (ruling R15).
		const settled = results.every(({result}) => SETTLED.has(result));
		if (args.json) {
			printReport(plan, results, [], squash);
		} else if (!settled) {
			io.stderr(`${NO_TERMINAL}\n`);
		}

		return settled ? 0 : 2;
	}

	/** The summary and, before writing, the section; or why there's nothing to write. */
	function describeReleases(plan: ReleasesPlan, doing: boolean): void {
		if (plan.result === 'nothing-to-do') {
			out(`${SINGLE}\n`);
			return;
		}

		if (plan.result === 'written') {
			out(`${summary(detection!, answers!)}\n\n`);
			if (!doing) {
				out(
					`Setup would write this release section to ${CONFIG_FILE}:\n${JSON.stringify(plan.section, null, 2)}\n\n`,
				);
			}
		}

		if (args.explain) {
			out(
				`${explain(plan.section, answers!, existing === undefined ? 'recommended' : 'kept').join('\n')}\n\n`,
			);
		}

		if (plan.result === 'unchanged') out(`${UP_TO_DATE}\n`);
	}

	function printReport(
		plan: ReleasesPlan | null,
		steps: Array<{step: StepName; result: StepResult}>,
		wrote: string[],
		squash: string | null,
	): void {
		const {layout, tags, upstream} = detection ?? {};
		io.stdout(
			`${JSON.stringify(
				{
					found: layout
						? {
								kind: layout.kind,
								units: layout.units.map(unit => unit.name),
								excluded: layout.excluded,
								inheritedTags: tags!.inherited.tags,
								upstream: {
									remote: upstream!.remote,
									name: upstream!.name,
									since: upstream!.since,
									authors: upstream!.authors,
								},
							}
						: null,
					// A single package's section is never written.
					answers:
						plan && plan.result !== 'nothing-to-do' ? plan.section : null,
					why: answers?.why ?? {},
					steps,
					wrote,
					squashMerge: squash,
				},
				null,
				2,
			)}\n`,
		);
	}
}

/** The screen's preview and replay, on the config as it is plus the answers. */
function previews(
	root: string,
	io: Io,
): Pick<SetupScreenProps, 'preview' | 'replay'> {
	let config: ReturnType<typeof loadConfig> | undefined;
	const loaded = async () => (config ??= loadConfig(root));
	return {
		preview: async answers =>
			previewReleases(
				root,
				await loaded(),
				answers,
				io.today ?? new Date().toISOString().slice(0, 10),
			),
		replay: async answers => replayReleases(root, await loaded(), answers),
	};
}

const SEGMENT = /^[A-Za-z_$][\w$]*$/;
const segment = (key: string): string =>
	SEGMENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

/** The question a value of the section answers, or null for a key setup doesn't ask about. */
function questionFor(keys: string[]): string | null {
	const [key, name, field] = keys;
	switch (key) {
		case 'shape':
		case 'sharedChanges':
		case 'rootFiles':
		case 'zeroMajor':
		case 'fixed':
		case 'rootChangelog': {
			return key;
		}

		case 'exclude': {
			return 'units';
		}

		case 'upstream': {
			return name === 'authors' ? 'upstream.authors' : 'upstream.name';
		}

		case 'units': {
			if (field === 'path') return 'units';
			if (field === 'read') return `tag:${name}`;
			return [
				'tag',
				'versionFiles',
				'buildNumber',
				'firstVersion',
				'versioning',
			].includes(field ?? '')
				? `${field}:${name}`
				: null;
		}

		case 'tags': {
			if (name === 'ignore') return 'ignore';
			return name === 'aliases' ? `alias:${field}` : null;
		}

		default: {
			return null;
		}
	}
}

/**
 * `--explain`: every value of the section with where it came from, such as
 * `release.sharedChanges = "ride-along" (recommended for apps)`. `fallback`
 * is the source of a value whose question wasn't asked.
 */
function explain(
	section: Record<string, unknown>,
	answers: SetupAnswers,
	fallback: Source,
): string[] {
	const shape = answers.shape === 'single' ? 'a single package' : answers.shape;
	const said: Record<Source, string> = {
		detected: 'detected in the repo',
		recommended: `recommended for ${shape}`,
		chosen: 'chosen',
		kept: `kept from ${CONFIG_FILE}`,
	};
	const lines: string[] = [];
	const walk = (value: unknown, keys: string[]): void => {
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			for (const [key, item] of Object.entries(value)) {
				walk(item, [...keys, key]);
			}

			return;
		}

		const name = `release${keys.map(segment).join('')}`;
		const id = questionFor(keys);
		let why: Source = id === null ? 'kept' : (answers.why[id] ?? fallback);
		// The remote and the starting point are read from the repo, whoever
		// named the base.
		if (
			keys[0] === 'upstream' &&
			(keys[1] === 'remote' || keys[1] === 'since') &&
			why !== 'kept'
		) {
			why = 'detected';
		}

		const source = keys[0] === 'schema' ? "the section's format" : said[why];
		lines.push(`${name} = ${JSON.stringify(value)} (${source})`);
	};

	walk(section, []);
	return lines;
}
