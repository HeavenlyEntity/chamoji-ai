import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CARD_ID} from './card-lines.js';
import {
	foldCardState,
	liveCommits,
	type CardLine,
	type CardState,
	type FoldCommit,
	type FoldInput,
	type LineState,
} from './card-state.js';
import {readCommitFiles, readCommits, runGit, runGitWithInput} from './git.js';
import {readSurvival, topLevel, type Survival} from './line-survival.js';
import {MEMORY_REF, listMemory, shallowStampOf} from './memory.js';
import {parseCommit} from './parse.js';
import {
	readResolves,
	readRevertedHash,
	readRevertedMainline,
} from './resolves.js';
import {NOTES_REF, mergeCards, readNoteCards} from './why-notes.js';
import {STATUSES, isSlug, type WorkstreamStatus} from './workstreams.js';

/** Bump it when the file's layout or what goes into it changes. */
const CACHE_VERSION = 4;

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

const KINDS: Array<CardLine['kind']> = ['constraint', 'gotcha', 'followUp'];

const STATES: LineState[] = [
	'open',
	'resolved',
	'in-doubt',
	'off-branch',
	'reverted',
];

/** What a state was worked out from; when any of it differs the state is stale. */
export type CardStateStamp = {
	head: string;
	memory: string;
	notes: string;
	shallow: string;
};

/** Where this worktree keeps the state of its card lines; the git directory is per worktree. */
export async function cardStatePath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return stateFileIn(gitDir);
}

/** `cardStatePath` for a git directory already read, or read now when there is none. */
async function stateFile(cwd: string, gitDir?: string): Promise<string> {
	return gitDir === undefined ? cardStatePath(cwd) : stateFileIn(gitDir);
}

function stateFileIn(gitDir: string): string {
	return path.join(gitDir, 'chamoji', 'card-state.json');
}

/**
 * The state of every card line, from the commits on HEAD, the notes on them
 * and workstream memory. It is kept in the git directory under the search
 * index's stamp and the shallow boundary, so it is worked out again whenever
 * HEAD, the memory ref or the notes ref moves or a shallow clone is deepened,
 * and every reader gets the same answer
 * without paying for blame twice. A cache that can't be saved costs only
 * the next call a rebuild. It throws when git fails, so a caller building a
 * reply or running in a hook must catch it.
 */
export async function readCardState(cwd: string): Promise<CardState> {
	const {stamp, gitDir} = await readRepoStamp(cwd);
	return cardStateAt(cwd, stamp, gitDir);
}

/**
 * `readCardState` for a stamp the caller already read, so a cache of its own
 * built on the same stamp costs no second read of it. `gitDir` is the one
 * `readRepoStamp` gave, so the cache's path costs no git call either.
 */
export async function cardStateAt(
	cwd: string,
	stamp: CardStateStamp,
	gitDir?: string,
): Promise<CardState> {
	if (stamp.head === '') return {head: '', lines: [], dangling: []};
	const cached = await readCache(cwd, stamp, gitDir);
	if (cached) return cached;
	const state = await build(cwd, stamp.head);
	await writeCache(cwd, stamp, state, gitDir).catch(() => undefined);
	return state;
}

/**
 * A stamp and the paths read in the same git calls, which the caches it
 * guards live under. It is read before the content is, so a move in between
 * only costs the next call a rebuild.
 */
export type RepoStamp = {
	stamp: CardStateStamp;
	/** The git directory, or undefined when git couldn't name it. */
	gitDir: string | undefined;
	/** The top of the work tree, or '' when there is none, as in a bare repo. */
	topLevel: string;
};

/** The refs a stamp holds, in its order, each peeled to its commit as `headOf` peels it. */
const STAMP_REFS = ['HEAD', MEMORY_REF, NOTES_REF];

/**
 * The card state's stamp in two git calls run side by side, one for the refs
 * and one for the paths, where reading each part alone took four. Like
 * `headOf` and `shallowStamp`, a part git can't read is ''.
 */
