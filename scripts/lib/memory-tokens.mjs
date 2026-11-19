// The arithmetic for the memory token benchmark. Pure functions: no git, no files.

export const CHARS_PER_TOKEN = 4;
export const WINDOWS = [250_000, 500_000, 1_000_000];

/**
 * @param {string} text
 * @returns {number} Math.ceil(text.length / 4); 0 for the empty string
 */
export function estimateTokens(text) {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * @param {number[]} numbers
 * @returns {{mean: number, median: number, min: number, max: number}} of a non-empty list; all 0 for an empty one
 */
export function summarize(numbers) {
	if (numbers.length === 0) return {mean: 0, median: 0, min: 0, max: 0};
	const sorted = [...numbers].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
	const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
	return {mean, median, min: sorted[0], max: sorted[sorted.length - 1]};
}

/**
 * One "what stands" plus `lookups` whys at the mean cost, rounded to a whole token.
 * @param {{whatStands: number, whyMean: number, lookups?: number}} input
 * @returns {number}
 */
export function typicalSwitch({whatStands, whyMean, lookups = 5}) {
	return Math.round(whatStands + lookups * whyMean);
}

const toFourDecimals = (/** @type {number} */ n) =>
	Math.round(n * 10_000) / 10_000;

/**
 * Shares are fractions of the window to 4 decimals; fits is Math.floor(window / tokens),
 * or null when tokens is 0.
 * @param {{withTokens: number, withoutTokens: number}} tokens
 * @param {number[]} [windows]
 * @returns {Array<{window: number, withShare: number, withoutShare: number, withFits: number | null, withoutFits: number | null}>}
 */
export function windowShares({withTokens, withoutTokens}, windows = WINDOWS) {
	return windows.map(window => ({
		window,
		withShare: toFourDecimals(withTokens / window),
		withoutShare: toFourDecimals(withoutTokens / window),
		withFits: withTokens === 0 ? null : Math.floor(window / withTokens),
		withoutFits:
			withoutTokens === 0 ? null : Math.floor(window / withoutTokens),
	}));
}

/**
 * withoutTokens / withTokens to 1 decimal, or null when withTokens is 0.
 * @param {number} withTokens
 * @param {number} withoutTokens
 * @returns {number | null}
 */
export function ratio(withTokens, withoutTokens) {
	if (withTokens === 0) return null;
	return Math.round((withoutTokens / withTokens) * 10) / 10;
}

/**
 * Deterministic: sort candidates by `commit` (code-unit order), take the first `n`.
 * @template {{commit: string}} T
 * @param {T[]} candidates
 * @param {number} [n]
 * @returns {T[]}
 */
export function pickSample(candidates, n = 20) {
	return [...candidates]
		.sort((a, b) => (a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : 0))
		.slice(0, n);
}
