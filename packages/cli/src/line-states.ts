import {
	cardLineId,
	linesFor,
	linesOf,
	publicLine,
	readCardState,
	type CardState,
	type IntentCard,
	type PublicLine,
	type WhyClues,
} from '@chamoji/core';
import type {Io} from './run.js';
import {stripControl} from './text.js';
import type {WhyReading} from './why.js';

const CARD_LABELS: [keyof IntentCard, string][] = [
	['why', 'Why'],
	['constraint', 'Constraint'],
	['gotcha', 'Gotcha'],
	['followUp', 'Follow-up'],
];

/**
 * A card as `Label: value` lines, safe to print. With `lines`, a constraint,
 * gotcha or follow-up line they hold carries its id and state in brackets
 * after the label. A line they don't hold, and every Why, prints as it
 * always did.
 */
export function cardLines(
	card: IntentCard | undefined,
	lines?: PublicLine[],
): string[] {
	const byId = new Map((lines ?? []).map(line => [line.id, line]));
	return CARD_LABELS.flatMap(([key, label]) =>
		(card?.[key] ?? []).map(value => {
			const line = key === 'why' ? undefined : byId.get(cardLineId(key, value));
			const tag = line ? ` [${stateTag(line)}]` : '';
			return `${label}${tag}: ${stripControl(value)}`;
		}),
	);
}

/** How much of a resolve's reason a printed line shows. */
const MAX_REASON = 200;

/** A hash as people read it in a terminal. */
const shortHash = (hash: string) => stripControl(hash).slice(0, 7);

/** What goes in a printed line's brackets: its id, then its state unless open. */
function stateTag(line: PublicLine): string {
	const id = stripControl(line.id);
	switch (line.state) {
		case 'open': {
			return id;
		}

		case 'resolved': {
			if (!line.resolvedBy) return `${id}, resolved`;
			// A `]` in the reason would read as the end of the brackets.
			const reason = [...oneLine(line.resolvedBy.reason).replaceAll(']', ')')]
				.slice(0, MAX_REASON)
				.join('');
			return `${id}, resolved by ${shortHash(line.resolvedBy.hash)}: ${reason}`;
		}

		case 'in-doubt': {
			return line.replacedBy === undefined
				? `${id}, in doubt`
				: `${id}, in doubt: its code was replaced by ${shortHash(line.replacedBy)}`;
		}

		case 'off-branch': {
			return `${id}, off branch`;
		}

		case 'reverted': {
			return line.revertedBy === undefined
				? `${id}, reverted`
				: `${id}, reverted by ${shortHash(line.revertedBy)}`;
		}
	}
}

/** Text from a commit message on one line, with no control characters. */
function oneLine(text: string): string {
	return stripControl(text.replaceAll(/\s+/g, ' ')).trim();
}

/** The card state as a command read it, and whether reading it failed. */
export type StateRead = {state: CardState | undefined; unavailable: boolean};

/** Said on stderr when a command's cards are shown without their line states. */
export const LINES_UNAVAILABLE =
	'chamoji: line states could not be read, so cards are shown without them\n';

/**
 * The card state, read once for a command or tool call, when any of `cards`
 * has a line that can have one. A state only adds to an answer, so when git
 * can't work it out the answer still comes, with every card as it was before
 * states existed and `unavailable` set, so the reply can say so.
 */
export async function readStateFor(
	cwd: string,
	cards: Array<IntentCard | undefined>,
): Promise<StateRead> {
	if (!cards.some(card => linesOf(card).length > 0)) {
		return {state: undefined, unavailable: false};
	}

	try {
		return {state: await readCardState(cwd), unavailable: false};
	} catch {
		return {state: undefined, unavailable: true};
	}
}

/** What a JSON or MCP reply adds at its top level when the states could not be read. */
export function unavailable(read: StateRead): {linesUnavailable?: true} {
	return read.unavailable ? {linesUnavailable: true} : {};
}

/** For text output: one line on stderr when the states could not be read. */
export function warnUnavailable(read: StateRead, io: Pick<Io, 'stderr'>): void {
	if (read.unavailable) io.stderr(LINES_UNAVAILABLE);
}

/**
 * A card's lines as a reply carries them, beside the card. Undefined, so the
 * reply leaves `lines` out, when there is no state or the card has no line it
 * knows. Line text and reasons come from commits others wrote, so every
 * string is cleaned like any other text from outside.
 */
export function replyLines(
	state: CardState | undefined,
	card: IntentCard | undefined,
): PublicLine[] | undefined {
	if (!state) return undefined;
	const lines = linesFor(state, card).map(line => cleanLine(publicLine(line)));
	return lines.length > 0 ? lines : undefined;
}

/**
 * Every card a reading shows: the merged card, which holds any added later,
 * and each nearby clue's. Its state is read once, for all of them.
 */
export function readingCards(
	reading: WhyReading,
): Array<IntentCard | undefined> {
	return [
		reading.card,
		...(reading.clues?.nearby ?? []).map(near => near.card),
	];
}

/**
 * Clues with each nearby commit's lines beside its card. An agent reads them
 * when a Why is thin, so a line that ended there must not look open.
 */
export function cluesWithLines(
	clues: WhyClues | undefined,
	state: CardState | undefined,
): WhyClues | undefined {
	return (
		clues && {
			...clues,
			nearby: clues.nearby.map(near => withLines(near, state)),
		}
	);
}

/** `item` with its card's lines right after `card`, or as it was when there are none. */
export function withLines<T extends {card?: IntentCard}>(
	item: T,
	state: CardState | undefined,
): T & {lines?: PublicLine[]} {
	const lines = replyLines(state, item.card);
	if (!lines) return item;
	return Object.fromEntries(
		Object.entries(item).flatMap(([key, value]) =>
			key === 'card'
				? [
						[key, value],
						['lines', lines],
					]
				: [[key, value]],
		),
	) as T & {lines: PublicLine[]};
}

function cleanLine(line: PublicLine): PublicLine {
	const {resolvedBy, replacedBy, replaces, workstream, revertedBy} = line;
	return {
		...line,
		id: stripControl(line.id),
		text: stripControl(line.text),
		...(resolvedBy && {
			resolvedBy: {
				hash: stripControl(resolvedBy.hash),
				date: stripControl(resolvedBy.date),
				reason: oneLine(resolvedBy.reason),
			},
		}),
		...(replacedBy === undefined ? {} : {replacedBy: stripControl(replacedBy)}),
		...(replaces === undefined ? {} : {replaces: stripControl(replaces)}),
		...(workstream && {
			workstream: {...workstream, slug: stripControl(workstream.slug)},
		}),
		...(revertedBy === undefined ? {} : {revertedBy: stripControl(revertedBy)}),
	};
}
