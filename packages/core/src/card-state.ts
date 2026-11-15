import {linesOf, type CardKind} from './card-lines.js';
import type {MemoryCommit} from './memory.js';
import type {Resolve} from './resolves.js';
import type {IntentCard} from './types.js';
import type {WorkstreamStatus} from './workstreams.js';

export type LineState = 'open' | 'resolved' | 'in-doubt' | 'off-branch';

export type CardLine = {
	id: string;
	kind: CardKind;
	text: string;
	state: LineState;
	/** Full hashes, newest first. For an off-branch line, the remembered commits. */
	sources: string[];
	/** The newest source's ISO date. */
	date: string;
	/** Paths the sources added lines to. The fold leaves it empty; `readCardState` fills it. */
	files: string[];
	resolvedBy?: {hash: string; date: string; reason: string};
	/** In doubt only; `readCardState` fills it. */
	replacedBy?: string;
	/** The id of the line this one replaced. */
	replaces?: string;
	/** Off branch only. */
	workstream?: {slug: string; status: WorkstreamStatus};
};

export type CardState = {
	head: string;
	lines: CardLine[];
	/** A Resolves: whose id matches no line. */
	dangling: Array<{id: string; hash: string}>;
};

export type FoldCommit = {
	hash: string;
	date: string;
	subject: string;
	card?: IntentCard;
	resolves: Resolve[];
};

export type FoldInput = {
	head: string;
	/** On HEAD, newest first, no merges. Cards already hold their note lines. */
	commits: FoldCommit[];
	/** A revert commit's hash to the hashes it undoes. */
	voids: Map<string, string[]>;
	isAncestor(ancestor: string, descendant: string): boolean;
	/** By source hash: true, false, or undefined for a commit that added no lines. */
	survives: Map<string, boolean | undefined>;
	/** Commits kept in workstream memory that are not on HEAD. */
	remembered: Array<{
		slug: string;
		status: WorkstreamStatus;
		commit: MemoryCommit;
	}>;
};

type Remembered = FoldInput['remembered'][number];

/**
 * Works out each constraint, gotcha and follow-up line's state from the
 * commits that state and resolve it. Only a `Resolves:` in a commit ever
 * makes a line resolved; blame can at most put it in doubt, so a gap in what
 * we know leaves a line open or in doubt, never resolved. It reads no git.
 */
export function foldCardState(input: FoldInput): CardState {
	const live = liveCommits(input.commits, input.voids);
	const lines = [...headLines(live, input), ...offBranchLines(live, input)];

	const known = new Set(lines.map(l => l.id));
	const dangling = live.flatMap(c =>
		c.resolves
			.filter(resolve => !known.has(resolve.id))
			.map(resolve => ({id: resolve.id, hash: c.hash})),
	);

	lines.sort((a, b) => newerFirst(a.date, b.date) || compare(a.id, b.id));
	return {head: input.head, lines, dangling};
}

/**
 * The commits a revert has not undone. Reverts are taken newest first, so a
 * revert that was itself reverted is already void and undoes nothing.
 */
function liveCommits(
	commits: FoldCommit[],
	voids: Map<string, string[]>,
): FoldCommit[] {
	const voided = new Set<string>();
	for (const c of commits) {
		if (voided.has(c.hash)) continue;
		for (const target of voids.get(c.hash) ?? []) voided.add(target);
	}

	return commits.filter(c => !voided.has(c.hash));
}

/** Every line a live commit on HEAD states, with its state there. */
function headLines(live: FoldCommit[], input: FoldInput): CardLine[] {
	const sourcesById = new Map<string, FoldCommit[]>();
	for (const c of live) {
		for (const {id} of linesOf(c.card)) {
			const sources = sourcesById.get(id) ?? [];
			sources.push(c);
			sourcesById.set(id, sources);
		}
	}

	return [...sourcesById].map(([id, sources]) => {
		const newest = sources[0]!;
		const {kind, text} = linesOf(newest.card).find(l => l.id === id)!;
		const line: CardLine = {
			id,
			kind,
			text,
			state: 'open',
			sources: sources.map(s => s.hash),
			date: newest.date,
			files: [],
		};

		const replaces = replacedId(id, sources);
		if (replaces) line.replaces = replaces;

		const {covered, covering} = coverage(id, sources, live, input.isAncestor);
		const uncovered = sources.filter(s => !covered.has(s.hash));
		if (uncovered.length === 0) {
			line.state = 'resolved';
			line.resolvedBy = resolvedBy(id, live, c => covering.has(c.hash));
		} else if (uncovered.every(s => input.survives.get(s.hash) === false)) {
			line.state = 'in-doubt';
		}

		return line;
	});
}

/**
 * Which sources a later resolve covers, and which resolving commits cover
 * any. A commit never covers itself: stating a line and resolving it in one
 * commit leaves it open.
 */
