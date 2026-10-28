/**
 * Guesses a gitmoji for a plain commit subject ("Add x", "Fix y") so repos
 * that use neither gitmoji nor Conventional Commits still get sections.
 * Rules are checked in order; the first match wins.
 */
const RULES: Array<[RegExp, string]> = [
	// Version-only and release commits.
	[/^v?\d+\.\d+\.\d+\S*$/, 'bookmark'],
	[/^(?:release|releasing|prepare release|bump version)\b/i, 'bookmark'],
	[/^initial commit\b/i, 'tada'],

	// Dependency updates, including Dependabot and Renovate subjects.
	[
		/^(?:bump|update|upgrade)\s+(?:dev\s+)?(?:dependencies|deps)\b/i,
		'arrow_up',
	],
	[/^(?:bump|update|upgrade|pin)\s+\S+\s+from\s+\S+\s+to\s+\S+/i, 'arrow_up'],
	[/^(?:require|target|drop support for)\s+node(?:\.js)?\s*\d+/i, 'boom'],

	// Topics that outrank the leading verb.
	[/\bsecurity\b|\bvulnerab|\bcve-\d+/i, 'lock'],
	[/\b(?:readme|docs?|documentation)\b/i, 'memo'],
	[/\btypos?\b/i, 'pencil2'],
	[/^fix(?:es|ed)?\s+(?:the\s+)?ci\b/i, 'green_heart'],
	[
		/^(?:add|adds|added|improve|update|fix)\s+(?:more\s+)?tests?\b|^tests?\b/i,
		'white_check_mark',
	],
	[/\b(?:performance|perf|faster|speed up|optimi[sz]e\w*)\b/i, 'zap'],

	// The leading verb.
	[
		/^(?:adds?|added|adding|implement\w*|introduc\w*|creat\w*|support\w*|export\w*|allow\w*|enabl\w*|new)\b/i,
		'sparkles',
	],
	[/^(?:fix\w*|resolv\w*|correct\w*|repair\w*|hotfix\w*|handl\w*)\b/i, 'bug'],
	[/^(?:remov\w*|delet\w*|drop\w*)\b/i, 'fire'],
	[/^deprecat\w*\b/i, 'wastebasket'],
	[/^(?:renam\w*|mov\w*)\b/i, 'truck'],
	[
		/^(?:refactor\w*|clean\w*|simplif\w*|restructur\w*|reorganiz\w*)\b/i,
		'recycle',
	],
	[/^(?:upgrad\w*)\b/i, 'arrow_up'],
	[/^(?:downgrad\w*)\b/i, 'arrow_down'],
	[
		/^(?:updat\w*|improv\w*|chang\w*|tweak\w*|meta|use|replac\w*|rewrit\w*|migrat\w*|make|ensure)\b/i,
		'wrench',
	],
];

export function inferGitmoji(subject: string): string | null {
	const text = subject.trim();
	for (const [pattern, code] of RULES) {
		if (pattern.test(text)) {
			return code;
		}
	}

	return null;
}
