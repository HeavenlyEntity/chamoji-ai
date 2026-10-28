import {getGitmoji, normalizeEmoji} from '../gitmojis.js';

/** What the composer collects. `gitmoji` is a code without colons. */
export type CommitDraft = {
	gitmoji: string;
	scope?: string;
	title: string;
	body?: string;
	/** Becomes a `Why:` trailer, the first intent card (milestone 7). */
	why?: string;
	/** `true`, or a description for the `BREAKING CHANGE:` trailer. */
	breaking?: string | boolean;
};

export type FormatOptions = {
	/** `emoji` writes ✨, `code` writes :sparkles: (gitmoji-cli's `emojiFormat`). */
	emojiFormat?: 'emoji' | 'code';
	capitalizeTitle?: boolean;
};

/**
 * The commit message for a draft: `<gitmoji> [(scope): ]<title>`, the body,
 * then `BREAKING CHANGE:` and `Why:` trailers. chamoji's parser reads every
 * part of it back.
 */
export function formatCommitMessage(
	draft: CommitDraft,
	options: FormatOptions = {},
): string {
	const gitmoji = getGitmoji(draft.gitmoji);
	if (!gitmoji) {
		throw new Error(`Unknown gitmoji: ${draft.gitmoji}`);
	}

	const mark =
		options.emojiFormat === 'code' ? `:${gitmoji.code}:` : gitmoji.emoji;
	let title = draft.title.trim();
	for (const prefix of [gitmoji.emoji, `:${gitmoji.code}:`]) {
		if (normalizeEmoji(title).startsWith(normalizeEmoji(prefix))) {
			title = title.slice(prefix.length).trim();
		}
	}

	if (options.capitalizeTitle && title) {
		title = title[0]!.toUpperCase() + title.slice(1);
	}

	const scope = draft.scope?.trim();
	const subject = `${mark} ${scope ? `(${scope}): ` : ''}${title}`;
	const trailers = [
		...(draft.breaking
			? [
					`BREAKING CHANGE: ${typeof draft.breaking === 'string' && draft.breaking.trim() ? draft.breaking.trim() : title}`,
				]
			: []),
		...(draft.why?.trim() ? [`Why: ${draft.why.trim()}`] : []),
	];
	return [subject, draft.body?.trim(), trailers.join('\n')]
		.filter(Boolean)
		.join('\n\n');
}
