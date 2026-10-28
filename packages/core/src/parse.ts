import {findGitmoji, normalizeEmoji} from './gitmojis.js';
import {inferGitmoji} from './infer.js';
import type {GitmojiSource, ParsedCommit, RawCommit, Trailer} from './types.js';

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
	release: 'bookmark',
	wip: 'construction',
	deps: 'arrow_up',
	security: 'lock',
};

/** Conventional scopes that mean "dependency update" under any type. */
const DEPENDENCY_SCOPES = new Set(['deps', 'deps-dev', 'dependencies']);

const CONVENTIONAL_PREFIX = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*/;
const GITMOJI_CLI_SCOPE = /^\(([^)]+)\):\s*/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
const GIT_REVERT = /^Revert "(.+)"$/;

export function parseCommit(raw: RawCommit): ParsedCommit {
	const revert = GIT_REVERT.exec(raw.subject.trim());
	if (revert) {
		// `git revert` quotes the original subject; classify by the revert, not
		// by the reverted commit's gitmoji.
		const original = parseCommit({...raw, subject: revert[1]!, body: ''});
		return {
			...original,
			body: raw.body,
			gitmoji: 'rewind',
			gitmojiSource: 'rule',
			type: null,
			description: `Revert "${original.description}"`,
			breaking: BREAKING_FOOTER.test(raw.body),
		};
	}

	let text = normalizeEmoji(raw.subject).trim();
	let type: string | null = null;
	let scope: string | null = null;
	let bang = false;

	const prefix = CONVENTIONAL_PREFIX.exec(text);
	// Known types always count; any other word counts only with a `!`, so
	// prose like "Note: …" is left alone.
	if (prefix && (prefix[1]!.toLowerCase() in TYPE_TO_GITMOJI || prefix[3])) {
		type = prefix[1]!.toLowerCase();
		scope = prefix[2] ?? null;
		bang = Boolean(prefix[3]);
		text = text.slice(prefix[0].length);
	}

	let gitmoji: string | null = null;
	let gitmojiSource: GitmojiSource = null;
	const found = findGitmoji(text);
	if (found) {
		gitmoji = found.code;
		gitmojiSource = 'gitmoji';
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
		gitmoji =
			scope && DEPENDENCY_SCOPES.has(scope.toLowerCase())
				? 'arrow_up'
				: (TYPE_TO_GITMOJI[type] ?? null);
		gitmojiSource = gitmoji ? 'type' : null;
	}

	if (!gitmoji) {
		gitmoji = inferGitmoji(text);
		gitmojiSource = gitmoji ? 'rule' : null;
	}

	const {trailers: rawTrailers, ...rest} = raw;
	return {
		...rest,
		gitmoji,
		gitmojiSource,
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
