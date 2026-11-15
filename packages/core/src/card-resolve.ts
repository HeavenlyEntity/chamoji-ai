import {CARD_ID} from './card-lines.js';
import type {CardLine} from './card-state.js';
import {readCardState} from './card-state-repo.js';
import {runGit} from './git.js';
import {readResolves} from './resolves.js';
import type {ParsedCommit} from './types.js';

/** A resolve chamoji refused to record; its message is meant for the person who asked. */
export class ResolveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ResolveError';
	}
}

const MAX_REASON = 200;
/** Any control character, a tab or newline included: a reason is one plain line. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const SUBJECT = /^📝 Resolve ([cgf]-[0-9a-f]{8})$/;

/**
 * Records that a card line ended when no code change says so: an empty
 * commit on HEAD whose `Resolves:` names the line. It is made with a plain
 * `git commit`, so the user's hooks, signing and identity apply. Everything
 * is checked before git is touched, and staged changes stop it rather than
 * ride along, since the commit must stay empty. Returns the new commit's
 * hash and the line as it read before the commit.
 */
export async function resolveLine(
	cwd: string,
	id: string,
	reason: string,
): Promise<{hash: string; line: CardLine}> {
	const why = reason.trim();
	const length = [...why].length;
	if (length < 1 || length > MAX_REASON || CONTROL.test(why)) {
		throw new ResolveError(
			'The reason must be one line of 1 to 200 characters',
		);
	}

	const wanted = id.toLowerCase();
	const line = CARD_ID.test(wanted)
		? (await readCardState(cwd)).lines.find(found => found.id === wanted)
		: undefined;
	if (!line) throw new ResolveError(`No card line has the id ${id}`);
	if (line.state === 'resolved') {
		throw new ResolveError(
			`${line.id} is already resolved by ${(line.resolvedBy?.hash ?? '').slice(0, 7)}`,
		);
	}

	if (await hasStagedChanges(cwd)) {
		throw new ResolveError(
			'You have staged changes. Commit or unstage them first, so the resolve commit stays empty.',
		);
	}

	try {
		await runGit(
			[
				'commit',
				'--allow-empty',
				'-m',
				`📝 Resolve ${line.id}`,
				'-m',
				`Resolves: ${line.id} ${why}`,
			],
			cwd,
		);
	} catch (error) {
		// A hook that said no, or no identity set: git's own words say why.
		const {stdout = '', stderr = ''} = error as {
			stdout?: string;
			stderr?: string;
		};
		throw new ResolveError(
			`${stderr}${stdout}`.trim() || (error as Error).message,
		);
	}

	const hash = (await runGit(['rev-parse', 'HEAD'], cwd)).trim();
	return {hash, line};
}

/** `git diff --cached --quiet` exits 1 when something is staged; the index is only read. */
async function hasStagedChanges(cwd: string): Promise<boolean> {
	try {
		await runGit(['diff', '--cached', '--quiet'], cwd);
		return false;
	} catch (error) {
		if ((error as {code?: unknown}).code === 1) return true;
		throw error;
	}
}

/**
 * Whether a commit is one `resolveLine` made: its subject and a `Resolves:`
 * for the same line, together. Such a commit changes no code, so the
 * changelog, the version bump and the thin-Why list leave it out. The subject
 * alone isn't enough: a commit titled that way that resolves nothing stays in.
 */
export function isResolveCommit(
	commit: Pick<ParsedCommit, 'subject' | 'trailers' | 'body'>,
): boolean {
	const id = SUBJECT.exec(commit.subject)?.[1];
	return (
		id !== undefined &&
		readResolves(commit.trailers, commit.body).some(found => found.id === id)
	);
}
