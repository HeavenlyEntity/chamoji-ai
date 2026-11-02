import {readCommits, runGit, runGitWithInput} from './git.js';
import {parseCommit} from './parse.js';
import type {IntentCard, RawCommit} from './types.js';
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
	const head = await memoryHead(cwd);
	if (head === undefined) return [];
	const tree = await readTree(cwd, head);
	const slugs = new Set([...tree.keys()].map(file => slugOf(file)));
	const entries: MemoryEntry[] = [];
	for (const slug of [...slugs].sort()) {
		let entry: MemoryEntry | undefined;
		try {
			entry = await load(cwd, tree, slug);
		} catch (error) {
			if (error instanceof MemoryError) continue; // One bad entry hides only itself.
			throw error;
		}

		if (entry && (options.archived || !entry.archived)) entries.push(entry);
	}

	return entries;
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
	return update(cwd, `Snapshot ${slug}`, async tree => {
		if (tree.has(purgedPath(slug))) {
			throw new MemoryError(`${slug} was purged, so it stays out of memory`);
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
			commits: mergeCommits(previous?.commits ?? [], commits),
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
 * text; the old objects remain on disk until git collects them. It goes by
 * path, so an entry too damaged to read can still be removed.
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
}

/**
 * The files in a memory commit, as path to blob id. The ref is fetched from
 * other people, so anything but a regular file at a path of the layout is
 * left out here, and no caller sees it.
 */
export async function readTree(
	cwd: string,
	commit: string,
): Promise<Map<string, string>> {
	// Without --full-tree, ls-tree answers relative to cwd.
	const stdout = await runGit(
		['ls-tree', '-r', '-z', '--full-tree', commit],
		cwd,
	);
	const tree = new Map<string, string>();
	for (const line of stdout.split('\0')) {
		const match = /^100644 blob ([0-9a-f]{40,64})\t(.+)$/s.exec(line);
		if (match && isMemoryPath(match[2]!)) tree.set(match[2]!, match[1]!);
	}

	return tree;
}

/** Writes `entries` as a commit on top of `parents`, without moving any ref. */
export async function writeTree(
	cwd: string,
	entries: Map<string, string>,
	parents: string[],
	message: string,
): Promise<string> {
	const folders = new Map<string, string[]>();
	for (const [file, blob] of entries) {
		if (!isMemoryPath(file) || !OBJECT_ID.test(blob)) {
			throw new MemoryError(`"${file}" does not belong in memory`);
		}

		const [folder, name] = file.split('/') as [string, string];
		folders.set(folder, [
			...(folders.get(folder) ?? []),
			`100644 blob ${blob}\t${name}`,
		]);
	}

	const root: string[] = [];
	for (const [folder, lines] of folders) {
		root.push(`040000 tree ${await makeTree(cwd, lines)}\t${folder}`);
	}

	const stdout = await runGitWithInput(
		[
			'-c',
			`user.name=${AUTHOR.name}`,
			'-c',
			`user.email=${AUTHOR.email}`,
			'commit-tree',
			await makeTree(cwd, root),
			...parents.flatMap(parent => ['-p', parent]),
		],
		cwd,
		message,
		AUTHOR_ENV,
	);
	return stdout.trim();
}

async function makeTree(cwd: string, lines: string[]): Promise<string> {
	const input = lines.map(line => `${line}\n`).join('');
	return (await runGitWithInput(['mktree'], cwd, input)).trim();
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
 */
async function update<T>(
	cwd: string,
	message: string,
	change: (tree: Map<string, string>) => Promise<T>,
	{root = false}: {root?: boolean} = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const head = await memoryHead(cwd);
		const tree = head === undefined ? new Map() : await readTree(cwd, head);
		const result = await change(tree);
		const parents = root || head === undefined ? [] : [head];
		const commit = await writeTree(cwd, tree, parents, message);
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

function toCard(raw: unknown): IntentCard | undefined {
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
		.filter(commit => isWhole(commit))
		.map(commit => parseCommit(commit))
		.filter(commit => commit.workstream === slug)
		.map(({hash, subject, date, card}) => ({
			hash,
			subject,
			date: isDate(date) ? date : NO_DATE,
			...(card === undefined ? {} : {card}),
		}));
}

/**
 * A separator byte in a commit's text can split its record in `readCommits`.
 * The pieces after the split aren't commits, and may not have every field.
 */
function isWhole({hash, body}: RawCommit): boolean {
	return OBJECT_ID.test(hash) && body !== undefined;
}

/**
 * The union by hash, newest first, with what HEAD says now beating what was
 * kept. A date JavaScript can't read sorts as the oldest.
 */
export function mergeCommits(
	kept: MemoryCommit[],
	current: MemoryCommit[],
): MemoryCommit[] {
	const byHash = new Map(kept.map(commit => [commit.hash, commit]));
	for (const commit of current) byHash.set(commit.hash, commit);
	return [...byHash.values()].sort((a, b) => time(b.date) - time(a.date));
}

function time(date: string): number {
	const value = Date.parse(date);
	return Number.isNaN(value) ? 0 : value;
}
