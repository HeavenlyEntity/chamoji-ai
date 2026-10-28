import {gitmojis} from 'gitmojis';
import type {SemverBump} from './types.js';

export type GitmojiInfo = {
	/** Code without colons, e.g. `white_check_mark`. */
	code: string;
	emoji: string;
	description: string;
	semver: SemverBump | null;
};

export type GitmojiMatch = {code: string; index: number; length: number};

/** Removes U+FE0F so `⚡` and `⚡️` compare equal. */
export function normalizeEmoji(text: string): string {
	return text.replaceAll('️', '');
}

export const GITMOJIS: readonly GitmojiInfo[] = gitmojis.map(gitmoji => ({
	code: gitmoji.code.slice(1, -1),
	emoji: gitmoji.emoji,
	description: gitmoji.description,
	semver: gitmoji.semver as SemverBump | null,
}));

const byCode = new Map(GITMOJIS.map(gitmoji => [gitmoji.code, gitmoji]));
const byEmoji = GITMOJIS.map(gitmoji => ({
	code: gitmoji.code,
	emoji: normalizeEmoji(gitmoji.emoji),
}));

export function getGitmoji(code: string): GitmojiInfo | undefined {
	return byCode.get(code);
}

/**
 * Finds the earliest gitmoji in already-normalized `text`, either as a known
 * `:code:` or as its unicode character.
 */
export function findGitmoji(text: string): GitmojiMatch | null {
	let best: GitmojiMatch | null = null;
	const consider = (match: GitmojiMatch) => {
		if (
			!best ||
			match.index < best.index ||
			(match.index === best.index && match.length > best.length)
		) {
			best = match;
		}
	};

	for (const match of text.matchAll(/:([a-z\d_+-]+):/g)) {
		if (byCode.has(match[1]!)) {
			consider({code: match[1]!, index: match.index, length: match[0].length});
			break;
		}
	}

	for (const {code, emoji} of byEmoji) {
		const index = text.indexOf(emoji);
		if (index !== -1) {
			consider({code, index, length: emoji.length});
		}
	}

	return best;
}
