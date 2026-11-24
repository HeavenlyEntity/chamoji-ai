import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {
	getActive,
	hasMessageContent,
	readPendingWhy,
	readStagedChanges,
	shouldStamp,
	stampWorkstream,
	type WhyDraft,
} from '@chamoji/core';
import type {Advice} from '../advisor.js';
import {
	realAdvisor,
	realAdvisorClient,
	realWhyChecker,
	type AiSettings,
} from '../ai.js';
import {compose, type ComposerProps} from '../composer.js';
import type {ComposerTerminal} from '../run.js';
import {draftFromSession} from '../session-why.js';
import {openTerminal} from '../tty.js';
import {draftFrom} from '../why-draft.js';
import type {CommandContext} from './context.js';

export const realTerminal = (): ComposerTerminal | null => {
	const terminal = openTerminal();
	return terminal
		? {
				compose: async (config, advice, impact, checkWhy, draft) =>
					compose(config, terminal, advice, impact, checkWhy, draft),
				close: () => terminal.close(),
			}
		: null;
};

/** Files in the git dir that say a rebase is running. */
export const REBASE_MARKERS = ['rebase-merge', 'rebase-apply'];

/**
 * Files in the git dir that say a cherry-pick, revert or merge is waiting for
 * its commit. A `-m` commit that concludes one of them reaches the hook as a
 * plain message, so only these tell it apart; shouldPrompt doesn't use them.
 */
const SEQUENCE_MARKERS = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD'];

export function anyExists(gitDir: string, names: string[]): boolean {
	return names.some(name => existsSync(path.join(gitDir, name)));
}

/**
 * Adds the active workstream's trailer to the message in `file`. The hook
 * must never turn a commit git would abort into one that goes through, so
 * it leaves alone a message that git or the user already settled (a merge,
 * an amend, a cherry-pick or revert), an unedited `commit.template`, and a
 * message with no content yet (stampWorkstream checks that): a trailer
 * there would count as the message. Editor commits that miss out that way
 * get a one-line notice. Throws when the workstreams file is corrupt;
 * callers decide how to carry on.
 */
export async function stamp(
	ctx: CommandContext,
	file: string,
	gitDir: string,
	source: string | undefined,
): Promise<void> {
	const {io} = ctx;
	// Most repos have no active workstream: this is one stat, no git, no parsing.
	if (!existsSync(path.join(gitDir, 'chamoji', 'active'))) return;
	if (anyExists(gitDir, [...REBASE_MARKERS, ...SEQUENCE_MARKERS])) return;
	if (!shouldStamp({source, rebasing: false})) {
		if (source === 'template') await noticeUnstamped(ctx);
		return;
	}

	const message = await readFile(file, 'utf8');
	// A clean `git revert` leaves no REVERT_HEAD and says it's a plain -m
	// message, so its generated subject is the only sign of it.
	if (/^(?:Revert|Reapply) "/.test(message)) return;
	if (
		(await stampWorkstream(io.cwd, file, source)) === null &&
		source === undefined &&
		!(await hasMessageContent(io.cwd, message))
	) {
		await noticeUnstamped(ctx);
	}
}

/** Said when an editor commit is left unstamped because its message isn't written yet. */
async function noticeUnstamped(ctx: CommandContext): Promise<void> {
	const {io} = ctx;
	const slug = await getActive(io.cwd);
	if (slug !== null) {
		io.stderr(
			`chamoji: editor commits aren't stamped; add "Workstream: ${slug}" to the message, or use -m or chamoji commit.\n`,
		);
	}
}

/**
 * Jev's advice on the staged change, when the user turned it on in git
 * config and there's a key; otherwise undefined. It's never awaited here:
 * the composer shows it if it arrives in time, and any failure just means
 * no advice.
 */
export function adviceFor(
	ctx: CommandContext,
	root: string,
	settings: AiSettings,
	draft: string,
): Promise<Advice | null> | undefined {
	const {io} = ctx;
	if (!settings.composer) return undefined;
	const {sendDiffs} = settings;
	return (async () => {
		const advise = io.advise ?? (await realAdvisor(root));
		if (!advise) return null;
		const staged = await readStagedChanges(root, {sendDiffs});
		if (staged.files.length === 0) return null;
		return advise({staged, draft});
	})().catch(() => null);
}

/**
 * The Why the composer may offer on Tab. What an agent handed over with
 * `remember_why` comes first, as `now`. Only without one, and only when the
 * user turned `chamoji.whyFromSessions` on, a sentence from their own
 * Claude Code or Codex session is read, as `later`: a promise the caller
 * hands the composer as it is, so the composer opens at once and shows the
 * draft if it arrives before the user reaches the Why. The result is a
 * plain object so that awaiting it never waits for that read. Jev picks
 * among the candidates only with `chamoji.composer` on and a key.
 */
export async function draftFor(
	ctx: CommandContext,
	root: string,
	settings: AiSettings,
): Promise<{now?: WhyDraft; later?: Promise<WhyDraft | undefined>}> {
	const {io} = ctx;
	const now = draftFrom(await readPendingWhy(root));
	if (now || !settings.whyFromSessions) return {now};
	const later = (async () => {
		const staged = await readStagedChanges(root, {sendDiffs: false});
		const client = settings.composer
			? await realAdvisorClient(root)
			: undefined;
		return draftFromSession({
			root,
			home: io.home ?? homedir(),
			now: new Date(),
			stagedFiles: staged.files.map(file => file.path),
			client,
		});
	})().catch(() => undefined);
	return {later};
}

/**
 * The composer's Jev check of a Why, when the user turned it on in git
 * config and there's a key; otherwise undefined. It sends the title, the
 * Why and the staged file paths. The agent hook never gets one.
 */
export async function whyCheckFor(
	ctx: CommandContext,
	root: string,
	settings: AiSettings,
): Promise<ComposerProps['checkWhy']> {
	const {io} = ctx;
	if (!settings.whyCheck) return undefined;
	const check = io.whyChecker ?? (await realWhyChecker(io, root, true));
	if (!check) return undefined;
	let files: Promise<string[]> | undefined;
	return async (why, title) => {
		files ??= readStagedChanges(root, {sendDiffs: false}).then(staged =>
			staged.files.map(file => file.path),
		);
		return check({title, why, files: await files});
	};
}
