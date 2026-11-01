import {assertRevision, readCommits, runGit} from './git.js';
import {parseCommit} from './parse.js';
import type {ParsedCommit} from './types.js';

export type BlameResult =
	{kind: 'commit'; commit: ParsedCommit} | {kind: 'uncommitted'};

/** A location can't be blamed: the text says why, in plain words. */
export class WhyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WhyError';
	}
}

/** `file:line`, split at the last colon so a file name may contain colons. */
export function parseLocation(input: string): {file: string; line: number} {
	const colon = input.lastIndexOf(':');
	const file = input.slice(0, colon);
	const line = input.slice(colon + 1);
	if (colon < 1 || !/^\d+$/.test(line) || Number(line) < 1) {
		throw new WhyError(
			`"${input}" is not a location; use <file>:<line>, such as src/app.ts:12`,
		);
	}

	return {file, line: Number(line)};
}

/**
 * The commit that last wrote `line` of `file` (1-based, in the working copy),
 * following moves and renames and ignoring whitespace-only changes. A line
 * that isn't committed yet has no commit to report.
 */
export async function blameLine(
	cwd: string,
	file: string,
	line: number,
): Promise<BlameResult> {
	try {
		await assertRevision(cwd, 'HEAD');
	} catch (error) {
		throw new WhyError((error as Error).message);
	}

	let stdout: string;
	try {
		// No revision, so the working copy is blamed and its line numbers are
		// the ones an editor shows; `--` keeps a name like -f.ts a file.
		stdout = await runGit(
			['blame', '--porcelain', '-w', '-M', '-L', `${line},${line}`, '--', file],
			cwd,
		);
	} catch (error) {
		throw new WhyError(explain(error, file));
	}

	const hash = /^([0-9a-f]{40,64}) /.exec(stdout)?.[1];
	if (!hash) throw new WhyError(`git blame gave no answer for ${file}:${line}`);
	if (/^0+$/.test(hash)) return {kind: 'uncommitted'};

	// `^!` is the commit alone, which also works for a root commit.
	const [raw] = await readCommits(cwd, `${hash}^!`);
	if (!raw) {
		throw new WhyError(
			`${hash.slice(0, 7)} is a merge commit, so it has no card`,
		);
	}

	return {kind: 'commit', commit: parseCommit(raw)};
}

/** Git's complaint, in words that name the file and no more than the user needs. */
function explain(error: unknown, file: string): string {
	const stderr = (error as {stderr?: string}).stderr ?? '';
	const lines = /has only (\d+) lines?/.exec(stderr)?.[1];
	if (lines !== undefined) {
		return `${file} has ${lines} ${lines === '1' ? 'line' : 'lines'}`;
	}

	if (/no such path/i.test(stderr)) return `No such file in HEAD: ${file}`;
	if (/cannot lstat|no such file or directory/i.test(stderr)) {
		return `${file} is in HEAD but not in the working copy`;
	}

	return (
		stderr
			.trim()
			.split('\n')[0]
			?.replace(/^fatal: /, '') || (error as Error).message
	);
}
