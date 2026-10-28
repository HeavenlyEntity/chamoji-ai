import {parseCommit} from '../../src/parse.js';
import type {ParsedCommit, RawCommit} from '../../src/types.js';

let counter = 0;

/** Builds a ParsedCommit from a subject line, for unit tests. */
export function commit(subject: string, extra: Partial<RawCommit> = {}): ParsedCommit {
	counter++;
	const hash = counter.toString(16).padStart(40, '0');
	return parseCommit({
		hash,
		shortHash: hash.slice(0, 7),
		authorName: 'Dev',
		authorEmail: 'dev@example.com',
		date: '2026-01-01T00:00:00Z',
		subject,
		body: '',
		trailers: '',
		...extra,
	});
}
