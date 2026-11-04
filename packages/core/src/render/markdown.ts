import type {Changelog, Group, ParsedCommit} from '../types.js';
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

		if (release.highlights?.length) {
			lines.push('### Highlights', '');
			for (const highlight of release.highlights) {
				const emoji = oneLine(highlight.emoji ?? '');
				const description = oneLine(highlight.description ?? '');
				const title = escapeMarkdown(oneLine(highlight.title));
				const lead = `${emoji ? `${escapeMarkdown(emoji)} ` : ''}**${title}${description ? ':' : ''}**`;
				lines.push(
					`- ${description ? `${lead} ${escapeMarkdown(description)}` : lead}`,
				);
				for (const group of highlight.groups) {
					for (const item of groupItems(group, url)) {
						lines.push(`  - ${item}`);
					}
				}
			}

			lines.push('');
		}

		for (const group of release.groups) {
			lines.push(`### ${group.label}`, '');
			for (const item of groupItems(group, url)) {
				lines.push(`- ${item}`);
			}

			lines.push('');
		}
	}

	return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Workstream text comes from a file anyone can edit and may span lines. On
 * one line it cannot open a heading or list of its own, which would also
 * confuse `insertSection`.
 */
const oneLine = (text: string) => text.replaceAll(/\s+/g, ' ').trim();

/** A group as list items: one summary line when collapsed, else a line per commit. */
function groupItems(group: Group, url: string | undefined): string[] {
	return group.collapse
		? [
				`${DEPENDENCY_EMOJI} ${escapeMarkdown(summarizeDependencies(group.commits))}`,
			]
		: group.commits.map(commit => renderCommit(commit, url));
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
	const link = url
		? `[${commit.shortHash}](${commitLink(commit, url)})`
		: commit.shortHash;
	// A line chamoji writes itself, such as a Dependencies line, has no commit.
	const hash = commit.shortHash ? ` (${link})` : '';
	// A package path, as a code span: it can't hold a backtick or a line break.
	const via = commit.via
		? ` (via \`${commit.via.replaceAll(/[`\r\n]/g, '')}\`)`
		: '';
	return `${emoji ? `${emoji} ` : ''}${scope}${description}${hash}${via}`;
}
