import {createHash} from 'node:crypto';
import type {IntentCard} from './types.js';

/** The card fields whose lines carry a state: everything but `Why`. */
export type CardKind = 'constraint' | 'gotcha' | 'followUp';

/** The shape of a card line id: a kind letter, a dash and 8 hex characters. */
export const CARD_ID = /^[cgf]-[0-9a-f]{8}$/;

const KINDS: CardKind[] = ['constraint', 'gotcha', 'followUp'];

const KIND_LETTER: Record<CardKind, string> = {
	constraint: 'c',
	gotcha: 'g',
	followUp: 'f',
};

/**
 * The word hashed for each kind. It is part of every id, and ids are kept in
 * commits, so these strings must never change, even if a kind is renamed.
 */
const KIND_HASHED: Readonly<Record<CardKind, string>> = Object.freeze({
	constraint: 'constraint',
	gotcha: 'gotcha',
	followUp: 'followUp',
});

/**
 * Normalized texts that say there is nothing to note, as in `Follow-up:
 * none.`, so they are no card line, of any kind. A line that is dropped from
 * the card lines after a release loses its id, which orphans any `Resolves:`
 * that names it. So the list may grow before a release, but once released an
 * entry is never removed.
 */
const SAYS_NOTHING: readonly string[] = Object.freeze([
	'none',
	'n/a',
	'na',
	'nothing',
	'none known',
	'none yet',
	'not applicable',
]);

/**
 * A line's text with the differences that don't change its meaning removed:
 * Unicode compatibility forms, case, runs of whitespace, and a trailing run
 * of whitespace and punctuation. Two lines that normalize alike are the same
 * line; one that normalizes to nothing is no line.
 */
export function normalizeLine(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replaceAll(/\s+/g, ' ')
		.trim()
		.replace(/[\s.,;:!?]+$/, '');
}

/**
 * The id a card line is known by. It comes from the line's kind and text
 * alone, so it survives a rebase or a squash that carries the line along.
 */
export function cardLineId(kind: CardKind, text: string): string {
	const hash = createHash('sha256')
		.update(`${KIND_HASHED[kind]}\n${normalizeLine(text)}`)
		.digest('hex');
	return `${KIND_LETTER[kind]}-${hash.slice(0, 8)}`;
}

/**
 * Every constraint, gotcha and follow-up line of a card, in that order, each
 * with its id. Lines that normalize alike are one line, and the first
 * wording is kept. A line with nothing but whitespace and punctuation, or
 * one that only says there is nothing, such as `none`, is no card line: it
 * gets no id and no state. The card itself still shows it.
 */
export function linesOf(
	card: IntentCard | undefined,
): Array<{id: string; kind: CardKind; text: string}> {
	const lines: Array<{id: string; kind: CardKind; text: string}> = [];
	if (!card) {
		return lines;
	}

	const seen = new Set<string>();
	for (const kind of KINDS) {
		for (const text of card[kind]) {
			const normal = normalizeLine(text);
			if (normal === '' || SAYS_NOTHING.includes(normal)) continue;
			const id = cardLineId(kind, text);
			if (!seen.has(id)) {
				seen.add(id);
				lines.push({id, kind, text});
			}
		}
	}

	return lines;
}
