import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	cardStatePath,
	isResolveCommit,
	linesNear,
	nudgeText,
	parseCommit,
	readCardState,
	readCommitFiles,
	readCommits,
	readResolves,
	runGit,
	type CardState,
} from '@chamoji/core';
import {hookDir, inTime, type SessionBriefOptions} from './session-brief.js';

/** Claude Code waits for the hook before the agent goes on, so the nudge gets this long. */
export const NUDGE_LIMIT = 5000;

/** A commit older than this, by its committer time, was not just made. */
const RECENT = 10 * 60 * 1000;

/** What tests swap: a slow or failing state, a shorter limit and the clock. */
export type NudgeOptions = Pick<SessionBriefOptions, 'warmUp' | 'onTimeout'> & {
	readCardState?: (cwd: string) => Promise<CardState>;
	nudgeLimit?: number;
	/** Milliseconds since the epoch. */
	now?: () => number;
};

/**
 * What the PostToolUse hook prints after a `git commit`: the open and in-doubt
 * lines on the files HEAD changed, as `additionalContext`, so the agent can
 * say whether its commit ended one. Each HEAD is asked about once: it is
 * recorded before anything else is read, so a commit that failed and left
 * HEAD where it was says nothing. A commit older than 10 minutes, one that
 * carries a `Resolves:` and a resolve commit get nothing, and nor does a line
 * HEAD itself states. Undefined means print nothing, which is also what an
 * error or a state that takes longer than the limit gives.
 */
export async function resolveNudge(
	input: Record<string, unknown>,
	cwd: string,
	options: NudgeOptions,
): Promise<string | undefined> {
	const at = hookDir(input, cwd);
	return inTime(
		async () => nudge(at, options),
		at,
		options.nudgeLimit ?? NUDGE_LIMIT,
		options,
	);
}

async function nudge(
	at: string,
	options: NudgeOptions,
): Promise<string | undefined> {
	// Every path is read from the top of the work tree, as the state lists them.
	const root = (await runGit(['rev-parse', '--show-toplevel'], at)).trim();
	const head = (
		await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root)
	).trim();
	if (head === '') return undefined;
	const file = path.join(path.dirname(await cardStatePath(root)), 'nudged');
	const last = await readFile(file, 'utf8').catch(() => '');
	if (last.trim() === head) return undefined;
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, `${head}\n`);

	const committed =
		Number(
			(
				await runGit(
					[
						'log',
						'-1',
						'--no-show-signature',
						'--format=%ct',
						'--end-of-options',
						head,
						'--',
					],
					root,
				)
			).trim(),
		) * 1000;
	const now = options.now?.() ?? Date.now();
	// A committer time in the future counts as just made.
	if (!Number.isFinite(committed) || now - committed > RECENT) return undefined;

	const [raw] = await readCommits(root, `${head}^!`);
	if (raw === undefined) return undefined;
	const commit = parseCommit(raw);
	if (
		readResolves(commit.trailers, commit.body).length > 0 ||
		isResolveCommit(commit)
	) {
		return undefined;
	}

	const files = (await readCommitFiles(root, `${head}^!`)).get(head) ?? [];
	if (files.length === 0) return undefined;
	const state = await (options.readCardState ?? readCardState)(root);
	const lines = linesNear(
		{
			...state,
			lines: state.lines.filter(line => !line.sources.includes(head)),
		},
		files,
	);
	if (lines.length === 0) return undefined;
	return `${JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			additionalContext: nudgeText(lines),
		},
	})}\n`;
}
