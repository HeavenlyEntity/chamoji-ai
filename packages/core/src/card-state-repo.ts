import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CARD_ID} from './card-lines.js';
import {
	foldCardState,
	type CardLine,
	type CardState,
	type FoldCommit,
	type FoldInput,
	type LineState,
} from './card-state.js';
import {readCommitFiles, readCommits, runGit} from './git.js';
import {readSurvival, type Survival} from './line-survival.js';
import {MEMORY_REF, headOf, listMemory} from './memory.js';
import {parseCommit} from './parse.js';
import {readResolves, readRevertedHash} from './resolves.js';
import {NOTES_REF, mergeCards, readNoteCards} from './why-notes.js';
import {STATUSES, isSlug, type WorkstreamStatus} from './workstreams.js';

/** Bump it when the file's layout or what goes into it changes. */
const CACHE_VERSION = 1;

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

const KINDS: Array<CardLine['kind']> = ['constraint', 'gotcha', 'followUp'];

const STATES: LineState[] = ['open', 'resolved', 'in-doubt', 'off-branch'];

/** What a state was worked out from; when any of it differs the state is stale. */
type Stamp = {head: string; memory: string; notes: string};

/** Where this worktree keeps the state of its card lines; the git directory is per worktree. */
export async function cardStatePath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return path.join(gitDir, 'chamoji', 'card-state.json');
}

/**
 * The state of every card line, from the commits on HEAD, the notes on them
 * and workstream memory. It is kept in the git directory under the same
 * stamp as the search index, so it is worked out again whenever HEAD, the
 * memory ref or the notes ref moves, and every reader gets the same answer
 * without paying for blame twice. A cache that can't be saved costs only
 * the next call a rebuild.
 */
export async function readCardState(cwd: string): Promise<CardState> {
	const stamp = await currentStamp(cwd);
	if (stamp.head === '') return {head: '', lines: [], dangling: []};
	const cached = await readCache(cwd, stamp);
	if (cached) return cached;
	const state = await build(cwd, stamp.head);
	await writeCache(cwd, stamp, state).catch(() => undefined);
	return state;
}

/** Read before the content is, so a move in between only costs the next call a rebuild. */
async function currentStamp(cwd: string): Promise<Stamp> {
	return {
		head: (await headOf(cwd, 'HEAD')) ?? '',
		memory: (await headOf(cwd, MEMORY_REF)) ?? '',
		notes: (await headOf(cwd, NOTES_REF)) ?? '',
	};
}

/**
 * Works from `head`, the hash the stamp holds, so a HEAD that moves meanwhile
 * can't mix two histories into one stored state. Folds once without blame, then blames only the sources of lines that came
 * out open, because blame can only move an open line to in doubt. A resolved
 * or off-branch line is never blamed, and a repo with no open line blames
 * nothing.
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
		voids: await readVoids(cwd, commits, reverted, merges),
		isAncestor: ancestry(parents),
		survives: new Map(),
		remembered: await readRemembered(cwd, parents),
	};

	const first = foldCardState(input);
	const open = first.lines.filter(line => line.state === 'open');
	if (open.length === 0) return first;
	const survival = await readSurvival(
		cwd,
		open.flatMap(line => line.sources),
	);
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

	await fillReplacedBy(cwd, head, state.lines);
	return state;
}

/**
 * The non-merge commits on HEAD, newest first, and the commit each revert
 * among them names. A note's lines join the commit's own, as the search index
 * has them; a `Resolves:` is read from the commit alone, because anyone can
 * add a note and only a commit settles a line.
 */
async function readFoldCommits(
	cwd: string,
	head: string,
): Promise<{commits: FoldCommit[]; reverted: Map<string, string>}> {
	const added = await readNoteCards(cwd);
	const commits: FoldCommit[] = [];
	const reverted = new Map<string, string>();
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
		if (target !== undefined) reverted.set(parsed.hash, target);
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
 * commit; reverting a merge on HEAD undoes what the merge brought in. A
 * revert of anything else, such as a commit on another branch, undoes nothing
 * here.
 */
async function readVoids(
	cwd: string,
	commits: FoldCommit[],
	reverted: Map<string, string>,
	merges: Set<string>,
): Promise<Map<string, string[]>> {
	const onHead = new Set(commits.map(c => c.hash));
	const voids = new Map<string, string[]>();
	for (const [revert, target] of reverted) {
		if (onHead.has(target)) {
			voids.set(revert, [target]);
		} else if (merges.has(target)) {
			voids.set(revert, await broughtIn(cwd, target));
		}
	}

	return voids;
}

/** The non-merge commits a merge brought in from the side it merged. */
async function broughtIn(cwd: string, merge: string): Promise<string[]> {
	const stdout = await runGit(
		['rev-list', '--no-merges', `${merge}^1..${merge}`],
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

/** The paths the checked sources added lines to, each once. */
function filesOf(sources: string[], survival: Map<string, Survival>): string[] {
	return [...new Set(sources.flatMap(hash => survival.get(hash)?.files ?? []))];
}

/**
 * For each line in doubt, the newest commit on HEAD, other than its own
 * sources, that changed one of its files: the likeliest place it went.
 */
async function fillReplacedBy(
	cwd: string,
	head: string,
	lines: CardLine[],
): Promise<void> {
	const inDoubt = lines.filter(line => line.state === 'in-doubt');
	if (inDoubt.length === 0) return;
	const changed = await readCommitFiles(cwd, head);
	for (const line of inDoubt) {
		for (const [hash, files] of changed) {
			if (
				!line.sources.includes(hash) &&
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
	stamp: Stamp,
): Promise<CardState | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(await cardStatePath(cwd), 'utf8'));
	} catch {
		return undefined;
	}

	if (!isPlain(raw)) return undefined;
	const {version, head, memory, notes, state} = raw;
	if (
		version !== CACHE_VERSION ||
		head !== stamp.head ||
		memory !== stamp.memory ||
		notes !== stamp.notes ||
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
	const {resolvedBy, replacedBy, replaces, workstream} = raw;
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
	stamp: Stamp,
	state: CardState,
): Promise<void> {
	const file = await cardStatePath(cwd);
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
