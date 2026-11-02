import {runGit} from './git.js';
import {
	MEMORY_REF,
	MEMORY_REMOTE_REF,
	MemoryError,
	archivePath,
	headOf,
	listMemory,
	livePath,
	mergeCommits,
	purgedPath,
	readTree,
	slugOf,
	toEntry,
	writeEntry,
	writeTree,
	type MemoryEntry,
} from './memory.js';

/**
 * A wildcard, because an exact refspec makes every plain `git fetch` and
 * `git pull` die until the remote has the ref. It lands beside the local ref,
 * since a forced fetch onto that would throw away local entries.
 */
export const MEMORY_FETCH_REFSPEC =
	'+refs/chamoji/*:refs/chamoji/remotes/origin/*';

export type PullResult = {
	/** Origin has memory, and it was read. */
	fetched: boolean;
	/** The local ref moved to take in what origin has. */
	merged: boolean;
	/** The local ref has something origin doesn't. */
	ahead: boolean;
	/**
	 * Origin still holds an entry purged here, so only a force-push can take
	 * it there. Nothing in chamoji forces.
	 */
	needsForce: boolean;
	/** Live and archived entries on the local ref now. */
	entries: number;
};

export type SyncResult = Omit<PullResult, 'ahead'> & {pushed: boolean};

/** Whether this repo has an origin. Git failing for any other reason throws. */
export async function hasOrigin(cwd: string): Promise<boolean> {
	try {
		await runGit(['remote', 'get-url', 'origin'], cwd);
		return true;
	} catch (error) {
		if (exitCode(error) === 2) return false; // How git says there's no such remote.
		throw new MemoryError(`Could not read the remotes: ${gitMessage(error)}`);
	}
}

/**
 * Whether `chamoji init` set this clone up to share memory. Entries can hold
 * cards from branches never pushed, so publishing them on the way past, as
 * `release --push` does, waits for that opt-in.
 */
export async function fetchesMemory(cwd: string): Promise<boolean> {
	// Exit 1 means no values at all.
	const lines = await runGit(
		['config', '--get-all', 'remote.origin.fetch'],
		cwd,
	).catch(() => '');
	return lines.split('\n').includes(MEMORY_FETCH_REFSPEC);
}

/** Fetches origin's memory and merges it into the local ref. Pushes nothing. */
export async function pullMemory(cwd: string): Promise<PullResult> {
	if (!(await hasOrigin(cwd))) throw new MemoryError('No remote named origin');
	try {
		// --prune so that a copy of a ref origin has lost can't pass for its memory.
		await runGit(
			[
				'fetch',
				'--quiet',
				'--prune',
				'--no-tags',
				'origin',
				MEMORY_FETCH_REFSPEC,
			],
			cwd,
		);
	} catch (error) {
		throw new MemoryError(
			`Could not fetch memory from origin: ${gitMessage(error)}`,
		);
	}

	const local = await headOf(cwd, MEMORY_REF);
	const remote = await headOf(cwd, MEMORY_REMOTE_REF);
	const head = remote === undefined ? local : await combine(cwd, local, remote);
	if (head !== undefined && head !== local) {
		try {
			// An empty old value means the ref must not exist yet.
			await runGit(['update-ref', MEMORY_REF, head, local ?? ''], cwd);
		} catch (error) {
			throw new MemoryError(
				`Could not update ${MEMORY_REF}: ${gitMessage(error)}`,
			);
		}
	}

	const ahead = head !== undefined && head !== remote;
	return {
		fetched: remote !== undefined,
		merged: head !== local,
		ahead,
		needsForce:
			ahead && remote !== undefined && !(await isAncestor(cwd, remote, head)),
		entries: (await listMemory(cwd, {archived: true})).length,
	};
}

/**
 * Merges origin's memory in and pushes the result, and nothing but the memory
 * ref. A push that loses a race starts again from origin's new tip, once; any
 * other failure, a pre-push hook's refusal included, is reported as it is. It never
 * forces: when only a force-push would do, the result says so.
 */
export async function syncMemory(cwd: string): Promise<SyncResult> {
	let merged = false;
	for (let attempt = 1; ; attempt++) {
		const {ahead, ...pull} = await pullMemory(cwd);
		merged ||= pull.merged;
		if (!ahead || pull.needsForce) return {...pull, merged, pushed: false};
		try {
			await runGit(
				['push', '--quiet', 'origin', `${MEMORY_REF}:${MEMORY_REF}`],
				cwd,
			);
			return {...pull, merged, pushed: true};
		} catch (error) {
			// Only a push that lost a race can win on a second try. A hook that
			// declined it, a network failure or a missing right would just fail again.
			if (attempt === 2 || !wasRejected(error)) {
				throw new MemoryError(
					`Could not push memory to origin: ${gitMessage(error)}`,
				);
			}
		}
	}
}

/**
 * Whether git refused the push because origin's ref moved on, which it says as
 * `! [rejected]`. A remote hook's refusal is `! [remote rejected]` instead.
 */
function wasRejected(error: unknown): boolean {
	const {stderr} = error as {stderr?: string};
	return stderr?.includes('[rejected]') ?? false;
}