export async function readRepoStamp(cwd: string): Promise<RepoStamp> {
	const [[head = '', memory = '', notes = ''], paths] = await Promise.all([
		refCommits(cwd),
		repoPaths(cwd),
	]);
	const shallow =
		paths.shallow === undefined ? '' : await shallowStampOf(cwd, paths.shallow);
	return {
		stamp: {head, memory, notes, shallow},
		gitDir: paths.gitDir,
		topLevel: paths.topLevel,
	};
}

/** The commit each of `STAMP_REFS` names, or '' for one that names none. */
async function refCommits(cwd: string): Promise<string[]> {
	let listed: string;
	try {
		listed = await runGitWithInput(
			['cat-file', '--batch-check'],
			cwd,
			STAMP_REFS.map(ref => `${ref}^{commit}\n`).join(''),
		);
	} catch {
		return STAMP_REFS.map(() => '');
	}

	// `<hash> commit <size>`, or `<name> missing` for a ref that isn't there.
	const rows = listed.split('\n');
	return STAMP_REFS.map((_, index) => {
		const [hash = '', type] = (rows[index] ?? '').split(' ');
		return type === 'commit' && OBJECT_ID.test(hash) ? hash : '';
	});
}

/**
 * The git directory, the shallow file's path as git names it from `cwd`, and
 * the top of the work tree, in one call. Outside a work tree, as in a bare
 * repo, `--show-toplevel` fails the call, so the first two are asked again.
 */
async function repoPaths(
	cwd: string,
): Promise<{gitDir?: string; shallow?: string; topLevel: string}> {
	const ask = async (...args: string[]) =>
		(await runGit(['rev-parse', ...args], cwd))
			.split('\n')
			.map(row => row.trim());
	const paths = ['--absolute-git-dir', '--git-path', 'shallow'];
	try {
		const [gitDir, shallow, topLevel] = await ask(...paths, '--show-toplevel');
		return {
			...(gitDir ? {gitDir} : {}),
			...(shallow ? {shallow} : {}),
			topLevel: topLevel ?? '',
		};
	} catch {
		try {
			const [gitDir, shallow] = await ask(...paths);
			return {
				...(gitDir ? {gitDir} : {}),
				...(shallow ? {shallow} : {}),
				topLevel: '',
			};
		} catch {
			return {topLevel: ''};
		}
	}
}

/**
 * Works from `head`, the hash the stamp holds, so a HEAD that moves meanwhile
 * can't mix two histories into one stored state. Folds once without blame, then blames only the sources of lines that came
 * out open, because blame can only move an open line to in doubt, and then
 * the restorers of those whose lines are gone. A resolved or off-branch line
 * is never blamed, and a repo with no open line blames nothing.
 */
async function build(cwd: string, head: string): Promise<CardState> {
	const {commits, reverted} = await readFoldCommits(cwd, head);
	const parents = await readParents(cwd, head);
	const merges = new Set(
		(await runGit(['rev-list', '--merges', head], cwd))
			.split('\n')
			.filter(Boolean),
	);
	const input: FoldInput = {
		head,
		commits,
		voids: await readVoids(cwd, commits, reverted, merges, parents),
		isAncestor: ancestry(parents),
		survives: new Map(),
		remembered: await readRemembered(cwd, parents),
	};

	const first = foldCardState(input);
	const open = first.lines.filter(line => line.state === 'open');
	if (open.length === 0) return first;
	const live = new Set(liveCommits(commits, input.voids).map(c => c.hash));
	const survival = await readSurvival(
		cwd,
		open.flatMap(line => line.sources),
		{head},
	);
	await creditRestorers(cwd, head, survival, restorersOf(reverted, live));
	const state = foldCardState({
		...input,
		survives: new Map(
			[...survival].map(([hash, {survives}]) => [hash, survives]),
		),
	});

	for (const line of state.lines) {
		if (line.state === 'open' || line.state === 'in-doubt') {
			line.files = filesOf(line.sources, survival);
		}
	}

	await fillReplacedBy(cwd, input, live, state.lines);
	return state;
}

/** What a revert names: its target and, for a merge, the parent it kept. */
type Reverted = {target: string; mainline?: string};

