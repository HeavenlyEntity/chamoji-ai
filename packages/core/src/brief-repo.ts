import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {renderBrief, type BriefInput, type BriefSection} from './brief.js';
import {isResolveCommit} from './card-resolve.js';
import {
	cardStateAt,
	cardStatePath,
	cardStateStamp,
	type CardStateStamp,
} from './card-state-repo.js';
import type {CardState} from './card-state.js';
import {listTags, readCommits, runGit} from './git.js';
import {parseCommit} from './parse.js';
import {stripControlLines} from './text.js';
import {WORKSTREAMS_FILE, readWorkstreams} from './workstreams.js';

/** Bump it when the file's layout or what goes into it changes. */
const CACHE_VERSION = 1;

const DAY = 24 * 60 * 60 * 1000;
/** How far back "resolved recently" reaches when there are fewer than two tags. */
const RECENT_DAYS = 30;
const RECENT_SUBJECTS = 5;

/**
 * What the default brief was rendered from: the card state's stamp, the
 * workstreams file, which can change with no commit, and the tags, which can
 * be added with HEAD where it was.
 */
type BriefStamp = CardStateStamp & {workstreams: string; tags: string};

export type Brief = {head: string; text: string; state: CardState};

/**
 * The brief at HEAD, as `renderBrief` prints it, with the state it was
 * rendered from. The default one, with no options, is kept in the git
 * directory under a stamp of everything it was read from, so a hook that runs
 * at the start of every session pays for it once per change. Empty text for a
 * repo with no commits. It throws when git fails, as `readCardState` does.
 */
export async function readBrief(
	cwd: string,
	options: {budget?: number; section?: BriefSection} = {},
): Promise<Brief> {
	const cardStamp = await cardStateStamp(cwd);
	const empty = {head: '', lines: [], dangling: []};
	if (cardStamp.head === '') return {head: '', text: '', state: empty};
	const cached = options.budget === undefined && options.section === undefined;
	// Read before the content is, as the card state's stamp is.
	const stamp: BriefStamp | undefined = cached
		? {
				...cardStamp,
				workstreams: await workstreamsStamp(cwd),
				tags: await tagsStamp(cwd),
			}
		: undefined;
	const state = await cardStateAt(cwd, cardStamp);
	const stored = stamp && (await readCache(cwd, stamp));
	if (stored !== undefined) return {head: cardStamp.head, text: stored, state};
	const text = renderBrief(await readBriefInput(cwd, state), options);
	if (stamp) await writeCache(cwd, stamp, text).catch(() => undefined);
	return {head: cardStamp.head, text, state};
}

/**
 * Everything `renderBrief` needs besides the state, read from `state.head`
 * rather than HEAD, so a HEAD that moves meanwhile can't mix two histories.
 */
export async function readBriefInput(
	cwd: string,
	state: CardState,
): Promise<BriefInput> {
	const {head} = state;
	const tags = await listTags(cwd, head);
	const [newest, second] = tags;
	const resolvedSince =
		second === undefined
			? daysBefore(await authorDate(cwd, head), RECENT_DAYS)
			: daysBefore(await authorDate(cwd, tagRef(second.name)), 0);

	const recentCommits = (
		await readCommits(
			cwd,
			newest === undefined ? head : `${tagRef(newest.name)}..${head}`,
		)
	)
		.map(raw => parseCommit(raw))
		.filter(commit => !isResolveCommit(commit));

	return {
		head,
		state,
		resolvedSince,
		workstreams: await readActive(cwd, head),
		recent: {
			tag: newest?.name ?? null,
			count: recentCommits.length,
			subjects: recentCommits
				.slice(0, RECENT_SUBJECTS)
				.map(commit => commit.subject),
		},
	};
}

/** A tag by its full ref, so no branch or file of the same name is read instead. */
function tagRef(name: string): string {
	return `refs/tags/${name}^{commit}`;
}

/**
 * `days` before an ISO date, in UTC so the same commit gives the same text
 * on any machine. A date JavaScript can't read, such as one past year 9999,
 * is passed on as it is, and the brief then counts every resolve as recent.
 */
function daysBefore(date: string, days: number): string {
	const at = Date.parse(date);
	return Number.isNaN(at) ? date : new Date(at - days * DAY).toISOString();
}

async function authorDate(cwd: string, rev: string): Promise<string> {
	return (
		await runGit(
			['show', '-s', '--no-show-signature', '--format=%aI', rev, '--'],
			cwd,
		)
	).trim();
}

/**
 * The active workstreams, each with how many commits on HEAD name it and the
 * newest one's description. A workstreams file that can't be read leaves the
 * brief without them rather than without everything.
 */
async function readActive(
	cwd: string,
	head: string,
): Promise<BriefInput['workstreams']> {
	let active: Awaited<ReturnType<typeof readWorkstreams>>;
	try {
		active = (await readWorkstreams(cwd)).filter(ws => ws.status === 'active');
	} catch {
		return [];
	}

	if (active.length === 0) return [];
	const commits = (await readCommits(cwd, head)).map(raw => parseCommit(raw));
	return active.map(({slug, title}) => {
		const named = commits.filter(commit => commit.workstream === slug);
		return {
			slug,
			title,
			commits: named.length,
			...(named[0] === undefined ? {} : {latest: named[0].description}),
		};
	});
}

/**
 * The sha256 of the workstreams file, or '' when there is none. Only a
 * regular file is read, so a pipe planted there can't hang the hook; anything
 * else reads as no workstreams anyway.
 */
async function workstreamsStamp(cwd: string): Promise<string> {
	try {
		const root = (await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();
		const file = path.join(root, WORKSTREAMS_FILE);
		if (!(await lstat(file)).isFile()) return '';
		return sha256(await readFile(file));
	} catch {
		return '';
	}
}

/** The sha256 of every tag and what it points at, or '' when there are none. */
async function tagsStamp(cwd: string): Promise<string> {
	const listed = await runGit(
		['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags'],
		cwd,
	);
	return listed === '' ? '' : sha256(listed);
}

function sha256(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

/** Beside the card state, in this worktree's git directory. */
async function briefPath(cwd: string): Promise<string> {
	return path.join(path.dirname(await cardStatePath(cwd)), 'brief.json');
}

const STAMP_FIELDS = [
	'head',
	'memory',
	'notes',
	'shallow',
	'workstreams',
	'tags',
] as const;

/**
 * The stored text when every field of its stamp matches; anything else means
 * a rebuild. The file is local but can be edited, so a text holding a
 * character `renderBrief` never writes is not used either.
 */
async function readCache(
	cwd: string,
	stamp: BriefStamp,
): Promise<string | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(await briefPath(cwd), 'utf8'));
	} catch {
		return undefined;
	}

	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}

	const cache = raw as Record<string, unknown>;
	if (
		cache['version'] !== CACHE_VERSION ||
		!STAMP_FIELDS.every(field => cache[field] === stamp[field]) ||
		typeof cache['text'] !== 'string' ||
		stripControlLines(cache['text']) !== cache['text']
	) {
		return undefined;
	}

	return cache['text'];
}

/** Written aside and renamed, so a call racing this one never reads half a file. */
async function writeCache(
	cwd: string,
	stamp: BriefStamp,
	text: string,
): Promise<void> {
	const file = await briefPath(cwd);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), {recursive: true});
	try {
		const {head, memory, notes, shallow, workstreams, tags} = stamp;
		await writeFile(
			temporary,
			`${JSON.stringify({version: CACHE_VERSION, head, memory, notes, shallow, workstreams, tags, text})}\n`,
		);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, {force: true});
		throw error;
	}
}