/** The commit the local ref should be on, given that origin is on `remote`. */
async function combine(
	cwd: string,
	local: string | undefined,
	remote: string,
): Promise<string> {
	if (local === undefined || local === remote) return remote;
	const behind = await isAncestor(cwd, local, remote);
	if (!behind && (await isAncestor(cwd, remote, local))) return local;
	// Being behind says nothing about what origin's tip holds. Anyone who can
	// push can drop an entry or a tombstone on top of it, so it merges too.
	const ours = await readTree(cwd, local);
	const theirs = await readTree(cwd, remote);
	const merged = await mergeTrees(
		ours,
		theirs,
		async blob => runGit(['cat-file', 'blob', blob], cwd),
		async entry => writeEntry(cwd, entry),
	);
	// A purge restarts the ref so that its text is unreachable, and a parent
	// that still holds that text would make it reachable again, and push it.
	// When each side purged what the other holds, neither can be a parent.
	const keepOurs = !holdsPurged(theirs, ours);
	const keepTheirs = !holdsPurged(ours, theirs);
	// When we're behind and can keep theirs, ours is in its history already.
	const parents = [
		...(keepOurs && !(behind && keepTheirs) ? [local] : []),
		...(keepTheirs ? [remote] : []),
	];
	const [only] = parents;
	if (parents.length === 1 && only !== undefined) {
		if (isSameTree(merged, only === local ? ours : theirs)) return only;
	}

	return writeTree(cwd, merged, parents, 'Merge memory from origin');
}

/** Whether `other` still has an entry that a tombstone in `tree` removed. */
function holdsPurged(
	tree: Map<string, string>,
	other: Map<string, string>,
): boolean {
	return [...tree.keys()].some(file => {
		if (!file.startsWith('purged/')) return false;
		const slug = slugOf(file);
		return other.has(livePath(slug)) || other.has(archivePath(slug));
	});
}

function isSameTree(a: Map<string, string>, b: Map<string, string>): boolean {
	return (
		a.size === b.size && [...a].every(([file, blob]) => b.get(file) === blob)
	);
}

async function isAncestor(
	cwd: string,
	commit: string,
	descendant: string,
): Promise<boolean> {
	try {
		await runGit(['merge-base', '--is-ancestor', commit, descendant], cwd);
		return true;
	} catch (error) {
		if (exitCode(error) === 1) return false; // The plain "no", for unrelated roots too.
		throw new MemoryError(
			`Could not compare memory commits: ${gitMessage(error)}`,
		);
	}
}

type Version = {file: string; blob: string; entry: MemoryEntry | undefined};

/**
 * Merges two memory trees: the union of paths, slug by slug. A tombstone
 * removes the slug from both sides. Otherwise the entry with the newest
 * `updatedAt` supplies everything but its commits, and archived beats live on
 * a tie. `updatedAt` comes from other people, so commits don't follow it: they
 * are the union by hash with their cards joined, and a forged date can't erase
 * either. `read` and `write` fetch a blob's text and store a merged entry as a
 * blob.
 */
export async function mergeTrees(
	ours: Map<string, string>,
	theirs: Map<string, string>,
	read: (blob: string) => Promise<string>,
	write: (entry: MemoryEntry) => Promise<string>,
): Promise<Map<string, string>> {
	const merged = new Map<string, string>();
	const slugs = new Set([...ours.keys(), ...theirs.keys()].map(slugOf));
	for (const slug of slugs) {
		const tombstone = purgedPath(slug);
		const stone = ours.get(tombstone) ?? theirs.get(tombstone);
		if (stone === undefined) {
			const [file, blob] = await mergeSlug(slug, ours, theirs, read, write);
			merged.set(file, blob);
		} else {
			merged.set(tombstone, stone);
		}
	}

	return merged;
}

async function mergeSlug(
	slug: string,
	ours: Map<string, string>,
	theirs: Map<string, string>,
	read: (blob: string) => Promise<string>,
	write: (entry: MemoryEntry) => Promise<string>,
): Promise<[string, string]> {
	const found = new Map<string, [string, string]>();
	for (const tree of [ours, theirs]) {
		for (const file of [livePath(slug), archivePath(slug)]) {
			const blob = tree.get(file);
			if (blob !== undefined) found.set(`${file} ${blob}`, [file, blob]);
		}
	}

	const [first, ...others] = [...found.values()];
	if (others.length === 0) return first!;
	const versions = await Promise.all(
		[...found.values()].map(async ([file, blob]): Promise<Version> => ({
			file,
			blob,
			entry: await readVersion(slug, file, blob, read),
		})),
	);
	const readable = versions
		.filter(version => version.entry !== undefined)
		.sort(
			(a, b) =>
				Date.parse(b.entry!.updatedAt) - Date.parse(a.entry!.updatedAt) ||
				Number(b.entry!.archived) - Number(a.entry!.archived),
		);
	const winner = readable[0];
	if (!winner) return first!; // Nothing here can be read, so ours stays as it was.
	const commits = readable.reduceRight(
		(kept, {entry}) => mergeCommits(kept, entry!.commits),
		[] as MemoryEntry['commits'],
	);
	// An entry with nothing to add keeps its blob, so two clones settle on one.
	return isSameCommits(commits, winner.entry!.commits)
		? [winner.file, winner.blob]
		: [winner.file, await write({...winner.entry!, commits})];
}

/** The same commits with the same content, in any order. */
function isSameCommits(
	a: MemoryEntry['commits'],
	b: MemoryEntry['commits'],
): boolean {
	const texts = new Map(a.map(item => [item.hash, JSON.stringify(item)]));
	return (
		a.length === b.length &&
		b.every(item => texts.get(item.hash) === JSON.stringify(item))
	);
}

async function readVersion(
	slug: string,
	file: string,
	blob: string,
	read: (blob: string) => Promise<string>,
): Promise<MemoryEntry | undefined> {
	try {
		const archived = file === archivePath(slug);
		return toEntry(JSON.parse(await read(blob)), slug, archived);
	} catch {
		return undefined;
	}
}

function gitMessage(error: unknown): string {
	const {stderr, message} = error as Error & {stderr?: string};
	return stderr?.trim() || message;
}

function exitCode(error: unknown): unknown {
	return (error as {code?: unknown}).code;
}
