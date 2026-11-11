import path from 'node:path';
import {readBoundedText} from '../fs-read.js';
import {runGit} from '../git.js';
import {mentionRegex} from '../units/mentions.js';
import type {Mention} from '../units/settings.js';
import {unitNameOf, type WorkspacePackage} from '../units/workspace.js';
import {MAX_FILE_BYTES, MAX_LISTED_FILES} from './limits.js';

/** A glob that matches `file` and nothing else. */
const literalGlob = (file: string): string =>
	file.replaceAll(/[*?[\]\\]/g, String.raw`\$&`);

/** Tracked Markdown files, '/'-separated, less changelogs (they name every version). */
async function markdownFiles(root: string): Promise<string[]> {
	const out = await runGit(
		['ls-files', '-z', '--', ':(glob)**/*.md', ':(glob)**/*.mdx'],
		root,
	);
	return out
		.split('\0')
		.filter(Boolean)
		.filter(file => file.split('/').pop()?.toLowerCase() !== 'changelog.md')
		.slice(0, MAX_LISTED_FILES);
}

/** Whether the pattern has a match in `text` that doesn't continue a longer name. */
function mentions(text: string, pattern: string): boolean {
	const regex = mentionRegex(pattern);
	for (const match of text.matchAll(regex)) {
		const before = match.index > 0 ? text[match.index - 1]! : '';
		if (!/[\w@/.-]/.test(before)) return true;
	}

	return false;
}

/**
 * The version pins tracked Markdown carries: `owner/repo@v<version>` for the
 * repo, and `<name>@<version>` for each public package. Each comes with the
 * files that hold it; a package's pin also names the folder as `unit`, which
 * setup keeps only when that folder is a unit.
 */
export async function detectMentions(
	root: string,
	repo: string | null,
	packages: WorkspacePackage[],
): Promise<Mention[]> {
	const wanted: Array<{pattern: string; unit?: string}> = [
		...(repo ? [{pattern: `${repo}@v{version}`}] : []),
		...packages
			.filter(pkg => !pkg.private)
			.map(pkg => ({
				pattern: `${pkg.name}@{version}`,
				...(pkg.path === '' ? {} : {unit: unitNameOf(pkg.path)}),
			})),
	];
	if (wanted.length === 0) return [];
	const found = new Map<string, string[]>(
		wanted.map(item => [item.pattern, []]),
	);
	for (const file of await markdownFiles(root)) {
		// eslint-disable-next-line no-await-in-loop
		const text = await readBoundedText(
			path.join(root, ...file.split('/')),
			MAX_FILE_BYTES,
		);
		if (text === null) continue;
		for (const item of wanted) {
			if (mentions(text, item.pattern)) found.get(item.pattern)!.push(file);
		}
	}

	return wanted.flatMap(item => {
		const files = found.get(item.pattern)!;
		return files.length > 0
			? [
					{
						pattern: item.pattern,
						files: files.map(file => literalGlob(file)),
						...(item.unit ? {unit: item.unit} : {}),
					},
				]
			: [];
	});
}