function coverage(
	id: string,
	sources: FoldCommit[],
	live: FoldCommit[],
	isAncestor: FoldInput['isAncestor'],
): {covered: Set<string>; covering: Set<string>} {
	const covered = new Set<string>();
	const covering = new Set<string>();
	for (const c of live) {
		if (!c.resolves.some(r => r.id === id)) continue;
		for (const source of sources) {
			if (source.hash !== c.hash && isAncestor(source.hash, c.hash)) {
				covered.add(source.hash);
				covering.add(c.hash);
			}
		}
	}

	return {covered, covering};
}

/**
 * The newest qualifying commit that resolves the id, with its reason or, when
 * it gave none, its subject.
 */
function resolvedBy(
	id: string,
	live: FoldCommit[],
	qualifies: (c: FoldCommit) => boolean,
): CardLine['resolvedBy'] {
	for (const c of live) {
		const resolve = c.resolves.find(r => r.id === id);
		if (resolve && qualifies(c)) {
			return {hash: c.hash, date: c.date, reason: resolve.reason ?? c.subject};
		}
	}

	return undefined;
}

/**
 * The line a source of this one resolved while stating it: the first resolve,
 * in the commit's own order, of another id of the same kind. Ids of one kind
 * share their first letter.
 */
function replacedId(id: string, sources: FoldCommit[]): string | undefined {
	for (const source of sources) {
		const replaced = source.resolves.find(
			r => r.id !== id && r.id[0] === id[0],
		);
		if (replaced) return replaced.id;
	}

	return undefined;
}

/**
 * Lines that only workstream memory holds, from commits not on HEAD. A resolve
 * covers only what was said before it, so a commit on HEAD settles one only
 * when it is dated on or after the newest remembered commit stating it. Dates
 * stand in for ancestry because a remembered commit may not be in the object
 * store; a date that can't be read leaves the line off branch. The rest are
 * off branch, under the workstream of their newest remembered commit.
 */
function offBranchLines(live: FoldCommit[], input: FoldInput): CardLine[] {
	const onHead = new Set(input.commits.map(c => c.hash));
	const stated = new Set(live.flatMap(c => linesOf(c.card).map(l => l.id)));

	const rememberedById = new Map<string, Remembered[]>();
	for (const entry of input.remembered) {
		if (onHead.has(entry.commit.hash)) continue;
		for (const {id} of linesOf(entry.commit.card)) {
			if (stated.has(id)) continue;
			const entries = rememberedById.get(id) ?? [];
			if (!entries.some(e => e.commit.hash === entry.commit.hash)) {
				entries.push(entry);
			}

			rememberedById.set(id, entries);
		}
	}

	return [...rememberedById].map(([id, entries]) => {
		entries.sort((a, b) => newerFirst(a.commit.date, b.commit.date));
		const newest = entries[0]!;
		const {kind, text} = linesOf(newest.commit.card).find(l => l.id === id)!;
		const line: CardLine = {
			id,
			kind,
			text,
			state: 'off-branch',
			sources: entries.map(e => e.commit.hash),
			date: newest.commit.date,
			files: [],
		};

		// A date Date.parse refuses is NaN, and NaN compares false either way.
		const statedAt = Date.parse(newest.commit.date);
		const settled = resolvedBy(id, live, c => Date.parse(c.date) >= statedAt);
		if (settled) {
			line.state = 'resolved';
			line.resolvedBy = settled;
		} else {
			line.workstream = {slug: newest.slug, status: newest.status};
		}

		return line;
	});
}

/** What a reply carries: id, kind, text, state, resolvedBy, replacedBy, replaces, workstream. */
export type PublicLine = Omit<CardLine, 'sources' | 'date' | 'files'>;

/** The state of each line in a card, looked up by id. A line the state doesn't know is left out. */
export function linesFor(
	state: CardState,
	card: IntentCard | undefined,
): CardLine[] {
	const byId = new Map(state.lines.map(line => [line.id, line]));
	return linesOf(card).flatMap(({id}) => byId.get(id) ?? []);
}

/**
 * A line as a reply shows it. Sources, date and files are for working the
 * state out, and a reply has no keys whose value is undefined.
 */
export function publicLine(line: CardLine): PublicLine {
	const {id, kind, text, state, resolvedBy, replacedBy, replaces, workstream} =
		line;
	return {
		id,
		kind,
		text,
		state,
		...(resolvedBy === undefined ? {} : {resolvedBy}),
		...(replacedBy === undefined ? {} : {replacedBy}),
		...(replaces === undefined ? {} : {replaces}),
		...(workstream === undefined ? {} : {workstream}),
	};
}

/**
 * Orders ISO dates newest first. Git allows stamps `Date.parse` refuses, so
 * those fall back to comparing the text.
 */
function newerFirst(a: string, b: string): number {
	const [timeA, timeB] = [Date.parse(a), Date.parse(b)];
	if (Number.isNaN(timeA) || Number.isNaN(timeB)) return compare(b, a);
	return timeB - timeA;
}

function compare(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
