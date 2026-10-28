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

/** The commit's gitmoji as a character, `:code:` for retired ones, or ''. */
export function emojiFor(commit: ParsedCommit): string {
	if (!commit.gitmoji) {
		return '';
	}

	return getGitmoji(commit.gitmoji)?.emoji ?? `:${commit.gitmoji}:`;
}

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
