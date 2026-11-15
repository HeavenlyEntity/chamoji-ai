import {spawn} from 'node:child_process';
import {readBrief} from '@chamoji/core';
import {own} from './records.js';

/**
 * The sources that start a session with an empty context: a new one, one
 * after `/clear` and one after a compaction. A resumed or forked session
 * still holds the brief it was given, so it gets nothing.
 */
const SOURCES = new Set(['startup', 'clear', 'compact']);

/** Claude Code's first reply waits for the hook, so the brief gets this long. */
export const BRIEF_LIMIT = 5000;

/** What tests swap: a slow or failing brief, and a shorter limit. */
export type SessionBriefOptions = {
	readBrief?: (cwd: string) => Promise<{text: string}>;
	briefLimit?: number;
	/**
	 * Called with the hook's directory when the brief took too long, before
	 * `onTimeout`, to finish the brief elsewhere so the next session has it.
	 */
	warmUp?: (cwd: string) => void;
	/**
	 * Called when the brief took too long. The CLI exits there, since the git
	 * it started may still be running and would hold the session.
	 */
	onTimeout?: () => void;
};

/**
 * Starts `chamoji memory brief` in `cwd` as a child that outlives the hook,
 * so a brief that took too long is still built and cached. It is one run that
 * exits once the cache is written, not a daemon, and two at once only cost
 * time, since the cache writes are atomic. It never throws: a warm-up that
 * can't start leaves the next session to try again. `script` is the CLI's
 * own file, the one this process runs.
 */
export function startWarmUp(cwd: string, script = process.argv[1]): void {
	try {
		if (script === undefined) return;
		const child = spawn(process.execPath, [script, 'memory', 'brief'], {
			cwd,
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		});
		child.on('error', () => undefined);
		child.unref();
	} catch {
		// Nothing to do: the hook must still print nothing and exit 0.
	}
}

/**
 * What the SessionStart hook prints: the default brief of the repo the
 * session opens in, as `additionalContext`, with no text of its own around it.
 * The brief already says its lines are records, not instructions. Undefined
 * means print nothing: another source, an empty brief, an error or a brief
 * that took longer than the limit.
 */
export async function sessionBrief(
	input: Record<string, unknown>,
	cwd: string,
	options: SessionBriefOptions,
): Promise<string | undefined> {
	const source = own(input, 'source');
	if (typeof source !== 'string' || !SOURCES.has(source)) return undefined;
	const dir = own(input, 'cwd');
	const at = typeof dir === 'string' && dir !== '' ? dir : cwd;
	const read = options.readBrief ?? (async (where: string) => readBrief(where));
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<undefined>(resolve => {
		timer = setTimeout(resolve, options.briefLimit ?? BRIEF_LIMIT, undefined);
	});
	const reading = Promise.resolve()
		.then(async () => read(at))
		.then(brief => brief.text);
	// A brief that fails after the limit has nobody waiting for it.
	reading.catch(() => undefined);
	try {
		const text = await Promise.race([reading, late]);
		if (text === undefined) {
			try {
				options.warmUp?.(at);
			} catch {
				// A warm-up that fails changes nothing about this session.
			}

			options.onTimeout?.();
			return undefined;
		}

		if (text === '') return undefined;
		return `${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'SessionStart',
				additionalContext: text,
			},
		})}\n`;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
