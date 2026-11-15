import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from './git.js';

export type Survival = {
	/** Undefined when the commit added no lines. */
	survives: boolean | undefined;
	/** Paths the commit added lines to. */
	files: string[];
};

/** Bump it when the file's layout or what goes into it changes. */
const CACHE_VERSION = 1;

/** The commits that own a line of a blob, by blob id. */
type Cache = Record<string, string[]>;

/**
 * Whether each commit in `hashes` still owns a line at HEAD. A commit that
 * added no lines has nothing to own, so its answer is undefined. Blame can
 * only say a commit's lines are gone; a file it can't blame counts as owned
 * by nobody, and the caller treats that as doubt, never as a resolution.
 * Results are kept per blob in the git directory, so a file that has not
 * changed since the last call is not blamed again. `onBlame` hears of each
 * file actually blamed.
 */
export async function readSurvival(
	cwd: string,
	hashes: string[],
	options: {onBlame?: (file: string) => void} = {},
): Promise<Map<string, Survival>> {
	const result = new Map<string, Survival>();
	if (hashes.length === 0) return result;

	const files = new Map<string, string[]>();
	for (const hash of new Set(hashes)) {
		files.set(hash, await addedFiles(cwd, hash));
	}

	const blobs = await headBlobs(cwd);
	const cached = await readCache(cwd);
	const cache: Cache = {};
	let changed = false;
	// Only blobs at HEAD are kept, so the file does not grow with every edit.
	for (const blob of blobs.values()) {
		const owners = cached[blob];
		if (owners !== undefined) cache[blob] = owners;
	}

	if (Object.keys(cache).length !== Object.keys(cached).length) changed = true;

	const owned = new Map<string, Set<string>>();
	const ownersOf = async (file: string): Promise<Set<string>> => {
		const blob = blobs.get(file);
		if (blob === undefined) return new Set();
		const known = cache[blob];
		if (known !== undefined) return new Set(known);
		const blamed = owned.get(blob);
		if (blamed) return blamed;
		options.onBlame?.(file);
		const found = await blameOwners(cwd, file);
		owned.set(blob, found);
		// A failed blame is not kept: it may work next time.
		if (found.size > 0) {
			cache[blob] = [...found];
			changed = true;
		}

		return found;
	};

	for (const [hash, added] of files) {
		let survives: boolean | undefined = added.length > 0 ? false : undefined;
		for (const file of added) {
			if ((await ownersOf(file)).has(hash)) {
				survives = true;
				break;
			}
		}

		result.set(hash, {survives, files: added});
	}

	if (changed) await writeCache(cwd, cache).catch(() => undefined);
	return result;
}

/** The paths a commit added lines to; a binary file or a failed `git show` gives none. */
async function addedFiles(cwd: string, hash: string): Promise<string[]> {
	let stdout: string;
	try {
		stdout = await runGit(
			[
				'show',
				'--numstat',
				'-z',
				'--no-renames',
				'--no-show-signature',
				'--format=',
				'--end-of-options',
				hash,
			],
			cwd,
		);
	} catch {
		return [];
	}

	// Each record is `added TAB deleted TAB path NUL`; a path can't hold a NUL.
	const paths: string[] = [];
	for (const record of stdout.split('\0')) {
		// A format of nothing can leave a newline in front of the first record.
		const match = /^\n?(\d+|-)\t(\d+|-)\t([^]*)$/.exec(record);
		if (match && match[1] !== '-' && Number(match[1]) > 0) {
			paths.push(match[3]!);
		}
	}

	return paths;
}

/** Path to blob id for every regular file at HEAD. */
async function headBlobs(cwd: string): Promise<Map<string, string>> {
	const blobs = new Map<string, string>();
	let stdout: string;
	try {
		stdout = await runGit(['ls-tree', '-r', '-z', 'HEAD'], cwd);
	} catch {
		return blobs;
	}

	// Each record is `mode SP type SP id TAB path NUL`.
	for (const record of stdout.split('\0')) {
		const tab = record.indexOf('\t');
		if (tab < 0) continue;
		const [, type, id] = record.slice(0, tab).split(' ');
		if (type === 'blob' && id) blobs.set(record.slice(tab + 1), id);
	}

	return blobs;
}

/** The commits that own a line of `file` at HEAD; nobody when blame fails. */
async function blameOwners(cwd: string, file: string): Promise<Set<string>> {
	let stdout: string;
	try {
		// The same flags as `blameLine`; HEAD, not the working copy, is blamed.
		stdout = await runGit(
			['blame', '--porcelain', '-w', '-M', 'HEAD', '--', file],
			cwd,
		);
	} catch {
		return new Set();
	}

	// A line's group starts with `<hash> <source line> <result line>`; the
	// lines of the file itself start with a tab, so they can't pass for one.
	const owners = new Set<string>();
	for (const line of stdout.split('\n')) {
		const hash = /^([0-9a-f]{40,64}) \d+ \d+/.exec(line)?.[1];
		if (hash) owners.add(hash);
	}

	return owners;
}

/** Where this worktree keeps blame results; the git directory is per worktree. */
async function cachePath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return path.join(gitDir, 'chamoji', 'blame-cache.json');
}

/**
 * The stored results. The file is local but can be cut short or edited, so
 * anything that does not check out is treated as absent.
 */
async function readCache(cwd: string): Promise<Cache> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(await cachePath(cwd), 'utf8'));
	} catch {
		return {};
	}

	if (typeof raw !== 'object' || raw === null) return {};
	const {version, files} = raw as Record<string, unknown>;
	if (
		version !== CACHE_VERSION ||
		typeof files !== 'object' ||
		files === null ||
		Array.isArray(files)
	) {
		return {};
	}

	const cache: Cache = {};
	for (const [blob, owners] of Object.entries(files)) {
		if (
			!Array.isArray(owners) ||
			!owners.every(owner => typeof owner === 'string')
		) {
			return {};
		}

		cache[blob] = owners;
	}

	return cache;
}

/** Written aside and renamed, so a call racing this one never reads half a file. */
async function writeCache(cwd: string, files: Cache): Promise<void> {
	const file = await cachePath(cwd);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), {recursive: true});
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({version: CACHE_VERSION, files})}\n`,
		);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, {force: true});
		throw error;
	}
}
