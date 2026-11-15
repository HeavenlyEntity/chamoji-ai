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
 * A line's text with the differences that don't change its meaning removed:
 * Unicode compatibility forms, case, runs of whitespace, and any trailing
 * punctuation. Two lines that normalize alike are the same line.
 */
export function normalizeLine(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replaceAll(/\s+/g, ' ')
		.trim()
		.replace(/[.,;:!?]+$/, '');
}

/**
 * The id a card line is known by. It comes from the line's kind and text
 * alone, so it survives a rebase or a squash that carries the line along.
 */
export function cardLineId(kind: CardKind, text: string): string {
	const hash = createHash('sha256')
		.update(`${kind}\n${normalizeLine(text)}`)
		.digest('hex');
	return `${KIND_LETTER[kind]}-${hash.slice(0, 8)}`;
}

/**
 * Every constraint, gotcha and follow-up line of a card, in that order, each
 * with its id. Lines that normalize alike are one line, and the first
 * wording is kept.
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
			const id = cardLineId(kind, text);
			if (!seen.has(id)) {
				seen.add(id);
				lines.push({id, kind, text});
			}
		}
	}

	return lines;
}
