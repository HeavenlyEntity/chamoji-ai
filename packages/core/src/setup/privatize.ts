import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {assertNoSymlinks} from '../links.js';
import type {FileChange} from '../release.js';
import {isObject} from '../util/object.js';

const quoted = '"(?:[^"\\\\]|\\\\.)*"';

/**
 * `package.json` with `"private": true` after `"version"`, else after
 * `"name"`, keeping its indentation and line endings. A manifest that
 * already says `true` comes back as it is.
 */
export async function privatizeEdit(
	root: string,
	pkgPath: string,
): Promise<FileChange> {
	const file = [pkgPath, 'package.json'].filter(Boolean).join('/');
	await assertNoSymlinks(root, file);
	const original = await readFile(path.join(root, file), 'utf8');
	const manifest: unknown = JSON.parse(original);
	if (!isObject(manifest)) throw new Error(`${file} isn't a JSON object`);
	const how = 'marked private, so a publish never picks it up';
	if (manifest['private'] === true) return {file, text: original, how};

	const eol = original.includes('\r\n') ? '\r\n' : '\n';
	const indent = /^([ \t]+)"/m.exec(original)?.[1];
	// A top-level `"private": false` is flipped in place: only a key at the
	// top-level indent counts, never one nested deeper.
	const flipped = new RegExp(
		`^(${indent ?? ''}"private"[ \\t]*:[ \\t]*)false`,
		'm',
	);
	if (
		indent !== undefined &&
		manifest['private'] === false &&
		flipped.test(original)
	) {
		return {file, text: original.replace(flipped, '$1true'), how};
	}

	if (indent !== undefined && !('private' in manifest)) {
		for (const key of ['version', 'name']) {
			const line = new RegExp(
				`^${indent}"${key}"[ \\t]*:[ \\t]*${quoted}(,?)[ \\t]*(?=\\r?$)`,
				'm',
			);
			const found = line.exec(original);
			if (!found) continue;
			const [whole, comma] = found as unknown as [string, string];
			const insert = comma
				? `${whole}${eol}${indent}"private": true,`
				: `${whole},${eol}${indent}"private": true`;
			// The whole line, so the replacement can't read `$` in a value.
			const text =
				original.slice(0, found.index) +
				insert +
				original.slice(found.index + whole.length);
			return {file, text, how};
		}
	}

	// Minified, or neither key on a line of its own: write it out again.
	const keys = Object.keys(manifest);
	const after = keys.includes('version') ? 'version' : 'name';
	const next: Record<string, unknown> = {};
	if (!keys.includes(after)) next['private'] = true;
	for (const [key, value] of Object.entries(manifest)) {
		// An old `private` (false, or not a boolean) is replaced, not kept.
		if (key === 'private') continue;
		next[key] = value;
		if (key === after) next['private'] = true;
	}

	const tail = original.endsWith('\n') ? eol : '';
	const text = JSON.stringify(next, null, indent ?? '\t').replaceAll('\n', eol);
	return {file, text: `${text}${tail}`, how};
}
