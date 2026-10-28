import {findGitmoji, normalizeEmoji} from '../gitmojis.js';

/** What git tells a prepare-commit-msg hook, plus the state around it. */
export type HookInput = {
	/** prepare-commit-msg's second argument: message, template, merge, squash or commit. */
	source?: string;
	/** The current contents of the message file. */
	message: string;
	isTTY: boolean;
	env: Record<string, string | undefined>;
	/** A rebase or cherry-pick sequence is in progress. */
	rebasing: boolean;
};

// -m/-F, merges, squashes and amends (or -c/-C) already have their message.
const SKIP_SOURCES: Record<string, string> = {
	message: 'the message came from -m or -F',
	merge: 'this is a merge commit',
	squash: 'this is a squash commit',
	commit: 'this is an amend or reuses a commit message',
};

/**
 * Whether the hook should open the composer. It never does when there's no
 * terminal to ask on, so scripts, CI and editors' commit UIs are untouched.
 */
export function shouldPrompt(
	input: HookInput,
): {prompt: true} | {prompt: false; reason: string} {
	const skip = input.source ? SKIP_SOURCES[input.source] : undefined;
	if (skip) return {prompt: false, reason: skip};
	if (input.rebasing) return {prompt: false, reason: 'a rebase is in progress'};
	if (input.env.CI) return {prompt: false, reason: 'running in CI'};
	if (!input.isTTY) return {prompt: false, reason: 'no terminal to ask on'};

	const firstLine =
		input.message
			.split('\n')
			.find(line => line.trim() && !line.startsWith('#')) ?? '';
	if (findGitmoji(normalizeEmoji(firstLine))) {
		return {prompt: false, reason: 'the message already has a gitmoji'};
	}

	return {prompt: true};
}
