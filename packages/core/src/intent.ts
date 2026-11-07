import type {IntentCard, Trailer} from './types.js';

const INTENT_LINE = /^(why|constraint|gotcha|follow-up):[ \t]+(\S.*)$/i;
/** Any `Key: value` line, which ends the value above it. */
const KEY_LINE = /^[\w-]+:(?:\s|$)/;

const CARD_KEYS = new Map<string, keyof IntentCard>([
	['why', 'why'],
	['constraint', 'constraint'],
	['gotcha', 'gotcha'],
	['follow-up', 'followUp'],
]);

/**
 * The intent card a commit carries in `Why:`, `Constraint:`, `Gotcha:` and
 * `Follow-up:` lines. Git's own trailer block comes first. GitHub's squash
 * message puts trailers mid-body, where git doesn't parse them, so the body
 * is scanned line by line after that. A value runs on over the following
 * lines until a blank line or the next `Key: value` line, and values keep
 * their order. Undefined when the commit has no such line.
 */
export function readIntent(
	trailers: Trailer[],
	body: string,
): IntentCard | undefined {
	const card: IntentCard = {why: [], constraint: [], gotcha: [], followUp: []};
	const lines = [
		...trailers.map(trailer => ({key: trailer.key, value: trailer.value})),
		...readBodyLines(body),
	];
	for (const {key, value} of lines) {
		const field = CARD_KEYS.get(key.toLowerCase());
		const text = value.trim();
		if (field && text) {
			card[field].push(text);
		}
	}

	card.why = dropStarts(card.why);
	card.constraint = dropStarts(card.constraint);
	card.gotcha = dropStarts(card.gotcha);
	card.followUp = dropStarts(card.followUp);

	return Object.values(card).some(values => values.length > 0)
		? card
		: undefined;
}

/** The intent lines in a body, each with the lines wrapped onto it. */
function readBodyLines(body: string): Array<{key: string; value: string}> {
	const found: Array<{key: string; value: string}> = [];
	let open = false;
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		const match = INTENT_LINE.exec(line);
		if (match) {
			found.push({key: match[1]!, value: match[2]!.trim()});
			open = true;
		} else if (open && line && !KEY_LINE.test(line)) {
			found.at(-1)!.value += ` ${line}`;
		} else {
			open = false;
		}
	}

	return found;
}

/**
 * Drops repeats, and a value that is only the start of a longer one: git
 * can hand back a trailer cut at its first line while the body has the
 * whole thing.
 */
function dropStarts(values: string[]): string[] {
	return values.filter(
		(value, index) =>
			!values.some(
				(other, otherIndex) =>
					other.startsWith(`${value} `) ||
					(other === value && otherIndex < index),
			),
	);
}
