import {lstat} from 'node:fs/promises';
import path from 'node:path';

/**
 * The first part of `rel`, under `root`, that is a symlink, as a
 * '/'-separated path relative to `root`; null when none is. A part that
 * doesn't exist yet ends the walk. Any other `lstat` error is thrown with
 * `onError: 'throw'`, and ends the walk with `'stop'`.
 */
export async function firstLinkOnPath(
	root: string,
	rel: string,
	options: {onError: 'throw' | 'stop'},
): Promise<string | null> {
	let current = root;
	for (const part of rel.split('/').filter(Boolean)) {
		current = path.join(current, part);
		let found;
		try {
			// eslint-disable-next-line no-await-in-loop -- each part sits under the last
			found = await lstat(current);
		} catch (error) {
			const {code} = error as NodeJS.ErrnoException;
			if (
				options.onError === 'stop' ||
				code === 'ENOENT' ||
				code === 'ENOTDIR'
			) {
				return null;
			}

			throw error;
		}

		if (found.isSymbolicLink()) {
			return path.relative(root, current).split(path.sep).join('/');
		}
	}

	return null;
}

/** Whether `file` itself, under `root`, is a symlink; a missing or unreadable file isn't. */
export async function isLinkAt(root: string, file: string): Promise<boolean> {
	try {
		return (await lstat(path.join(root, file))).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Refuses when `rel` or a folder above it, under `root`, is a symlink: git
 * commits the link, so writing through it would change a file the repo
 * doesn't hold. A part that doesn't exist yet ends the check.
 */
export async function assertNoSymlinks(
	root: string,
	rel: string,
): Promise<void> {
	const link = await firstLinkOnPath(root, rel, {onError: 'throw'});
	if (link !== null) {
		throw new Error(`${link} is a symlink; chamoji won't write through links`);
	}
}