/**
 * The non-merge commits on HEAD, newest first, and the commit each revert
 * among them names. A note's lines join the commit's own, as the search index
 * has them; a `Resolves:` is read from the commit alone, because anyone can
 * add a note and only a commit settles a line.
 */
async function readFoldCommits(
	cwd: string,
	head: string,
): Promise<{commits: FoldCommit[]; reverted: Map<string, Reverted>}> {
	const added = await readNoteCards(cwd);
	const commits: FoldCommit[] = [];
	const reverted = new Map<string, Reverted>();
	for (const raw of await readCommits(cwd, head)) {
		const parsed = parseCommit(raw);
		const card = mergeCards(added.get(parsed.hash), parsed.card);
		commits.push({
			hash: parsed.hash,
			date: parsed.date,
			subject: parsed.subject,
			...(card === undefined ? {} : {card}),
			resolves: readResolves(parsed.trailers, parsed.body),
		});
		const target = readRevertedHash(parsed.body);
		if (target !== undefined) {
			const mainline = readRevertedMainline(parsed.body);
			reverted.set(parsed.hash, {
				target,
				...(mainline === undefined ? {} : {mainline}),
			});
		}
	}

	return {commits, reverted};
}

/**
 * Every commit on HEAD with its parents, merges included. In a shallow clone
 * the oldest commits list no parents, so a walk just stops there.
 */
async function readParents(
	cwd: string,
	head: string,
): Promise<Map<string, string[]>> {
	const parents = new Map<string, string[]>();
	const stdout = await runGit(['rev-list', '--parents', head], cwd);
	for (const line of stdout.split('\n')) {
		const [hash, ...rest] = line.split(' ').filter(Boolean);
		if (hash) parents.set(hash, rest);
	}

	return parents;
}

/**
 * Whether one commit is reachable from another through the parent map, so
 * a resolve that came in through a merge covers what its side branch saw.
 * The fold asks about few descendants, so each one's ancestors are walked
 * once and kept.
 */
function ancestry(parents: Map<string, string[]>): FoldInput['isAncestor'] {
	const reachable = new Map<string, Set<string>>();
	return (ancestor, descendant) => {
		let seen = reachable.get(descendant);
		if (!seen) {
			seen = new Set([descendant]);
			const queue = [descendant];
			while (queue.length > 0) {
				for (const parent of parents.get(queue.pop()!) ?? []) {
					if (!seen.has(parent)) {
						seen.add(parent);
						queue.push(parent);
					}
				}
			}

			reachable.set(descendant, seen);
		}

		return seen.has(ancestor);
	};
}

/**
 * What each revert on HEAD undoes. Reverting a commit on HEAD undoes that
 * commit; reverting a merge on HEAD undoes what the merge brought in, from
 * the side the revert did not keep. A revert of anything else, such as a
 * commit on another branch, undoes nothing here.
 */
async function readVoids(
	cwd: string,
	commits: FoldCommit[],
	reverted: Map<string, Reverted>,
	merges: Set<string>,
	parents: Map<string, string[]>,
): Promise<Map<string, string[]>> {
	const onHead = new Set(commits.map(c => c.hash));
	const voids = new Map<string, string[]>();
	for (const [revert, {target, mainline}] of reverted) {
		if (onHead.has(target)) {
			voids.set(revert, [target]);
		} else if (merges.has(target)) {
			// `git revert -m 1` is the usual case, so a mainline git didn't
			// write, or one that is not a parent of the merge, stands for it.
			const kept =
				mainline !== undefined && (parents.get(target) ?? []).includes(mainline)
					? mainline
					: `${target}^1`;
			voids.set(revert, await broughtIn(cwd, target, kept));
		}
	}

	return voids;
}

/** The non-merge commits a merge brought in that `kept`, the side a revert kept, lacks. */
async function broughtIn(
	cwd: string,
	merge: string,
	kept: string,
): Promise<string[]> {
	const stdout = await runGit(
		['rev-list', '--no-merges', `${kept}..${merge}`],
		cwd,
	);
	return stdout.split('\n').filter(Boolean);
}

