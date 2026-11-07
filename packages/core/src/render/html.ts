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

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#x27;',
};

export const escapeHtml = (text: string) =>
	text.replaceAll(/[&<>"']/g, char => ESCAPES[char]!);

const anchor = (href: string, content: string) =>
	`<a href="${escapeHtml(href)}">${content}</a>`;

const STYLE = `body{font-family:system-ui,sans-serif;line-height:1.6;max-width:48rem;margin:2rem auto;padding:0 1rem}
h2{margin-top:2rem;border-bottom:1px solid #ddd}time{color:#666;font-size:.9em;font-weight:normal}
code{font-size:.85em}`;

export function renderHtml(changelog: Changelog): string {
	const url = safeRepositoryUrl(changelog);
	const out = [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<title>Changelog</title>',
		`<style>${STYLE}</style>`,
		'</head>',
		'<body>',
		'<h1>Changelog</h1>',
	];

	for (const release of changelog.releases) {
		const link = releaseLink(release, url);
		const version = escapeHtml(release.version);
		const date = release.date
			? ` <time datetime="${escapeHtml(release.date)}">${escapeHtml(release.date)}</time>`
			: '';
		out.push(
			`<section id="${version}">`,
			`<h2>${link ? anchor(link, version) : version}${date}</h2>`,
		);

		if (release.highlights?.length) {
			out.push('<h3>Highlights</h3>');
			for (const highlight of release.highlights) {
				out.push(
					'<details>',
					`<summary>${highlight.emoji ? `${escapeHtml(highlight.emoji)} ` : ''}<strong>${escapeHtml(highlight.title)}</strong></summary>`,
				);
				if (highlight.description) {
					out.push(`<p>${escapeHtml(highlight.description)}</p>`);
				}

				out.push('<ul>');
				for (const group of highlight.groups) {
					out.push(...groupItems(group, url));
				}

				out.push('</ul>', '</details>');
			}
		}

		for (const group of release.groups) {
			out.push(`<h3>${escapeHtml(group.label)}</h3>`, '<ul>');
			out.push(...groupItems(group, url));
			out.push('</ul>');
		}

		out.push('</section>');
	}

	out.push('</body>', '</html>', '');
	return out.join('\n');
}

/** A group as `<li>` lines: one summary when collapsed, else a line per commit. */
function groupItems(group: Group, url: string | undefined): string[] {
	return group.collapse
		? [
				`<li>${DEPENDENCY_EMOJI} ${escapeHtml(summarizeDependencies(group.commits))}</li>`,
			]
		: group.commits.map(commit => `<li>${renderCommit(commit, url)}</li>`);
}

function renderCommit(commit: ParsedCommit, url: string | undefined): string {
	const emoji = emojiFor(commit);
	const scope = commit.scope
		? `<strong>${escapeHtml(commit.scope)}:</strong> `
		: '';
	const description = splitIssues(commit.description)
		.map(part =>
			part.issue && url
				? anchor(issueLink(part.issue, url), escapeHtml(part.text))
				: escapeHtml(part.text),
		)
		.join('');
	const code = `<code>${escapeHtml(commit.shortHash)}</code>`;
	// A line chamoji writes itself, such as a Dependencies line, has no commit.
	const hash = commit.shortHash
		? ` (${url ? anchor(commitLink(commit, url), code) : code})`
		: '';
	return `${emoji ? `${escapeHtml(emoji)} ` : ''}${scope}${description}${hash}${
		commit.via ? ` (via <code>${escapeHtml(commit.via)}</code>)` : ''
	}`;
}
