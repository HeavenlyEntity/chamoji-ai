/** One thing to find. A term counts as often as its field's weight says. */
export type SearchDocument = {
	id: string;
	fields: Array<{text: string; weight: number}>;
};

/**
 * What BM25 needs from a corpus. Terms come from commit text that other
 * people wrote, so `postings` is a Map: a plain object would answer to a
 * term like `constructor` or `__proto__` before any document did.
 */
export type Bm25Index = {
	ids: string[];
	/** Each document's length in weighted terms. */
	lengths: number[];
	/** Per term, the documents holding it with its weighted count in each. */
	postings: Map<string, Array<{doc: number; count: number}>>;
	averageLength: number;
};

/** How much a repeated term keeps adding, and how hard a long document is marked down. */
const K1 = 1.2;
const B = 0.75;

/** Lowercased words: runs of Unicode letters and numbers. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(token => token !== '');
}

export function buildIndex(documents: SearchDocument[]): Bm25Index {
	const ids: string[] = [];
	const lengths: number[] = [];
	const postings = new Map<string, Array<{doc: number; count: number}>>();
	for (const [doc, document] of documents.entries()) {
		const counts = new Map<string, number>();
		let length = 0;
		for (const {text, weight} of document.fields) {
			for (const token of tokenize(text)) {
				counts.set(token, (counts.get(token) ?? 0) + weight);
				length += weight;
			}
		}

		ids.push(document.id);
		lengths.push(length);
		for (const [token, count] of counts) {
			const list = postings.get(token);
			if (list) list.push({doc, count});
			else postings.set(token, [{doc, count}]);
		}
	}

	return {ids, lengths, postings, averageLength: average(lengths)};
}

/**
 * The best `limit` documents for `query`, highest score first. Documents
 * sharing none of its terms are left out, and a tie keeps document order.
 */
export function queryIndex(
	index: Bm25Index,
	query: string,
	limit: number,
): Array<{id: string; score: number}> {
	if (!(limit > 0)) return [];
	const total = index.ids.length;
	const scores = new Map<number, number>();
	for (const term of new Set(tokenize(query))) {
		const list = index.postings.get(term);
		if (!list) continue;
		const idf = Math.log(1 + (total - list.length + 0.5) / (list.length + 0.5));
		for (const {doc, count} of list) {
			const length = index.lengths[doc]!;
			const norm =
				index.averageLength > 0
					? 1 - B + (B * length) / index.averageLength
					: 1;
			const score = (idf * count * (K1 + 1)) / (count + K1 * norm);
			scores.set(doc, (scores.get(doc) ?? 0) + score);
		}
	}

	return [...scores]
		.sort(([docA, a], [docB, b]) => b - a || docA - docB)
		.slice(0, Math.floor(limit))
		.map(([doc, score]) => ({id: index.ids[doc]!, score}));
}

/** The index as plain JSON data, for a file. */
export function indexToJson(index: Bm25Index): unknown {
	return {
		ids: index.ids,
		lengths: index.lengths,
		postings: [...index.postings].map(([term, list]) => [
			term,
			list.flatMap(({doc, count}) => [doc, count]),
		]),
	};
}

/**
 * An index from JSON that may be damaged, or undefined when it isn't one.
 * Every number is checked, because a bad one would turn into a wrong score
 * or a crash far from the file that held it.
 */
export function indexFromJson(raw: unknown): Bm25Index | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const {ids, lengths, postings} = raw as Record<string, unknown>;
	if (!isArrayOf(ids, isString) || !isArrayOf(lengths, isCount)) {
		return undefined;
	}

	if (lengths.length !== ids.length || !Array.isArray(postings)) {
		return undefined;
	}

	const parsed = new Map<string, Array<{doc: number; count: number}>>();
	for (const item of postings as unknown[]) {
		if (!Array.isArray(item) || item.length !== 2) return undefined;
		const [term, flat] = item as [unknown, unknown];
		if (typeof term !== 'string' || parsed.has(term)) return undefined;
		if (!isArrayOf(flat, isCount) || flat.length === 0 || flat.length % 2) {
			return undefined;
		}

		const list: Array<{doc: number; count: number}> = [];
		for (let i = 0; i < flat.length; i += 2) {
			const doc = flat[i]!;
			const previous = list.at(-1)?.doc ?? -1;
			if (!Number.isInteger(doc) || doc >= ids.length || doc <= previous) {
				return undefined;
			}

			list.push({doc, count: flat[i + 1]!});
		}

		parsed.set(term, list);
	}

	return {ids, lengths, postings: parsed, averageLength: average(lengths)};
}

function isArrayOf<T>(
	value: unknown,
	check: (item: unknown) => item is T,
): value is T[] {
	return Array.isArray(value) && value.every(item => check(item));
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function average(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}
