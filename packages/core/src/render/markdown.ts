import type {Changelog, ParsedCommit} from '../types.js';
import {
	commitLink,
	emojiFor,
	issueLink,
	releaseLink,
	safeRepositoryUrl,
	splitIssues,
} from './shared.js';

const escapeMarkdown = (text: string) =>
	text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function renderMarkdown(changelog: Changelog): string {
	const url = safeRepositoryUrl(changelog);
	const lines = ['# Changelog', ''];

	for (const release of changelog.releases) {
		const link = releaseLink(release, url);
		const title = link ? `[${release.version}](${link})` : release.version;
		lines.push(`## ${title}${release.date ? ` - ${release.date}` : ''}`, '');

		for (const group of release.groups) {
			lines.push(`### ${group.label}`, '');
			for (const commit of group.commits) {
				lines.push(`- ${renderCommit(commit, url)}`);
			}

			lines.push('');
		}
	}

	return lines.join('\n').replace(/\n+$/, '\n');
}

function renderCommit(commit: ParsedCommit, url: string | undefined): string {
	const emoji = emojiFor(commit);
	const scope = commit.scope ? `**${escapeMarkdown(commit.scope)}:** ` : '';
	const description = splitIssues(commit.description)
		.map(part =>
			part.issue && url
				? `[${part.text}](${issueLink(part.issue, url)})`
				: escapeMarkdown(part.text),
		)
		.join('');
	const hash = url
		? `[${commit.shortHash}](${commitLink(commit, url)})`
		: commit.shortHash;
	return `${emoji ? `${emoji} ` : ''}${scope}${description} (${hash})`;
}
