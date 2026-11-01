import type {IntentCard, Trailer} from './types.js';

const INTENT_LINE = /^(why|constraint|gotcha|follow-up):[ \t]+(\S.*)$/im;

const CARD_KEYS: Record<string, keyof IntentCard> = {
	why: 'why',
	constraint: 'constraint',
	gotcha: 'gotcha',
	'follow-up': 'followUp',
};

/**
 * The intent card a commit carries in `Why:`, `Constraint:`, `Gotcha:` and
 * `Follow-up:` lines. Git's own trailer block comes first. GitHub's squash
 * message puts trailers mid-body, where git doesn't parse them, so the body
 * is scanned line by line after that. Values keep their order, and a repeat
 * is dropped. Undefined when the commit has no such line.
 */
export function readIntent(
	trailers: Trailer[],
	body: string,
): IntentCard | undefined {
	const card: IntentCard = {why: [], constraint: [], gotcha: [], followUp: []};
	const lines = [
		...trailers.map(trailer => [trailer.key, trailer.value] as const),
		...body.split('\n').map(line => {
			const match = INTENT_LINE.exec(line.trim());
			return [match?.[1] ?? '', match?.[2] ?? ''] as const;
		}),
	];
	for (const [key, value] of lines) {
		const field = CARD_KEYS[key.toLowerCase()];
		const text = value.trim();
		if (field && text && !card[field].includes(text)) {
			card[field].push(text);
		}
	}

	return Object.values(card).some(values => values.length > 0)
		? card
		: undefined;
}
