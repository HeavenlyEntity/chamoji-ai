import {rm} from 'node:fs/promises';
import path from 'node:path';
import {readCommits, runGit, runGitWithInput} from './git.js';
import {parseCommit} from './parse.js';
import type {IntentCard} from './types.js';
import {
	STATUSES,
	isSlug,
	readWorkstreams,
	type WorkstreamStatus,
} from './workstreams.js';

export const MEMORY_REF = 'refs/chamoji/memory';

/** The last fetched copy of origin's memory. A fetch never lands on `MEMORY_REF`. */
export const MEMORY_REMOTE_REF = 'refs/chamoji/remotes/origin/memory';

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/**
 * ISO 8601 as `%aI` writes it. A commit's stamp is whatever its author's tools
 * put there, and git limits neither the year nor the offset, so this allows
 * both to run long. `Date.parse` refuses some dates that pass.
 */
const GIT_DATE =
	/^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2,}:\d{2})$/;

/** Stands in for a date git can't print: a negative or missing stamp. */
const NO_DATE = '1970-01-01T00:00:00Z';

const AUTHOR = {name: 'chamoji', email: 'noreply@chamoji.dev'};

/**
 * The environment and `author.*` config outrank `user.*`, and CI often sets
 * them. Memory gets pushed, so a real address must not reach it that way.
 */
const AUTHOR_ENV = {
	GIT_AUTHOR_NAME: AUTHOR.name,
	GIT_AUTHOR_EMAIL: AUTHOR.email,
	GIT_COMMITTER_NAME: AUTHOR.name,
	GIT_COMMITTER_EMAIL: AUTHOR.email,
};

export type MemoryCommit = {
	hash: string;
	subject: string;
	/** ISO 8601 author date. */
	date: string;
	card?: IntentCard;
};

export type MemoryEntry = {
	version: 1;
	slug: string;
	title: string;
	emoji?: string;
	status: WorkstreamStatus;
	/** ISO 8601. The newer entry wins when memory from two clones is merged. */
	updatedAt: string;
	archived: boolean;
	commits: MemoryCommit[];
};

/** Memory can't be read or written, or a request names a bad entry. */
export class MemoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MemoryError';
	}
}

export const livePath = (slug: string) => `workstreams/${slug}.json`;
export const archivePath = (slug: string) => `archive/${slug}.json`;
export const purgedPath = (slug: string) => `purged/${slug}`;

/** The live entries, and the archived ones too with `archived`, by slug. */
export async function listMemory(
	cwd: string,
	options: {archived?: boolean} = {},
): Promise<MemoryEntry[]> {
	return (await inspectMemory(cwd, options)).entries;
}

/**
 * `listMemory`, and the slugs of entries that are there but can't be read, so
 * that a caller can say so instead of showing an empty list. An archived entry
 * that is damaged is only counted when the archived ones were asked for.
 */
export async function inspectMemory(
	cwd: string,
	options: {archived?: boolean} = {},
): Promise<{entries: MemoryEntry[]; unreadable: string[]}> {
	const entries: MemoryEntry[] = [];
	const unreadable: string[] = [];
	const head = await memoryHead(cwd);
	if (head === undefined) return {entries, unreadable};
	const tree = await readTree(cwd, head);
	const slugs = new Set([...tree.keys()].map(file => slugOf(file)));
	for (const slug of [...slugs].sort()) {
		let entry: MemoryEntry | undefined;
		try {
			entry = await load(cwd, tree, slug);
		} catch (error) {
			if (!(error instanceof MemoryError)) throw error;
			// One bad entry hides only itself.
			if (options.archived || tree.has(livePath(slug))) unreadable.push(slug);
			continue;
		}

		if (entry && (options.archived || !entry.archived)) entries.push(entry);
	}

	return {entries, unreadable};
}

/** One entry, live or archived. Undefined when there is none. */
export async function readMemory(
	cwd: string,
	slug: string,
): Promise<MemoryEntry | undefined> {
	assertSlug(slug);
	const head = await memoryHead(cwd);
	if (head === undefined) return undefined;
	return load(cwd, await readTree(cwd, head), slug);
}

/**
 * Records a workstream as it stands: its title and status from the working
 * tree, and every commit on HEAD that names it, added to the commits already
 * remembered so that a deleted branch loses nothing. An archived entry comes
 * back. A purged slug stays purged: its commits are still in the history, so
 * a snapshot would undo the purge.
 */
