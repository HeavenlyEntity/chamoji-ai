import {GITMOJIS, type GitmojiInfo} from '../gitmojis.js';

/**
 * Gitmojis matching `query`, best first: the exact code, a code that starts
 * with it, a description word that starts with it, a description that
 * contains it, then a code that has its letters in order ("spk" → sparkles).
 * Ties keep the official order. An empty query lists them all in that order.
 */
export function searchGitmojis(query: string, limit = 10): GitmojiInfo[] {
	const q = query.trim().toLowerCase().replaceAll(':', '');
	if (!q) {
		return GITMOJIS.slice(0, limit);
	}

	const ranked: Array<{gitmoji: GitmojiInfo; score: number; index: number}> =
		[];
	for (const [index, gitmoji] of GITMOJIS.entries()) {
		const score = scoreOf(gitmoji, q);
		if (score !== null) {
			ranked.push({gitmoji, score, index});
		}
	}

	return ranked
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, limit)
		.map(item => item.gitmoji);
}

function scoreOf(gitmoji: GitmojiInfo, q: string): number | null {
	const code = gitmoji.code.toLowerCase();
	const description = gitmoji.description.toLowerCase();
	if (code === q) return 0;
	if (code.startsWith(q)) return 1;
	if (description.split(/[^a-z\d]+/).some(word => word.startsWith(q))) {
		return 2;
	}

	if (description.includes(q) || code.includes(q)) return 3;
	return isSubsequence(q, code) ? 4 : null;
}

function isSubsequence(needle: string, haystack: string): boolean {
	let at = 0;
	for (const char of haystack) {
		if (char === needle[at]) at++;
		if (at === needle.length) return true;
	}

	return false;
}
