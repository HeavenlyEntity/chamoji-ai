/**
 * Puts `section` above the first release heading, below the title and any
 * Unreleased section. Everything after it is kept byte for byte.
 */
export function insertSection(changelog: string, section: string): string {
	const lines = changelog.split('\n');
	const index = lines.findIndex(
		line => line.startsWith('## ') && !/^## \[?unreleased\]?/i.test(line),
	);
	if (index === -1) {
		return `${changelog.trimEnd()}\n\n${section}\n`;
	}

	return [
		...lines.slice(0, index),
		...section.split('\n'),
		'',
		...lines.slice(index),
	].join('\n');
}

const JSON_VERSION = /("version"\s*:\s*")([^"]+)(")/;
const TOML_VERSION = /^(version\s*=\s*")([^"]+)(")/m;
// The lockfile repeats the root version under packages[""].
const LOCK_ROOT_VERSION =
	/("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]+)(")/;

/**
 * `text` with the manifest's own version set to `to`, or null when the file
 * doesn't carry `from` (or, for a first release with no `from`, already says
 * `to`). Works on the text, so formatting survives; only the first version
 * field (and the lockfile's root entry) changes, never a dependency's.
 */
export function bumpManifest(
	file: string,
	text: string,
	from: string | null,
	to: string,
): string | null {
	const pattern = file.endsWith('.json') ? JSON_VERSION : TOML_VERSION;
	const current = pattern.exec(text)?.[2];
	if (current === undefined || (from ? current !== from : current === to)) {
		return null;
	}

	let next = text.replace(pattern, `$1${to}$3`);
	if (file.endsWith('package-lock.json')) {
		next = next.replace(LOCK_ROOT_VERSION, `$1${to}$3`);
	}

	return next;
}

/**
 * The release commit's subject in the style of `recentSubjects`, worded so
 * chamoji leaves it out of later changelogs.
 */
export function releaseSubject(recentSubjects: string[], tag: string): string {
	const share = (pattern: RegExp) =>
		recentSubjects.filter(subject => pattern.test(subject)).length /
		Math.max(1, recentSubjects.length);
	const gitmoji = share(/^(?:\p{Extended_Pictographic}|:[a-z\d_+-]+:)/u);
	const conventional = share(/^[a-z]+(?:\([^)]*\))?!?: /);
	if (conventional > gitmoji && conventional >= 1 / 3) {
		return `chore(release): 🔖 ${tag}`;
	}

	return gitmoji >= 1 / 3 ? `🔖 Release ${tag}` : `Release ${tag}`;
}

/** The newest tag's prefix, so new tags match: `v`, or none. `v` with no tags. */
export function tagPrefix(newestFirst: string[]): 'v' | '' {
	const newest = newestFirst[0];
	return newest === undefined || newest.startsWith('v') ? 'v' : '';
}