export async function snapshotWorkstream(
	cwd: string,
	slug: string,
): Promise<MemoryEntry> {
	assertSlug(slug);
	const workstreams = await readWorkstreams(cwd);
	const workstream = workstreams.find(item => item.slug === slug);
	if (!workstream) throw new MemoryError(`No workstream named "${slug}"`);
	const commits = await commitsNaming(cwd, slug);
	const onHead = await hashesOnHead(cwd);
	return update(cwd, `Snapshot ${slug}`, async tree => {
		if (tree.has(purgedPath(slug))) {
			throw new MemoryError(
				`${slug} was purged from memory, and a purged name stays out for good. Start the workstream again under a new name`,
			);
		}

		const previous = await load(cwd, tree, slug);
		const entry: MemoryEntry = {
			version: 1,
			slug,
			title: workstream.title,
			...(workstream.emoji === undefined ? {} : {emoji: workstream.emoji}),
			status: workstream.status,
			updatedAt: new Date().toISOString(),
			archived: false,
			commits: refreshCommits(previous?.commits ?? [], commits, onHead),
		};
		tree.delete(archivePath(slug));
		tree.set(livePath(slug), await writeEntry(cwd, entry));
		return entry;
	});
}

/** Moves an entry out of the live list. Its content and history stay. */
export async function archiveMemory(cwd: string, slug: string): Promise<void> {
	assertSlug(slug);
	await update(cwd, `Archive ${slug}`, async tree => {
		const entry = await load(cwd, tree, slug);
		if (!entry) throw new MemoryError(`No memory for "${slug}"`);
		if (entry.archived) throw new MemoryError(`${slug} is already archived`);
		tree.delete(livePath(slug));
		tree.set(
			archivePath(slug),
			await writeEntry(cwd, {
				...entry,
				archived: true,
				updatedAt: new Date().toISOString(),
			}),
		);
	});
}

/**
 * Removes an entry for good, leaving a tombstone so a merge can't bring it
 * back. Blobs stay reachable through parents, so the ref restarts from a new
 * root commit, and the fetched copy of origin goes too because it holds the
 * text; the old objects remain on disk until git collects them. So does this
 * worktree's search index, which holds the entry's text, and it is deleted.
 * The index of another worktree is stale once the ref moves, and its next
 * search rebuilds it. It goes by path, so an entry too damaged to read can
 * still be removed.
 */
export async function purgeMemory(cwd: string, slug: string): Promise<void> {
	assertSlug(slug);
	await update(
		cwd,
		`Purge ${slug}`,
		async tree => {
			const live = tree.delete(livePath(slug));
			const archived = tree.delete(archivePath(slug));
			if (!live && !archived) {
				throw new MemoryError(`No memory for "${slug}"`);
			}

			tree.set(purgedPath(slug), await writeBlob(cwd, ''));
		},
		{root: true},
	);
	if ((await headOf(cwd, MEMORY_REMOTE_REF)) !== undefined) {
		await runGit(['update-ref', '-d', MEMORY_REMOTE_REF], cwd);
	}

	await rm(await memoryIndexPath(cwd), {force: true});
}

/** Where this worktree keeps its search index; the git directory is per worktree. */
export async function memoryIndexPath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return path.join(gitDir, 'chamoji', 'memory-index.json');
}

/**
 * A tree entry that chamoji does not own: a path outside the layout this
 * version knows, such as a folder a newer chamoji added, or a layout path with
 * a mode other than a plain file. Reads leave these out. Writes and merges
 * carry them along, so an older chamoji can't strip them from a shared ref.
 */
export type Foreign = {mode: string; type: string; id: string};

/** The files in a memory commit, and the entries that were left out of them. */
export type MemoryTree = {
	files: Map<string, string>;
	foreign: Map<string, Foreign>;
};

/** Deeper than any real layout; a longer path is dropped, not rebuilt. */
const MAX_DEPTH = 64;

/**
 * The files in a memory commit, as path to blob id. The ref is fetched from
 * other people, so anything but a regular file at a path of the layout is
 * left out here, and no caller sees it.
 */
export async function readTree(
	cwd: string,
	commit: string,
): Promise<Map<string, string>> {
	return (await readFullTree(cwd, commit)).files;
}

/** `readTree`, and what it left out, for a caller that writes the tree back. */
export async function readFullTree(
	cwd: string,
	commit: string,
): Promise<MemoryTree> {
	// Without --full-tree, ls-tree answers relative to cwd.
	const stdout = await runGit(
		['ls-tree', '-r', '-z', '--full-tree', commit],
		cwd,
	);
	const files = new Map<string, string>();
	const foreign = new Map<string, Foreign>();
	for (const line of stdout.split('\0')) {
		const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t(.+)$/s.exec(line);
		if (!match) continue;
		const [, mode = '', type = '', id = '', file = ''] = match;
		if (mode === '100644' && type === 'blob' && isMemoryPath(file)) {
			files.set(file, id);
		} else {
			foreign.set(file, {mode, type, id});
		}
	}

	return {files, foreign};
}