/**
 * Commits kept in workstream memory that are not on HEAD. Memory is fetched
 * from other people and may be damaged; a state can still be worked out from
 * HEAD alone, so memory that can't be read counts as empty.
 */
async function readRemembered(
	cwd: string,
	parents: Map<string, string[]>,
): Promise<FoldInput['remembered']> {
	let entries: Awaited<ReturnType<typeof listMemory>>;
	try {
		entries = await listMemory(cwd, {archived: true});
	} catch {
		return [];
	}

	return entries.flatMap(entry =>
		entry.commits
			.filter(commit => !parents.has(commit.hash))
			.map(commit => ({slug: entry.slug, status: entry.status, commit})),
	);
}

/**
 * For each commit, the live reverts that put its code back: those whose chain
 * of revert targets, past the commit the revert itself undid, reaches it. A
 * revert of a revert restores the original; a longer chain is counted too,
 * since calling a source restored can only leave its line open, never
 * resolved.
 */
function restorersOf(
	reverted: Map<string, Reverted>,
	live: Set<string>,
): Map<string, string[]> {
	const restorers = new Map<string, string[]>();
	for (const [revert, {target: undone}] of reverted) {
		if (!live.has(revert)) continue;
		const seen = new Set([revert, undone]);
		let target = reverted.get(undone)?.target;
		while (target !== undefined && !seen.has(target)) {
			seen.add(target);
			restorers.set(target, [...(restorers.get(target) ?? []), revert]);
			target = reverted.get(target)?.target;
		}
	}

	return restorers;
}

/**
 * Blame credits code a revert of a revert put back to that revert, so the
 * commit that first wrote it looks gone. A source whose own lines are gone
 * survives when one of its restorers' lines does, and that restorer's files
 * join its own. Only those sources' restorers are blamed.
 */
async function creditRestorers(
	cwd: string,
	head: string,
	survival: Map<string, Survival>,
	restorers: Map<string, string[]>,
): Promise<void> {
	const gone = [...survival].filter(
		([hash, {survives}]) => survives === false && restorers.has(hash),
	);
	if (gone.length === 0) return;
	const checked = await readSurvival(
		cwd,
		gone.flatMap(([hash]) => restorers.get(hash)!),
		{head},
	);
	for (const [hash, {files}] of gone) {
		const back = restorers
			.get(hash)!
			.filter(restorer => checked.get(restorer)?.survives === true);
		if (back.length === 0) continue;
		survival.set(hash, {
			survives: true,
			files: [
				...new Set([
					...files,
					...back.flatMap(restorer => checked.get(restorer)!.files),
				]),
			],
		});
	}
}

/** The paths the checked sources added lines to, each once. */
function filesOf(sources: string[], survival: Map<string, Survival>): string[] {
	return [...new Set(sources.flatMap(hash => survival.get(hash)?.files ?? []))];
}

/**
 * For each line in doubt, the newest commit on HEAD that changed one of its
 * files and could have replaced its code: not one of its sources, in `live`,
 * the commits the fold counts as live, and a descendant of at least one source. A commit a
 * revert undid or one written before the line was stated can't be where it
 * went. Paths are listed from the top of the work tree, so neither the
 * caller's folder nor `diff.relative` can make them differ from `files`.
 */
async function fillReplacedBy(
	cwd: string,
	input: FoldInput,
	live: Set<string>,
	lines: CardLine[],
): Promise<void> {
	const inDoubt = lines.filter(line => line.state === 'in-doubt');
	if (inDoubt.length === 0) return;
	const changed = await readCommitFiles(await topLevel(cwd), input.head);
	for (const line of inDoubt) {
		for (const [hash, files] of changed) {
			if (
				!line.sources.includes(hash) &&
				live.has(hash) &&
				line.sources.some(source => input.isAncestor(source, hash)) &&
				files.some(file => line.files.includes(file))
			) {
				line.replacedBy = hash;
				break;
			}
		}
	}
}

