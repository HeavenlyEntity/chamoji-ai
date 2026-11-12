import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
	fetchesMemory,
	hasOrigin,
	loadConfig,
	MemoryError,
	runGit,
} from '@chamoji/core';
import {HookError, hookPath, installHook, readHookState} from '../hook.js';
import {
	AGENT_FILES,
	agentsConnected,
	onPath,
	setUpAgents,
	setUpMemory,
} from '../init.js';
import type {Io} from '../run.js';
import {stripControlLines} from '../text.js';

export type StepName = 'releases' | 'memory' | 'agents' | 'hook';

export const STEP_NAMES: readonly StepName[] = [
	'releases',
	'memory',
	'agents',
	'hook',
];

export const isStepName = (name: string): name is StepName =>
	(STEP_NAMES as readonly string[]).includes(name);

/**
 * Where a step stands in this repo and clone. `offered` is false for a step
 * setup won't run unasked: agents with no Claude Code here, memory with no
 * origin. `line` is what a re-run prints, such as
 * `✓ memory sharing is on in this clone`.
 */
export type StepState = {
	step: StepName;
	done: boolean;
	line: string;
	offered: boolean;
};

/** What a step did, or with no `--yes`, would do. */
export type StepResult =
	| 'written'
	| 'unchanged'
	| 'skipped'
	| 'offered'
	| 'nothing-to-do'
	| 'failed';

/** `hook install` and `setup hook` exit with this when chamoji won't touch the hook there. */
const HOOK_REFUSED = 2;

const repoRoot = async (cwd: string): Promise<string> =>
	(await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();

/**
 * Each step's state. `existing` is the config's `release` section, undefined
 * when it has none.
 */
export async function stepStates(
	io: Io,
	existing: unknown,
): Promise<StepState[]> {
	const root = await repoRoot(io.cwd);
	const origin = await hasOrigin(io.cwd);
	const memory = origin && (await fetchesMemory(io.cwd));
	const claude =
		existsSync(path.join(root, '.claude')) ||
		onPath('claude', io.env ?? process.env);
	const agents = await agentsConnected(io);
	const hook = (await readHookState(io.cwd)) === 'installed';
	return [
		{
			step: 'releases',
			done: existing !== undefined,
			line:
				existing !== undefined
					? '✓ releases are set up in chamoji.config.json'
					: "○ releases aren't set up yet",
			offered: true,
		},
		{
			step: 'memory',
			done: memory,
			line: memory
				? '✓ memory sharing is on in this clone'
				: origin
					? '○ memory sharing is off in this clone'
					: '– memory sharing needs a remote named origin',
			offered: origin,
		},
		{
			step: 'agents',
			done: agents,
			line: agents
				? '✓ Claude Code is connected here'
				: claude
					? "○ Claude Code isn't connected here yet"
					: '– no Claude Code here, so its step is skipped',
			offered: claude,
		},
		{
			step: 'hook',
			done: hook,
			line: hook
				? '✓ the commit composer hook is installed in this clone'
				: "○ the commit composer hook isn't installed in this clone; chamoji setup hook --yes installs it",
			offered: true,
		},
	];
}

/**
 * Whether this is a git repo where nothing is set up: no `release` key,
 * memory not fetched, no chamoji in `.mcp.json` and no hook. It reads the
 * same states setup does, with no layout detection, so bare `chamoji` stays
 * fast. A repo it can't read counts as set up, so the welcome stays quiet.
 */
export async function nothingSetUp(io: Io): Promise<boolean> {
	try {
		const config = await loadConfig(io.cwd);
		const states = await stepStates(io, config.release);
		return states.every(state => !state.done);
	} catch {
		return false;
	}
}

/** Whether the setup screen asks the releases questions: not once releases are done (ruling R16). */
export function asksReleases(states: StepState[]): boolean {
	const releases = states.find(state => state.step === 'releases');
	return releases !== undefined && !releases.done;
}

/** The per-clone steps the setup screen offers: those offered and not done. */
export const stepPrompts = (states: StepState[]): StepState[] =>
	states.filter(
		state => state.step !== 'releases' && state.offered && !state.done,
	);

/** `chamoji hook install`: the hook step, with its output. */
export async function setUpHook(io: Io): Promise<number> {
	try {
		const result = await installHook(io.cwd);
		if (result.status === 'snippet') {
			io.stdout(
				`core.hooksPath is ${result.hooksPath}, so chamoji didn't write a hook there. ${result.snippet}\n`,
			);
		} else {
			const what =
				result.replaced === 'gitmoji'
					? "Replaced gitmoji-cli's hook"
					: result.replaced === 'chamoji'
						? 'Updated the hook'
						: 'Installed the hook';
			io.stdout(
				`${what}: ${result.path}\nA plain \`git commit\` now opens the composer; -m, merges, amends and rebases are left alone.\n`,
			);
		}

		return 0;
	} catch (error) {
		if (error instanceof HookError) {
			io.stderr(`chamoji: ${error.message}\n`);
			return HOOK_REFUSED;
		}

		throw error;
	}
}

const readText = async (file: string): Promise<string | null> =>
	readFile(file, 'utf8').catch(() => null);

/**
 * Runs one of the per-clone and agents steps and says how it went, with the
 * shared files it changed (repo-relative) for `--json`'s `wrote`. A step that
 * fails the way steps do (git can't reach the remotes) is `failed` and lets
 * the others run; anything else, such as a ConfigVersionError, is thrown.
 */
export async function runStep(
	step: Exclude<StepName, 'releases'>,
	state: StepState,
	io: Io,
): Promise<{code: number; result: StepResult; wrote: string[]}> {
	const root = await repoRoot(io.cwd);
	// The files whose text says whether the step changed anything.
	const files =
		step === 'agents'
			? AGENT_FILES.map(file => ({file, at: path.join(root, file)}))
			: step === 'hook'
				? [{file: null, at: await hookPath(io.cwd)}]
				: [];
	const before = await Promise.all(files.map(async ({at}) => readText(at)));
	let code: number;
	try {
		code = await (step === 'memory'
			? setUpMemory(io)
			: step === 'agents'
				? setUpAgents(io)
				: setUpHook(io));
	} catch (error) {
		if (!(error instanceof MemoryError)) throw error;
		io.stderr(`chamoji: ${stripControlLines(error.message)}\n`);
		return {code: 1, result: 'failed', wrote: []};
	}

	const wrote: string[] = [];
	let changed = false;
	for (const [index, {file, at}] of files.entries()) {
		if ((await readText(at)) === before[index]) continue;
		changed = true;
		// The hook is per clone, not a file to commit.
		if (file) wrote.push(file);
	}

	if (code !== 0) return {code, result: 'failed', wrote};
	if (step === 'memory') {
		return {
			code,
			result: state.offered
				? state.done
					? 'unchanged'
					: 'written'
				: 'nothing-to-do',
			wrote,
		};
	}

	if (step === 'hook' && (await readHookState(io.cwd)) !== 'installed') {
		// core.hooksPath: chamoji printed the line to add instead.
		return {code, result: 'offered', wrote};
	}

	return {code, result: changed ? 'written' : 'unchanged', wrote};
}

/** What a step would do, for a report with no `--yes`, or a full run that doesn't run it. */
export function plannedResult(state: StepState, named: boolean): StepResult {
	if (state.step === 'memory' && !state.offered) return 'nothing-to-do';
	if (state.done) return 'unchanged';
	if (state.step === 'agents' && !state.offered && !named) return 'skipped';
	if (state.step === 'hook' && !named) return 'offered';
	return 'written';
}