const describeEntry = ({mode, type, id}: Foreign) => `${mode} ${type} ${id}`;

/**
 * The foreign entries of two trees, together. Where both have a path with
 * different content, the larger of the two wins, which every clone picks, so
 * they settle on one tree. Entries on a path of a purged slug go.
 */
export function mergeForeign(
	ours: Map<string, Foreign>,
	theirs: Map<string, Foreign>,
	files: Map<string, string>,
): Map<string, Foreign> {
	const merged = new Map(ours);
	for (const [file, entry] of theirs) {
		const other = merged.get(file);
		if (!other || describeEntry(entry) > describeEntry(other)) {
			merged.set(file, entry);
		}
	}

	return withoutPurged(merged, files);
}

/** Whether two sets of foreign entries are the same. */
export function isSameForeign(
	a: Map<string, Foreign>,
	b: Map<string, Foreign>,
): boolean {
	return (
		a.size === b.size &&
		[...a].every(([file, entry]) => {
			const other = b.get(file);
			return (
				other !== undefined && describeEntry(entry) === describeEntry(other)
			);
		})
	);
}

/** Drops entries on a layout path of a slug that `files` has a tombstone for. */
export function withoutPurged(
	foreign: Map<string, Foreign>,
	files: Map<string, string>,
): Map<string, Foreign> {
	return new Map(
		[...foreign].filter(
			([file]) => !(isMemoryPath(file) && files.has(purgedPath(slugOf(file)))),
		),
	);
}

/** A leaf of the tree being written: where it goes, and whether chamoji owns it. */
type Leaf = {path: string[]; entry: Foreign; owned: boolean};

/**
 * Writes `entries` as a commit on top of `parents`, without moving any ref.
 * `foreign` entries are written back as they were, except those whose path
 * `entries` has too.
 */
export async function writeTree(
	cwd: string,
	entries: Map<string, string>,
	parents: string[],
	message: string,
	foreign: Map<string, Foreign> = new Map(),
): Promise<string> {
	const leaves: Leaf[] = [];
	for (const [file, blob] of entries) {
		if (!isMemoryPath(file) || !OBJECT_ID.test(blob)) {
			throw new MemoryError(`"${file}" does not belong in memory`);
		}

		leaves.push({
			path: file.split('/'),
			entry: {mode: '100644', type: 'blob', id: blob},
			owned: true,
		});
	}

	for (const [file, entry] of foreign) {
		const path = file.split('/');
		if (!entries.has(file) && isRebuildable(path)) {
			leaves.push({path, entry, owned: false});
		}
	}

	const stdout = await runGitWithInput(
		[
			'-c',
			`user.name=${AUTHOR.name}`,
			'-c',
			`user.email=${AUTHOR.email}`,
			'commit-tree',
			await makeNested(cwd, leaves),
			...parents.flatMap(parent => ['-p', parent]),
		],
		cwd,
		message,
		AUTHOR_ENV,
	);
	return stdout.trim();
}

/** A path of names git accepts, not absurdly deep. */
function isRebuildable(path: string[]): boolean {
	return (
		path.length <= MAX_DEPTH &&
		path.every(
			name => !['', '.', '..'].includes(name) && !/^\.git$/i.test(name),
		)
	);
}

/**
 * Builds the trees for `leaves`, folder by folder. A name can't be a file in
 * one leaf and a folder in another: chamoji's own file keeps its name, and
 * otherwise the folder does.
 */
async function makeNested(cwd: string, leaves: Leaf[]): Promise<string> {
	const files = new Map<string, Leaf>();
	const folders = new Map<string, Leaf[]>();
	for (const leaf of leaves) {
		const [name = '', ...rest] = leaf.path;
		if (rest.length > 0) {
			folders.set(name, [...(folders.get(name) ?? []), {...leaf, path: rest}]);
		} else if (!files.get(name)?.owned) {
			files.set(name, leaf);
		}
	}

	const lines: string[] = [];
	for (const [name, below] of folders) {
		if (files.get(name)?.owned && !below.some(leaf => leaf.owned)) continue;
		files.delete(name);
		lines.push(`040000 tree ${await makeNested(cwd, below)}\t${name}`);
	}

	for (const [name, {entry}] of files) {
		lines.push(`${entry.mode} ${entry.type} ${entry.id}\t${name}`);
	}

	return makeTree(cwd, lines);
}

