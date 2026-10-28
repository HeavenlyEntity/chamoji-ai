/**
 * Guesses a gitmoji for a plain commit subject ("Add x", "Fix y") so repos
 * that use neither gitmoji nor Conventional Commits still get sections.
 * Rules are checked in order; the first match wins. Verbs are matched as
 * whole word forms ("fix", "fixes", "fixed", "fixing"), so "Fixture" or
 * "Dropdown" don't count, and topic words only count near the start.
 */

/** A version-like token: `1.2.3`, `v4`, `^7.0`. */
const VERSION = String.raw`[~^]?v?\d[\w.-]*`;

const RULES: Array<[RegExp, string]> = [
	// Version-only and release commits (hidden by default).
	[/^v?\d+\.\d+\.\d+\S*$/, 'bookmark'],
	[
		/^(?:release|releasing|prepare release(?: for)?|bump version(?: to)?)\s+v?\d|^(?:release|bump version)$/i,
		'bookmark',
	],
	[/^(?:initial commit|init)\b/i, 'tada'],
	[/^\[breaking\]/i, 'boom'],
	[/^(?:require|drop support for)\s+node(?:\.js)?\s*\d+/i, 'boom'],

	// Dependency updates: Dependabot, Renovate and hand-written ones.
	[/^pin\s+(?:dev-?)?dependenc(?:y|ies)\b/i, 'pushpin'],
	[
		/^(?:bump|update|upgrade)\s+(?:all\s+)?(?:non-major\s+|minor\s+|patch\s+)?(?:dev[- ]?)?(?:dependencies|dependency|deps)\b/i,
		'arrow_up',
	],
	[/^lock\s?file maintenance\b/i, 'arrow_up'],
	[/^bump\s+the\s+\S+\s+group\b/i, 'arrow_up'],
	[/^update\s+\S+\s+(?:action|monorepo|docker tag|digest)\b/i, 'arrow_up'],
	[
		new RegExp(
			String.raw`^(?:bump|update|upgrade|pin)\s+\S+\s+from\s+${VERSION}\s+to\s+${VERSION}`,
			'i',
		),
		'arrow_up',
	],
	[/^bump\s+`?[@\w./-]+`?\s*$/i, 'arrow_up'],
	[
		new RegExp(String.raw`^upgrad(?:e|es|ed|ing)\b.*\s${VERSION}`, 'i'),
		'arrow_up',
	],

	// Topics, only when they are what the subject is about.
	[/^(?:\w+\s+){0,2}(?:the\s+)?(?:readme|docs?|documentation)\b/i, 'memo'],
	[/^document(?:s|ed|ing)?\b/i, 'memo'],
	[/^(?:fix(?:es|ed)?\s+(?:an?\s+|the\s+)?typos?|typos?)\b/i, 'pencil2'],
	[/^fix(?:es|ed|ing)?\s+(?:the\s+)?ci\b/i, 'green_heart'],
	[
		/^(?:add|adds|added|improve|update|fix)\s+(?:more\s+)?tests?\b|^tests?\b/i,
		'white_check_mark',
	],
	[
		/^fix(?:es|ed|ing)?\b.*\b(?:security|vulnerabilit(?:y|ies)|cve-\d+)/i,
		'lock',
	],
	[/^(?:security|cve-\d+)\b/i, 'lock'],
	[
		/^(?:improve|boost|increase)\s+(?:\w+\s+)?(?:performance|perf|speed)\b|^(?:optimi[sz]e[sd]?|speed\s+up)\b|^make\b.*\bfaster\b/i,
		'zap',
	],
	[/^(?:minor\s+)?(?:code\s+style|minor\s+code|style)\s+tweaks?\b/i, 'art'],
	[/^add(?:s|ed)?\s+missing\b/i, 'bug'],

	// The leading verb.
	[
		/^(?:add(?:s|ed|ing)?|implement(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|support(?:s|ed|ing)?|export(?:s|ed|ing)?|allow(?:s|ed|ing)?|enabl(?:e|es|ed|ing))\b/i,
		'sparkles',
	],
	[
		/^(?:fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing)|correct(?:s|ed|ing)?|repair(?:s|ed|ing)?|hotfix(?:es|ed)?)\b/i,
		'bug',
	],
	[
		/^(?:remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|drop(?:s|ped|ping)?)\b/i,
		'fire',
	],
	[/^deprecat(?:e|es|ed|ing)\b/i, 'wastebasket'],
	[/^(?:renam(?:e|es|ed|ing)|mov(?:e|es|ed|ing))\b/i, 'truck'],
	[
		/^(?:refactor(?:s|ed|ing)?|clean(?:s|ed|ing)?|cleanup|simplif(?:y|ies|ied|ying)|restructur(?:e|es|ed|ing)|reorganiz(?:e|es|ed|ing))\b/i,
		'recycle',
	],
	[/^downgrad(?:e|es|ed|ing)\b/i, 'arrow_down'],
	[
		/^(?:updat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing)|improv(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|tweak(?:s|ed|ing)?|meta|use|replac(?:e|es|ed|ing)|rewrit(?:e|es|ing|ten)|migrat(?:e|es|ed|ing)|make|ensure|switch(?:es|ed|ing)?)\b/i,
		'wrench',
	],
];

/** Prefixes that say nothing about the change, like "Close #14 PR: ". */
const NOISE_PREFIX = /^(?:close[sd]?\s+#\d+\s+pr:\s*)/i;

export function inferGitmoji(subject: string): string | null {
	const text = subject.trim().replace(NOISE_PREFIX, '');
	for (const [pattern, code] of RULES) {
		if (pattern.test(text)) {
			return code;
		}
	}

	return null;
}
