import type {Changelog, ParsedCommit} from '../types.js';
import {
	commitLink,
	emojiFor,
	issueLink,
	releaseLink,
	safeRepositoryUrl,
	splitIssues,
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

		for (const group of release.groups) {
			out.push(`<h3>${escapeHtml(group.label)}</h3>`, '<ul>');
			for (const commit of group.commits) {
				out.push(`<li>${renderCommit(commit, url)}</li>`);
			}

			out.push('</ul>');
		}

		out.push('</section>');
	}

	out.push('</body>', '</html>', '');
	return out.join('\n');
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
	const hash = `<code>${escapeHtml(commit.shortHash)}</code>`;
	return `${emoji ? `${escapeHtml(emoji)} ` : ''}${scope}${description} (${
		url ? anchor(commitLink(commit, url), hash) : hash
	})`;
}
