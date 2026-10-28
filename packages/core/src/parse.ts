import {findGitmoji, normalizeEmoji} from './gitmojis.js';
import type {ParsedCommit, RawCommit, Trailer} from './types.js';

/** Conventional Commits types we recognize, and the gitmoji each implies. */
const TYPE_TO_GITMOJI: Record<string, string> = {
	feat: 'sparkles',
	fix: 'bug',
	docs: 'memo',
	style: 'art',
	refactor: 'recycle',
	perf: 'zap',
	test: 'white_check_mark',
	build: 'package',
	ci: 'construction_worker',
	chore: 'wrench',
	revert: 'rewind',
};

const CONVENTIONAL_PREFIX = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*/;
const GITMOJI_CLI_SCOPE = /^\(([^)]+)\):\s*/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

export function parseCommit(raw: RawCommit): ParsedCommit {
	let text = normalizeEmoji(raw.subject).trim();
	let type: string | null = null;
	let scope: string | null = null;
	let bang = false;

	const prefix = CONVENTIONAL_PREFIX.exec(text);
	if (prefix && prefix[1]!.toLowerCase() in TYPE_TO_GITMOJI) {
		type = prefix[1]!.toLowerCase();
		scope = prefix[2] ?? null;
		bang = Boolean(prefix[3]);
		text = text.slice(prefix[0].length);
	}

	let gitmoji: string | null = null;
	const found = findGitmoji(text);
	if (found) {
		gitmoji = found.code;
		text = (text.slice(0, found.index) + text.slice(found.index + found.length))
			.replaceAll(/\s{2,}/g, ' ')
			.trim();
	}

	const cliScope = scope ? null : GITMOJI_CLI_SCOPE.exec(text);
	if (cliScope) {
		scope = cliScope[1]!;
		text = text.slice(cliScope[0].length);
	}

	if (!gitmoji && type) {
		gitmoji = TYPE_TO_GITMOJI[type]!;
	}

	const {trailers: rawTrailers, ...rest} = raw;
	return {
		...rest,
		gitmoji,
		type,
		scope,
		description: text.trim(),
		breaking: gitmoji === 'boom' || bang || BREAKING_FOOTER.test(raw.body),
		trailers: parseTrailers(rawTrailers),
	};
}

function parseTrailers(text: string): Trailer[] {
	const trailers: Trailer[] = [];
	for (const line of text.split('\n')) {
		const match = /^([\w-]+):\s*(.*)$/.exec(line.trim());
		if (match) {
			trailers.push({key: match[1]!, value: match[2]!});
		}
	}

	return trailers;
}
