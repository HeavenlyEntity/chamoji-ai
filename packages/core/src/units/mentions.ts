import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import {runGit} from '../git.js';
import {ReleaseError, type FileChange} from '../release.js';
import type {Mention} from './settings.js';

const VERSION = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)`;

/** The pattern as a regex: its text literal, `{version}` a semver. */
function mentionRegex(pattern: string): RegExp {
	const [before = '', after = ''] = pattern.split('{version}');
	const literal = (text: string) =>
		text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
	return new RegExp(`${literal(before)}${VERSION}${literal(after)}`, 'g');
}

/** The tracked files a glob matches, '/'-separated; git does the matching. */
async function trackedFiles(root: string, glob: string): Promise<string[]> {
	const out = await runGit(['ls-files', '-z', '--', `:(glob)${glob}`], root);
	return out.split('\0').filter(Boolean);
}

/** Whether the file or a folder above it is a symlink; a write would leave the repo's files. */
async function viaLink(root: string, file: string): Promise<boolean> {
	let at = root;
	for (const part of file.split('/')) {
		at = path.join(at, part);
		try {
			if ((await lstat(at)).isSymbolicLink()) return true;
		} catch {
			return false;
		}
	}

	return false;
}

/**
 * Moves every older version the mentions name to `to`. `pending` holds the
 * release's changes so far; a mentioned file already in it is edited on top of
 * its pending text, and any other is appended. Only tracked files match. With
 * `unit` null a mention without a unit applies; otherwise one for that unit.
 */
export async function editMentions(
	root: string,
	mentions: Mention[],
	unit: string | null,
	to: string,
	pending: FileChange[],
): Promise<FileChange[]> {
	const changes = [...pending];
	const mine = mentions.filter(mention => (mention.unit ?? null) === unit);
	for (const mention of mine) {
		const regex = mentionRegex(mention.pattern);
		const files = new Set<string>();
		for (const glob of mention.files) {
			const found: string[] = [];
			for (const file of await trackedFiles(root, glob)) {
				if (!(await viaLink(root, file))) found.push(file);
			}

			if (found.length === 0) {
				throw new ReleaseError(
					'invalid-mention',
					`release.mentions: "${glob}" matches no tracked file`,
				);
			}

			for (const file of found) files.add(file);
		}

		for (const file of files) {
			const index = changes.findIndex(change => change.file === file);
			const existing = changes[index];
			let text: string;
			if (existing) {
				text = existing.text;
			} else {
				try {
					text = await readFile(path.join(root, file), 'utf8');
				} catch {
					continue;
				}
			}

			const edited = text.replace(regex, (match, found: string) =>
				semver.valid(found) && semver.valid(to) && semver.lt(found, to)
					? match.replace(found, to)
					: match,
			);
			if (edited === text) continue;
			if (existing) {
				changes[index] = {...existing, text: edited};
			} else {
				changes.push({
					file,
					text: edited,
					how: `version mentions set to ${to}`,
				});
			}
		}
	}

	return changes;
}