/**
 * The stored state when it was worked out from this stamp. The file is local
 * but can be cut short or edited, so anything that does not check out, down
 * to one field of one line, means a rebuild.
 */
async function readCache(
	cwd: string,
	stamp: CardStateStamp,
	gitDir: string | undefined,
): Promise<CardState | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(await stateFile(cwd, gitDir), 'utf8'));
	} catch {
		return undefined;
	}

	if (!isPlain(raw)) return undefined;
	const {version, head, memory, notes, shallow, state} = raw;
	if (
		version !== CACHE_VERSION ||
		head !== stamp.head ||
		memory !== stamp.memory ||
		notes !== stamp.notes ||
		shallow !== stamp.shallow ||
		!isPlain(state) ||
		state['head'] !== stamp.head ||
		!Array.isArray(state['lines']) ||
		!Array.isArray(state['dangling'])
	) {
		return undefined;
	}

	const lines = (state['lines'] as unknown[]).map(item => toLine(item));
	const dangling = (state['dangling'] as unknown[]).map(item =>
		toDangling(item),
	);
	if (
		!lines.every(line => line !== undefined) ||
		!dangling.every(item => item !== undefined)
	) {
		return undefined;
	}

	return {head: stamp.head, lines, dangling};
}

/** A line from untrusted JSON, picking each known field so nothing else survives. */
function toLine(raw: unknown): CardLine | undefined {
	if (!isPlain(raw)) return undefined;
	const {id, kind, text, state, sources, date, files} = raw;
	const {resolvedBy, replacedBy, replaces, workstream, revertedBy} = raw;
	if (
		!isId(id) ||
		!KINDS.includes(kind as CardLine['kind']) ||
		typeof text !== 'string' ||
		!STATES.includes(state as LineState) ||
		!Array.isArray(sources) ||
		!sources.every(isHash) ||
		typeof date !== 'string' ||
		!Array.isArray(files) ||
		!files.every(file => typeof file === 'string')
	) {
		return undefined;
	}

	const line: CardLine = {
		id,
		kind: kind as CardLine['kind'],
		text,
		state: state as LineState,
		sources,
		date,
		files,
	};
	if (resolvedBy !== undefined) {
		if (!isPlain(resolvedBy)) return undefined;
		const {hash, date: resolvedAt, reason} = resolvedBy;
		if (
			!isHash(hash) ||
			typeof resolvedAt !== 'string' ||
			typeof reason !== 'string'
		) {
			return undefined;
		}

		line.resolvedBy = {hash, date: resolvedAt, reason};
	}

	if (replacedBy !== undefined) {
		if (!isHash(replacedBy)) return undefined;
		line.replacedBy = replacedBy;
	}

	if (replaces !== undefined) {
		if (!isId(replaces)) return undefined;
		line.replaces = replaces;
	}

	if (workstream !== undefined) {
		if (!isPlain(workstream)) return undefined;
		const {slug, status} = workstream;
		if (
			typeof slug !== 'string' ||
			!isSlug(slug) ||
			!STATUSES.includes(status as WorkstreamStatus)
		) {
			return undefined;
		}

		line.workstream = {slug, status: status as WorkstreamStatus};
	}

	if (revertedBy !== undefined) {
		if (!isHash(revertedBy)) return undefined;
		line.revertedBy = revertedBy;
	}

	return line;
}

function toDangling(raw: unknown): CardState['dangling'][number] | undefined {
	if (!isPlain(raw)) return undefined;
	const {id, hash} = raw;
	return isId(id) && isHash(hash) ? {id, hash} : undefined;
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && CARD_ID.test(value);
}

function isHash(value: unknown): value is string {
	return typeof value === 'string' && OBJECT_ID.test(value);
}

/** Written aside and renamed, so a call racing this one never reads half a file. */
async function writeCache(
	cwd: string,
	stamp: CardStateStamp,
	state: CardState,
	gitDir: string | undefined,
): Promise<void> {
	const file = await stateFile(cwd, gitDir);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), {recursive: true});
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({version: CACHE_VERSION, ...stamp, state})}\n`,
		);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, {force: true});
		throw error;
	}
}
