import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from './git.js';
import {shallowStamp} from './memory.js';

export type Survival = {
	/** Undefined when the commit added no lines. */
	survives: boolean | undefined;
	/** Paths the commit added lines to. */
	files: string[];
};

/** Bump it when the file's layout or what goes into it changes. */
const CACHE_VERSION = 3;

/** What blame said about one path: the blob it was run on, and who owned lines. */
type Entry = {blob: string; owners: string[]};

/** By path, in a Map so a key like `__proto__` in the untrusted file is only a key. */
type Cache = Map<string, Entry>;

const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/**
 * Whether each commit in `hashes` still owns a line at HEAD. A commit that
 * added no lines has nothing to own, so its answer is undefined. Blame can
 * only say a commit's lines are gone; a file it can't blame counts as owned
 * by nobody, and the caller treats that as doubt, never as a resolution.
 *
 * A path that is missing at HEAD may only have moved, so rename detection
 * between the commit and HEAD says where it went, and that path is blamed.
 * What git can't trace reads as gone, which fails toward doubt.
 *
 * Results are kept per path in the git directory. Blame follows a path's
 * history, not just its content, so an entry is trusted only while the blob
 * is the one at HEAD and every owner is still a commit on HEAD; an amend or
 * rebase leaves the content alone but renames the owners. A shallow clone's
 * blame credits its boundary with lines older commits wrote, so the whole
 * file is dropped once the boundary changes. `onBlame` hears of each file
 * actually blamed.
 *
 * Every git command runs from the top of the work tree, whatever `cwd` is
 * inside it, since paths are kept from the top. `head` is the revision to
 * list and blame, HEAD by default; a caller that read HEAD once passes the
 * hash it read, so a HEAD that moves meanwhile can't mix two histories.
 */
export async function readSurvival(
	where: string,
	hashes: string[],
	options: {onBlame?: (file: string) => void; head?: string} = {},
): Promise<Map<string, Survival>> {
	const result = new Map<string, Survival>();
	if (hashes.length === 0) return result;

	const cwd = await topLevel(where);
	const head = options.head ?? 'HEAD';
	const blobs = await headBlobs(cwd, head);
	const onHead = await headCommits(cwd, head);
	const shallow = await shallowStamp(cwd);
	const cached = await readCache(cwd, shallow);
	const cache: Cache = new Map();
	// Only entries that still hold are kept, and only paths at HEAD.
	for (const [file, entry] of cached) {
		if (
			blobs.get(file) === entry.blob &&
			entry.owners.every(owner => onHead.has(owner))
		) {
			cache.set(file, entry);
		}
	}

	let changed = cache.size !== cached.size;
	const ownersOf = async (file: string): Promise<Set<string>> => {
		const blob = blobs.get(file);
		if (blob === undefined) return new Set();
		const known = cache.get(file);
		if (known) return new Set(known.owners);
		options.onBlame?.(file);
		const found = await blameOwners(cwd, file, head);
		// A failed blame is not kept: it may work next time.
		if (found === undefined) return new Set();
		cache.set(file, {blob, owners: [...found]});
		changed = true;
		return found;
	};

	for (const hash of new Set(hashes)) {
		const added = await addedFiles(cwd, hash);
		const missing = added.filter(file => !blobs.has(file));
		const moved =
			missing.length > 0 ? await renames(cwd, hash, head) : new Map();
		const files = added.map(file => moved.get(file) ?? file);
		let survives: boolean | undefined = files.length > 0 ? false : undefined;
		for (const file of files) {
			if ((await ownersOf(file)).has(hash)) {
				survives = true;
				break;
			}
		}

		result.set(hash, {survives, files});
	}

	if (changed) await writeCache(cwd, shallow, cache).catch(() => undefined);
	return result;
}

/**
 * The top of the work tree `cwd` is in. A repository with no work tree has
 * none, and its paths are already from the top.
 */
