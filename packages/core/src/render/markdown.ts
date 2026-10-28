import type {Changelog, ParsedCommit} from '../types.js';
import {
	commitLink,
	DEPENDENCY_EMOJI,
	emojiFor,
	issueLink,
	releaseLink,
	safeRepositoryUrl,
	splitIssues,
	summarizeDependencies,
} from './shared.js';

/**
 * Makes commit text inert outside code spans: no raw HTML, and no links or
 * images, since squash-merged PR titles can come from anyone. Backticks are
 * escaped too: any left here are unpaired, and an unpaired run could open a
 * code span a Markdown parser sees differently from `splitCodeSpans`.
 */
const escapeMarkdown = (text: string) =>
	text
		.replaceAll(/[\\[\]`]/g, char => `\\${char}`)
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');

/**
 * Splits text into single-backtick `code spans` and the parts between. A span
 * holds no backticks, so emitting it as-is is safe once the surrounding text
 * has its stray backticks escaped.
 */
const splitCodeSpans = (text: string) =>
	text
		.split(/(`[^`\n]+`)/)
		.filter(part => part.length > 0)
		.map(part => ({text: part, code: /^`[^`\n]+`$/.test(part)}));

export function renderMarkdown(changelog: Changelog): string {
	const url = safeRepositoryUrl(changelog);
	const lines = ['# Changelog', ''];

	for (const release of changelog.releases) {
		const link = releaseLink(release, url);
		const title = link ? `[${release.version}](${link})` : release.version;
		lines.push(`## ${title}${release.date ? ` - ${release.date}` : ''}`, '');

		for (const group of release.groups) {
			lines.push(`### ${group.label}`, '');
			if (group.collapse) {
				lines.push(
					`- ${DEPENDENCY_EMOJI} ${escapeMarkdown(summarizeDependencies(group.commits))}`,
				);
			} else {
				for (const commit of group.commits) {
					lines.push(`- ${renderCommit(commit, url)}`);
				}
			}

			lines.push('');
		}
	}

	return lines.join('\n').replace(/\n+$/, '\n');
}

function renderCommit(commit: ParsedCommit, url: string | undefined): string {
	const emoji = emojiFor(commit);
	const scope = commit.scope ? `**${escapeMarkdown(commit.scope)}:** ` : '';
	const description = splitCodeSpans(commit.description)
		.map(span =>
			span.code
				? span.text
				: splitIssues(span.text)
						.map(part =>
							part.issue && url
								? `[${part.text}](${issueLink(part.issue, url)})`
								: escapeMarkdown(part.text),
						)
						.join(''),
		)
		.join('');
	const hash = url
		? `[${commit.shortHash}](${commitLink(commit, url)})`
		: commit.shortHash;
	return `${emoji ? `${emoji} ` : ''}${scope}${description} (${hash})`;
}
