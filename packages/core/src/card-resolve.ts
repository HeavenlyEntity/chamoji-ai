import {stat} from 'node:fs/promises';
import path from 'node:path';
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

/** What git leaves in the git directory while each of these is under way. */
const IN_PROGRESS = [
	'MERGE_HEAD',
	'CHERRY_PICK_HEAD',
	'REVERT_HEAD',
	'rebase-merge',
	'rebase-apply',
];

/**
 * Records that a card line ended when no code change says so: an empty
 * commit on HEAD whose `Resolves:` names the line. It is made with a plain
 * `git commit`, so the user's hooks, signing and identity apply. Everything
 * is checked before git is touched: a merge, cherry-pick, revert or rebase
 * under way stops it, since the commit would join that, and so do staged
 * changes, since the commit must stay empty. Afterwards the commit must have
 * HEAD as its one parent and HEAD's tree; when a hook changed that, the
 * commit is left where it is and a ResolveError says so. Returns the new
 * commit's hash and the line as it read before the commit.
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
		const by = line.resolvedBy?.hash.slice(0, 7);
		throw new ResolveError(
			`${line.id} is already resolved${by ? ` by ${by}` : ''}`,
		);
	}

	if (line.state === 'reverted') {
		throw new ResolveError(
			`${line.id} was withdrawn when ${(line.revertedBy ?? '').slice(0, 7)} reverted its commit`,
		);
	}

	if (await inProgress(cwd)) {
		throw new ResolveError(
			'A merge, cherry-pick, revert or rebase is in progress. Finish it first, then resolve the line.',
		);
	}

	if (await hasStagedChanges(cwd)) {
		throw new ResolveError(
			'You have staged changes. Commit or unstage them first, so the resolve commit stays empty.',
		);
	}

	const before = await commitAndTree(cwd, 'HEAD');
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
	const after = await commitAndTree(cwd, hash);
	if (
		after.parents.length !== 1 ||
		after.parents[0] !== before.hash ||
		after.tree !== before.tree
	) {
		throw new ResolveError(
			`The resolve commit ${hash.slice(0, 7)} is not empty: a hook changed files in it. Check it, and amend it if those changes were not meant to be there.`,
		);
	}

	return {hash, line};
}

/** A commit's hash, parents and tree. */
async function commitAndTree(
	cwd: string,
	revision: string,
): Promise<{hash: string; parents: string[]; tree: string}> {
	const [hash = '', tree = '', parents = ''] = (
		await runGit(
			['log', '-1', '--format=%H%n%T%n%P', '--end-of-options', revision, '--'],
			cwd,
		)
	)
		.trim()
		.split('\n');
	return {hash, tree, parents: parents.split(' ').filter(Boolean)};
}

/** Whether a merge, cherry-pick, revert or rebase is under way in this worktree. */
async function inProgress(cwd: string): Promise<boolean> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	for (const name of IN_PROGRESS) {
		try {
			await stat(path.join(gitDir, name));
			return true;
		} catch {
			// Not there, so not under way.
		}
	}

	return false;
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