export async function topLevel(cwd: string): Promise<string> {
	try {
		const top = (await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();
		return top === '' ? cwd : top;
	} catch {
		return cwd;
	}
}

/** Every commit on `head`; empty when there is none. */
async function headCommits(cwd: string, head: string): Promise<Set<string>> {
	try {
		const stdout = await runGit(['rev-list', '--end-of-options', head], cwd);
		return new Set(stdout.split('\n').filter(Boolean));
	} catch {
		return new Set();
	}
}

/**
 * Where paths went between `hash` and `head`, old path to new, for the renames
 * git detects. One call covers every path of the commit. Records are NUL
 * ended: a rename is `R<score>`, the old path and the new path; any other
 * status has one path.
 */
async function renames(
	cwd: string,
	hash: string,
	head: string,
): Promise<Map<string, string>> {
	const moved = new Map<string, string>();
	let stdout: string;
	try {
		stdout = await runGit(
			[
				'diff',
				'-M',
				'--name-status',
				'-z',
				'--end-of-options',
				hash,
				head,
				'--',
			],
			cwd,
		);
	} catch {
		return moved;
	}

	const fields = stdout.split('\0');
	for (let i = 0; i < fields.length; i++) {
		const status = fields[i]!;
		if (status === '') continue;
		if (status.startsWith('R') || status.startsWith('C')) {
			if (status.startsWith('R')) moved.set(fields[i + 1]!, fields[i + 2]!);
			i += 2;
		} else {
			i += 1;
		}
	}

	return moved;
}

/**
 * The paths a commit added lines to; a binary file or a failed `git show`
 * gives none. Whitespace is ignored as blame ignores it, so a commit that
 * only changed whitespace added no lines.
 */
async function addedFiles(cwd: string, hash: string): Promise<string[]> {
	let stdout: string;
	try {
		stdout = await runGit(
			[
				'show',
				'--numstat',
				'-w',
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

/** Path to blob id for every regular file at `head`, from the top of the tree. */
async function headBlobs(
	cwd: string,
	head: string,
): Promise<Map<string, string>> {
	const blobs = new Map<string, string>();
	let stdout: string;
	try {
		stdout = await runGit(
			['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', head],
			cwd,
		);
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

/** The commits that own a line of `file` at `head`; undefined when blame fails. */
async function blameOwners(
	cwd: string,
	file: string,
	head: string,
): Promise<Set<string> | undefined> {
	let stdout: string;
	try {
		// The same flags as `blameLine`; `head`, not the working copy, is blamed.
		stdout = await runGit(
			['blame', '--porcelain', '-w', '-M', head, '--', file],
			cwd,
		);
	} catch {
		return undefined;
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
 * The stored results when they were blamed with this shallow boundary. The
 * file is local but can be cut short or edited, so anything that does not
 * check out is treated as absent, an entry at a time.
 */
async function readCache(cwd: string, shallow: string): Promise<Cache> {
	const cache: Cache = new Map();
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(await cachePath(cwd), 'utf8'));
	} catch {
		return cache;
	}

	if (typeof raw !== 'object' || raw === null) return cache;
	const {version, shallow: stamp, files} = raw as Record<string, unknown>;
	if (
		version !== CACHE_VERSION ||
		stamp !== shallow ||
		typeof files !== 'object' ||
		files === null ||
		Array.isArray(files)
	) {
		return cache;
	}

	for (const [file, entry] of Object.entries(files)) {
		if (typeof entry !== 'object' || entry === null) continue;
		const {blob, owners} = entry as Record<string, unknown>;
		if (
			typeof blob === 'string' &&
			Array.isArray(owners) &&
			owners.every(owner => typeof owner === 'string' && COMMIT_ID.test(owner))
		) {
			cache.set(file, {blob, owners: owners as string[]});
		}
	}

	return cache;
}

/** Written aside and renamed, so a call racing this one never reads half a file. */
async function writeCache(
	cwd: string,
	shallow: string,
	cache: Cache,
): Promise<void> {
	const file = await cachePath(cwd);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), {recursive: true});
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({version: CACHE_VERSION, shallow, files: Object.fromEntries(cache)})}\n`,
		);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, {force: true});
		throw error;
	}
}
