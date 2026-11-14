import {judgeWhy, type PendingWhy, type WhyDraft} from '@chamoji/core';
import {stripControl} from './text.js';

/** The longest reason, on write and on read. */
export const MAX_WHY = 500;
/** The longest source label offered. */
export const MAX_SOURCE = 60;

/** One line of plain text: a reason becomes a Why: line in a commit. */
export function cleanReason(text: string): string {
	return stripControl(text).replaceAll(/\s+/g, ' ').trim();
}

/**
 * A stored reason as the composer may offer it, or undefined. The file can be
 * hand-edited or from an older version, so it is cleaned and judged again
 * here; one over the cap or thin is dropped, never cut.
 */
export function draftFrom(
	pending: PendingWhy | undefined,
): WhyDraft | undefined {
	if (!pending) return undefined;
	const text = cleanReason(pending.why);
	if (text === '' || text.length > MAX_WHY) return undefined;
	const verdict = judgeWhy(
		{why: [text], constraint: [], gotcha: [], followUp: []},
		'',
	);
	if (verdict.level === 'thin') return undefined;
	const source = cleanReason(pending.source).slice(0, MAX_SOURCE);
	return {text, source: source === '' ? "your agent's session" : source};
}