async function makeTree(cwd: string, lines: string[]): Promise<string> {
	// -z, because a name in a fetched tree may hold a newline.
	const input = lines.map(line => `${line}\0`).join('');
	// A submodule's commit is not in this repo, and mktree would refuse it.
	const missing = lines.some(line => line.startsWith('160000 '))
		? ['--missing']
		: [];
	return (
		await runGitWithInput(['mktree', '-z', ...missing], cwd, input)
	).trim();
}

async function writeBlob(cwd: string, text: string): Promise<string> {
	const args = ['hash-object', '-w', '--stdin'];
	return (await runGitWithInput(args, cwd, text)).trim();
}

/** Refuses an entry it couldn't read back, so a good one is never replaced by it. */
export async function writeEntry(
	cwd: string,
	entry: MemoryEntry,
): Promise<string> {
	if (!toEntry(entry, entry.slug, entry.archived)) {
		throw new MemoryError(`The entry for ${entry.slug} would not read back`);
	}

	return writeBlob(cwd, `${JSON.stringify(entry, null, 2)}\n`);
}

/** The commit the ref is on, or undefined before the first write. */
async function memoryHead(cwd: string): Promise<string | undefined> {
	return headOf(cwd, MEMORY_REF);
}

export async function headOf(
	cwd: string,
	ref: string,
): Promise<string | undefined> {
	try {
		const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
		return (await runGit(args, cwd)).trim();
	} catch {
		return undefined;
	}
}

/**
 * Applies `change` to the tree and moves the ref with compare-and-swap, so a
 * writer in another process can't be overwritten. Losing that race starts
 * again from the new tip, once. Nothing here goes near HEAD or the index.
 * What `readTree` leaves out is written back as it was.
 */
async function update<T>(
	cwd: string,
	message: string,
	change: (tree: Map<string, string>) => Promise<T>,
	{root = false}: {root?: boolean} = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const head = await memoryHead(cwd);
		const {files: tree, foreign} =
			head === undefined
				? {
						files: new Map<string, string>(),
						foreign: new Map<string, Foreign>(),
					}
				: await readFullTree(cwd, head);
		const result = await change(tree);
		const parents = root || head === undefined ? [] : [head];
		const commit = await writeTree(
			cwd,
			tree,
			parents,
			message,
			withoutPurged(foreign, tree),
		);
		try {
			// An empty old value means the ref must not exist yet.
			await runGit(['update-ref', MEMORY_REF, commit, head ?? ''], cwd);
			return result;
		} catch (error) {
			if (attempt === 2) {
				const {stderr} = error as {stderr?: string};
				throw new MemoryError(
					`Could not update ${MEMORY_REF}: ${stderr?.trim() || (error as Error).message}`,
				);
			}
		}
	}
}

function assertSlug(slug: string): void {
	if (!isSlug(slug)) {
		throw new MemoryError(`"${slug}" is not a valid workstream slug`);
	}
}

function isMemoryPath(file: string): boolean {
	const [folder, name, ...rest] = file.split('/');
	if (name === undefined || rest.length > 0) return false;
	if (folder === 'purged') return isSlug(name);
	return (
		(folder === 'workstreams' || folder === 'archive') &&
		name.endsWith('.json') &&
		isSlug(name.slice(0, -'.json'.length))
	);
}

export function slugOf(file: string): string {
	return file.slice(file.indexOf('/') + 1).replace(/\.json$/, '');
}

/**
 * The entry for `slug` in `tree`. A live one comes before an archived one, and
 * a tombstone beats both.
 */
async function load(
	cwd: string,
	tree: Map<string, string>,
	slug: string,
): Promise<MemoryEntry | undefined> {
	if (tree.has(purgedPath(slug))) return undefined;
	const archived = !tree.has(livePath(slug));
	const blob = tree.get(archived ? archivePath(slug) : livePath(slug));
	if (blob === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(await runGit(['cat-file', 'blob', blob], cwd));
	} catch {
		parsed = undefined;
	}

	const entry = toEntry(parsed, slug, archived);
	if (!entry) throw new MemoryError(`The memory entry for ${slug} is damaged`);
	return entry;
}

/**
 * Builds an entry from untrusted JSON, picking each known field so nothing
 * else survives. Where it lives says what it is, not what it claims.
 */
