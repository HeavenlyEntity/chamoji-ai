import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
	cardStatePath,
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
import {isRecord, own} from './records.js';
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
 * HEAD where it was says nothing. Each line is asked about once per session,
 * so a second commit on the same files, or an amend, doesn't repeat it. A
 * commit older than 10 minutes and one that carries a `Resolves:` get
 * nothing, and nor does a line HEAD itself states. Undefined means print
 * nothing, which is also what an error or a state that takes longer than the
 * limit gives.
 */
export async function resolveNudge(
	input: Record<string, unknown>,
	cwd: string,
	options: NudgeOptions,
): Promise<string | undefined> {
	const at = hookDir(input, cwd);
	const session = own(input, 'session_id');
	return inTime(
		async () => nudge(at, typeof session === 'string' ? session : '', options),
		at,
		options.nudgeLimit ?? NUDGE_LIMIT,
		options,
	);
}

async function nudge(
	at: string,
	session: string,
	options: NudgeOptions,
): Promise<string | undefined> {
	// Every path is read from the top of the work tree, as the state lists them.
	const root = (await runGit(['rev-parse', '--show-toplevel'], at)).trim();
	// The record's path is found together with HEAD, so nothing is left to
	// wait for once HEAD is in.
	const [file, head] = await Promise.all([
		cardStatePath(root).then(state => path.join(path.dirname(state), 'nudged')),
		runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root).then(
			text => text.trim(),
		),
	]);
	if (head === '') return undefined;
	// The record is read and written synchronously, with nothing awaited since
	// HEAD came in, so the limit's timer can't run in between: once HEAD is
	// read it is recorded, even when the limit comes straight after.
	const last = readNudged(file);
	if (last.head === head) return undefined;
	const asked = last.session === session ? last.asked : [];
	writeNudged(file, {head, session, asked});

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

	// A resolve commit carries a Resolves: too, so this covers it.
	const [raw] = await readCommits(root, `${head}^!`);
	if (raw === undefined) return undefined;
	const commit = parseCommit(raw);
	if (readResolves(commit.trailers, commit.body).length > 0) return undefined;

	const files = (await readCommitFiles(root, `${head}^!`)).get(head) ?? [];
	if (files.length === 0) return undefined;
	const state = await (options.readCardState ?? readCardState)(root);
	const shown = new Set(asked);
	const lines = linesNear(
		{
			...state,
			lines: state.lines.filter(
				line => !line.sources.includes(head) && !shown.has(line.id),
			),
		},
		files,
	);
	if (lines.length === 0) return undefined;
	const text = nudgeText(lines);
	// Nothing is awaited from here to the return, so the ids are added only
	// when the text is handed back in time to be printed.
	writeNudged(file, {
		head,
		session,
		asked: [...asked, ...lines.map(line => line.id)],
	});
	return `${JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			additionalContext: text,
		},
	})}\n`;
}

/** How many ids of lines asked about `nudged` keeps, the newest. */
const MAX_ASKED = 500;

/**
 * What `<git dir>/chamoji/nudged` holds. Its first line is the last HEAD the
 * hook read; the second is JSON with the session that hook ran in (the input's
 * `session_id`, or the empty string) and the ids of the lines asked about in
 * that session, oldest first:
 *
 *     3f2a9c0e…
 *     {"session":"5d1c…","asked":["c-31575953","g-c018b0b5"]}
 *
 * A file of one line, as chamoji wrote it before sessions, is that HEAD with
 * nothing asked.
 */
type Nudged = {head: string; session: string; asked: string[]};

/**
 * The record in `file`. A file that can't be read counts as empty, and a
 * second line that doesn't parse as nothing asked. It never throws.
 */
function readNudged(file: string): Nudged {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return {head: '', session: '', asked: []};
	}

	const [head = '', rest = ''] = text.split('\n');
	let parsed: unknown;
	try {
		parsed = JSON.parse(rest);
	} catch {
		parsed = undefined;
	}

	const session = isRecord(parsed) ? own(parsed, 'session') : undefined;
	const asked = isRecord(parsed) ? own(parsed, 'asked') : undefined;
	return typeof session === 'string' &&
		Array.isArray(asked) &&
		asked.every(id => typeof id === 'string')
		? {head: head.trim(), session, asked}
		: {head: head.trim(), session: '', asked: []};
}

function writeNudged(file: string, {head, session, asked}: Nudged): void {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(
		file,
		`${head}\n${JSON.stringify({session, asked: asked.slice(-MAX_ASKED)})}\n`,
	);
}
