import {lstat, readFile} from 'node:fs/promises';

/**
 * The text of a regular file of at most `maxBytes`, else null: a link, a
 * folder, a file that's too big, and one that can't be read all come back
 * null.
 */
export async function readBoundedText(
	file: string,
	maxBytes: number,
): Promise<string | null> {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.size > maxBytes) return null;
		return await readFile(file, 'utf8');
	} catch {
		return null;
	}
}