export function toEntry(
	raw: unknown,
	slug: string,
	archived: boolean,
): MemoryEntry | undefined {
	if (!isPlain(raw) || raw['version'] !== 1 || raw['slug'] !== slug) {
		return undefined;
	}

	const {title, emoji, status, updatedAt, commits} = raw;
	if (typeof title !== 'string' || title.trim() === '') return undefined;
	if (emoji !== undefined && typeof emoji !== 'string') return undefined;
	if (!STATUSES.includes(status as WorkstreamStatus)) return undefined;
	// A merge compares these, so unlike a commit's date it must be a real time.
	if (!isDate(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
		return undefined;
	}

	if (!Array.isArray(commits)) return undefined;
	const parsed = commits.map(commit => toCommit(commit));
	if (!parsed.every(commit => commit !== undefined)) return undefined;
	return {
		version: 1,
		slug,
		title,
		...(emoji === undefined ? {} : {emoji}),
		status: status as WorkstreamStatus,
		updatedAt,
		archived,
		commits: mergeCommits(parsed, []),
	};
}

function toCommit(raw: unknown): MemoryCommit | undefined {
	if (!isPlain(raw)) return undefined;
	const {hash, subject, date, card} = raw;
	if (typeof hash !== 'string' || !OBJECT_ID.test(hash)) return undefined;
	if (typeof subject !== 'string' || !isDate(date)) return undefined;
	if (card === undefined) return {hash, subject, date};
	const parsedCard = toCard(card);
	return parsedCard && {hash, subject, date, card: parsedCard};
}

export function toCard(raw: unknown): IntentCard | undefined {
	if (!isPlain(raw)) return undefined;
	const {why, constraint, gotcha, followUp} = raw;
	return isTextList(why) &&
		isTextList(constraint) &&
		isTextList(gotcha) &&
		isTextList(followUp)
		? {why, constraint, gotcha, followUp}
		: undefined;
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isDate(value: unknown): value is string {
	return typeof value === 'string' && GIT_DATE.test(value);
}

/** Every commit on HEAD that names `slug`, carrying what memory keeps of it. */
async function commitsNaming(
	cwd: string,
	slug: string,
): Promise<MemoryCommit[]> {
	if ((await headOf(cwd, 'HEAD')) === undefined) return []; // No commits yet.
	const raw = await readCommits(cwd, 'HEAD');
	return raw
		.map(commit => parseCommit(commit))
		.filter(commit => commit.workstream === slug)
		.map(({hash, subject, date, card}) => ({
			hash,
			subject,
			date: isDate(date) ? date : NO_DATE,
			...(card === undefined ? {} : {card}),
		}));
}

/** The hash of every commit reachable from HEAD, merges included. */
async function hashesOnHead(cwd: string): Promise<Set<string>> {
	if ((await headOf(cwd, 'HEAD')) === undefined) return new Set(); // No commits yet.
	return new Set((await runGit(['rev-list', 'HEAD'], cwd)).split('\n'));
}

/**
 * What a snapshot keeps: every commit HEAD names, as HEAD has it and card
 * included, plus the stored commits HEAD doesn't have, such as those of a
 * deleted branch. A stored card can come from another clone, so a stored
 * commit that is on HEAD is dropped: if it named this workstream it is in
 * `current`, and if it doesn't, it never belonged here.
 */
function refreshCommits(
	kept: MemoryCommit[],
	current: MemoryCommit[],
	onHead: Set<string>,
): MemoryCommit[] {
	return mergeCommits(
		kept.filter(commit => !onHead.has(commit.hash)),
		current,
	);
}

/**
 * The union by hash, newest first, with what HEAD says now beating what was
 * kept, except that a card is never lost: repeats of a hash join theirs. A date
 * JavaScript can't read sorts as the oldest.
 */
export function mergeCommits(
	kept: MemoryCommit[],
	current: MemoryCommit[],
): MemoryCommit[] {
	const byHash = new Map<string, MemoryCommit>();
	for (const commit of [...kept, ...current]) {
		const earlier = byHash.get(commit.hash);
		byHash.set(commit.hash, earlier ? keepCard(earlier, commit) : commit);
	}

	return [...byHash.values()].sort((a, b) => time(b.date) - time(a.date));
}

function keepCard(earlier: MemoryCommit, commit: MemoryCommit): MemoryCommit {
	if (!earlier.card) return commit;
	return {
		...commit,
		card: commit.card ? joinCards(earlier.card, commit.card) : earlier.card,
	};
}

function joinCards(a: IntentCard, b: IntentCard): IntentCard {
	const join = (first: string[], second: string[]) => [
		...new Set([...first, ...second]),
	];
	return {
		why: join(a.why, b.why),
		constraint: join(a.constraint, b.constraint),
		gotcha: join(a.gotcha, b.gotcha),
		followUp: join(a.followUp, b.followUp),
	};
}

function time(date: string): number {
	const value = Date.parse(date);
	return Number.isNaN(value) ? 0 : value;
}
