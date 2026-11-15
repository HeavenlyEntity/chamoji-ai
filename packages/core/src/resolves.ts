import {CARD_ID} from './card-lines.js';
import type {Trailer} from './types.js';

/** A card line a commit marks as settled, with the reason it gave, if any. */
export type Resolve = {id: string; reason?: string};

const RESOLVES_LINE = /^resolves:[ \t]+(\S.*)$/i;
const REVERTS_LINE = /^This reverts commit ([0-9a-f]{40,64})\b/m;

/**
 * The card lines a commit resolves, from `Resolves: <id> [reason]` lines.
 * Git's own trailer block comes first, then the body line by line, because
 * GitHub's squash message leaves trailers mid-body where git doesn't parse
 * them. A value is one line: the id, then the reason on the same line. An id
 * may be typed in capitals or end in punctuation. A value that is not a card
 * id is left alone, and an id that appears twice is read once.
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
		const id = first.toLowerCase().replace(/[.,;:!?]+$/, '');
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
