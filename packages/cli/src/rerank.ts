import type {IntentCard, MemoryHit} from '@chamoji/core';
import {redact} from './jev-classifier.js';
import {stripControl} from './text.js';

/** Puts memory hits in a new order, for a query. It never adds or drops one. */
export type MemoryReranker = (
	query: string,
	hits: MemoryHit[],
) => Promise<MemoryHit[]>;

/** The slice of the TypeSafe client this file uses (easy to fake in tests). */
export type RerankClient = {
	systemOne(request: {
		state: {query: string};
		questions: Record<
			string,
			{
				type: 'score';
				instructions: string;
				criteria: [string, string, ...string[]];
			}
		>;
	}): Promise<{answers: Record<string, {score: number}>}>;
};

/** Only the best BM25 candidates are asked about, one Score question each. */
const MAX_CANDIDATES = 10;

/** Characters of each candidate's subject and card text sent. */
const MAX_CHARS = 300;

/** Levels 0 to 3. The score Jev returns is the probability-weighted level. */
const CRITERIA: [string, string, ...string[]] = [
	'Has nothing to do with the search.',
	'Shares some words with the search but would not help the developer.',
	'Related: it covers part of what the developer is looking for.',
	'It answers what the developer is looking for.',
];

const CARD_LABELS: Array<[keyof IntentCard, string]> = [
	['why', 'Why'],
	['constraint', 'Constraint'],
	['gotcha', 'Gotcha'],
	['followUp', 'Follow-up'],
];

/**
 * Reorders the first ten hits by how well Jev (TypeSafe System One) says each
 * answers the query, and keeps the rest behind them in their BM25 order. A tie
 * keeps the BM25 order too. What is sent is the query and, per candidate, up
 * to 300 characters of its subject and card text with emails replaced: no
 * diffs, no code and no authors, because a hit holds none. Any failure leaves
 * the BM25 order, with one note, since the rerank only ever improves a list
 * that is already usable.
 */
export function jevReranker(
	client: RerankClient,
	options: {report?: (line: string) => void} = {},
): MemoryReranker {
	return async (query, hits) => {
		if (hits.length < 2) return hits;
		const candidates = hits.slice(0, MAX_CANDIDATES);
		const questions: Parameters<RerankClient['systemOne']>[0]['questions'] = {};
		for (const [index, candidate] of candidates.entries()) {
			questions[`candidate_${index}`] = {
				type: 'score',
				instructions: `A developer is searching a project's history for \`query\`. How well does this entry answer that search?\n\n${describe(candidate)}`,
				criteria: CRITERIA,
			};
		}

		try {
			const {answers} = await client.systemOne({state: {query}, questions});
			const scores = candidates.map((_, index) => {
				const score = answers[`candidate_${index}`]?.score;
				if (typeof score !== 'number' || !Number.isFinite(score)) {
					throw new TypeError(`Jev did not score candidate ${index}`);
				}

				return score;
			});
			// Array.prototype.sort is stable, so ties keep the BM25 order.
			const order = candidates
				.map((_, index) => index)
				.sort((a, b) => scores[b]! - scores[a]!);
			return [
				...order.map(index => candidates[index]!),
				...hits.slice(MAX_CANDIDATES),
			];
		} catch (error) {
			options.report?.(
				`Jev rerank failed (${stripControl((error as Error).message)}); showing the keyword search order`,
			);
			return hits;
		}
	};
}

/** The subject, then the card as `Label: value` lines, cut short. */
function describe({title, card}: MemoryHit): string {
	const lines = [
		title,
		...CARD_LABELS.flatMap(([key, label]) =>
			(card?.[key] ?? []).map(value => `${label}: ${value}`),
		),
	];
	// Redact before cutting, so no address is left half-cut and slips past.
	const text = redact(lines.join('\n'));
	return [...text.slice(0, MAX_CHARS * 2)].slice(0, MAX_CHARS).join('');
}
