import {CARD_ID} from './card-lines.js';
import type {Trailer} from './types.js';

/** A card line a commit marks as settled, with the reason it gave, if any. */
export type Resolve = {id: string; reason?: string};

const RESOLVES_LINE = /^resolves:[ \t]*(\S.*)$/i;
/** An id in backticks, as a pull request description writes it. */
const BACKTICKED = /^`([^`]*)`$/;
const REVERTS_LINE = /^This reverts commit ([0-9a-f]{40,64})\b/m;
/** Git's line for a merge revert, which it may wrap onto two lines. */
const MAINLINE =
	/^This reverts commit [0-9a-f]{40,64},\s+reversing\s+changes\s+made\s+to\s+([0-9a-f]{40,64})\b/m;

/**
 * The card lines a commit resolves, from `Resolves: <id> [reason]` lines.
 * Git's own trailer block comes first, then the body line by line, because
 * GitHub's squash message leaves trailers mid-body where git doesn't parse
 * them; a space after the colon is optional in both. A value is one line:
 * one id, then the reason on the same line, so in `Resolves: c-1, g-2` the
 * second id is only part of the reason. An id may be typed in capitals, end
 * in punctuation or sit in backticks; in quotes or brackets it is not read.
 * A value that is not a card id is left alone, and an id that appears twice
 * is read once.
 */
export function readResolves(trailers: Trailer[], body: string): Resolve[] {
	const values = [
		...trailers
			.filter(trailer => trailer.key.toLowerCase() === 'resolves')
			.map(trailer => trailer.value),
		...body
			.split('\n')
			.flatMap(line => RESOLVES_LINE.exec(line.trim())?.[1] ?? []),
	];

	const found = new Map<string, Resolve>();
	for (const value of values) {
		const [first = '', ...rest] = value.trim().split('\n', 1)[0]!.split(/\s+/);
		const bare = first.toLowerCase().replace(/[.,;:!?]+$/, '');
		const id = BACKTICKED.exec(bare)?.[1] ?? bare;
		if (!CARD_ID.test(id) || found.has(id)) {
			continue;
		}

		const reason = rest.join(' ').trim();
		found.set(id, reason ? {id, reason} : {id});
	}

	return [...found.values()];
}

/** The full hash in git's "This reverts commit <hash>" line. */
export function readRevertedHash(body: string): string | undefined {
	return REVERTS_LINE.exec(body)?.[1];
}

/**
 * The parent a merge revert kept, from git's "reversing changes made to
 * <hash>", which may wrap onto a second line. Undefined for a revert of a
 * plain commit, or a message that doesn't say.
 */
export function readRevertedMainline(body: string): string | undefined {
	return MAINLINE.exec(body)?.[1];
}
