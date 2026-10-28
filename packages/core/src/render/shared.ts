import {getGitmoji} from '../gitmojis.js';
import type {Changelog, ParsedCommit, Release} from '../types.js';

/** The repository URL if it is plain http(s), without a trailing slash. */
export function safeRepositoryUrl(changelog: Changelog): string | undefined {
	const url = changelog.repositoryUrl;
	return url && /^https?:\/\/[^\s"'<>]+$/.test(url)
		? url.replace(/\/+$/, '')
		: undefined;
}

/** Where a release heading links to: a compare view, when one exists. */
export function releaseLink(
	release: Release,
	url: string | undefined,
): string | undefined {
	if (!url || !release.previousTag) {
		return undefined;
	}

	return `${url}/compare/${release.previousTag}...${release.tag ?? 'HEAD'}`;
}

export function commitLink(commit: ParsedCommit, url: string): string {
	return `${url}/commit/${commit.hash}`;
}

export function issueLink(issue: string, url: string): string {
	return `${url}/issues/${issue}`;
}

/**
 * The commit's gitmoji as a character, `:code:` for retired ones, or ''.
 * Gitmojis that chamoji guessed (from wording or AI) are not shown, so plain
 * histories aren't decorated with emojis their authors never wrote.
 */
export function emojiFor(commit: ParsedCommit): string {
	if (
		!commit.gitmoji ||
		(commit.gitmojiSource !== 'gitmoji' && commit.gitmojiSource !== 'type')
	) {
		return '';
	}

	return getGitmoji(commit.gitmoji)?.emoji ?? `:${commit.gitmoji}:`;
}

const DEPENDENCY_NAME =
	/^(?:bump|update|upgrade|downgrade|pin)\s+(?:the\s+)?(?:dev-?)?(?:dependency\s+)?([@\w./-]+)/i;
const NOT_A_NAME = /^(?:dependencies|deps|dev|all|minor|patch|major)$/i;
const SHOWN_NAMES = 5;

/**
 * One-line summary of a collapsed group of dependency updates, e.g.
 * `9 dependency updates: jest, vite, … and 2 more`. Names come from
 * Dependabot/Renovate-style subjects.
 */
export function summarizeDependencies(commits: ParsedCommit[]): string {
	const names = new Set<string>();
	for (const commit of commits) {
		const name = DEPENDENCY_NAME.exec(commit.description)?.[1];
		if (name && !NOT_A_NAME.test(name)) {
			names.add(name);
		}
	}

	const count = `${commits.length} dependency update${commits.length === 1 ? '' : 's'}`;
	if (names.size === 0) {
		return count;
	}

	const shown = [...names].slice(0, SHOWN_NAMES);
	const more = names.size - shown.length;
	return `${count}: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

export const DEPENDENCY_EMOJI = getGitmoji('arrow_up')?.emoji ?? '⬆️';

/**
 * Splits text into plain parts and `#123` issue references, so renderers can
 * escape the plain parts and link the references.
 */
export function splitIssues(
	text: string,
): Array<{text: string; issue?: string}> {
	return text
		.split(/(#\d+)\b/)
		.filter(part => part.length > 0)
		.map(part =>
			/^#\d+$/.test(part) ? {text: part, issue: part.slice(1)} : {text: part},
		);
}
