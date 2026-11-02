import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	buildIndex,
	indexFromJson,
	indexToJson,
	queryIndex,
	type Bm25Index,
	type SearchDocument,
} from './bm25.js';
import {readCommits, runGit} from './git.js';
import {MEMORY_REF, headOf, listMemory, toCard} from './memory.js';
import {parseCommit} from './parse.js';
import type {IntentCard} from './types.js';

/** A commit or a workstream summary that matched a search. */
export type MemoryHit = {
	kind: 'commit' | 'workstream';
	/** A commit's hash, or a workstream's slug. */
	id: string;
	/** A commit's subject, or a workstream's title. */
	title: string;
	card?: IntentCard;
	score: number;
};

/** Bump it when the file's layout or what goes into it changes. */
const INDEX_VERSION = 1;

const DEFAULT_LIMIT = 10;

/** How much each part of a commit counts toward a match. */
const WEIGHT = {card: 3, subject: 2, body: 1};

/** What a hit is made from. The index file keeps it so a search reads no git objects. */
type StoredDocument = {
	kind: MemoryHit['kind'];
	id: string;
	title: string;
	card?: IntentCard;
};

type Loaded = {documents: StoredDocument[]; index: Bm25Index};

/** What an index was built from; when either differs it is out of date. */
type Stamp = {head: string; memory: string};

/**
 * Rebuilds the index from every commit on HEAD and every live memory entry.
 * Unlike a search, it reports a file it can't write.
 */
export async function reindexMemory(cwd: string): Promise<{documents: number}> {
	const loaded = await build(cwd, await currentStamp(cwd));
	await writeIndex(cwd, loaded.stamp, loaded);
	return {documents: loaded.documents.length};
}

/**
 * The best matches for `query` in the commits on HEAD and the live memory
 * entries, by BM25 over their card, subject and body. The index lives in the
 * git directory and is rebuilt when HEAD or the memory ref has moved, or when
 * the file can't be trusted; a search still works where it can't be saved.
 */
export async function searchMemory(
	cwd: string,
	query: string,
	options: {limit?: number} = {},
): Promise<MemoryHit[]> {
	const stamp = await currentStamp(cwd);
	let loaded = await readIndex(cwd, stamp);
	if (!loaded) {
		loaded = await build(cwd, stamp);
		await writeIndex(cwd, stamp, loaded).catch(() => undefined);
	}

	const byId = new Map(
		loaded.documents.map(document => [key(document), document]),
	);
	const hits: MemoryHit[] = [];
	for (const {id, score} of queryIndex(
		loaded.index,
		query,
		options.limit ?? DEFAULT_LIMIT,
	)) {
		const document = byId.get(id)!;
		hits.push({
			kind: document.kind,
			id: document.id,
			title: document.title,
			...(document.card === undefined ? {} : {card: document.card}),
			score,
		});
	}

	return hits;
}

const key = ({kind, id}: StoredDocument) => `${kind}:${id}`;

/** Read before the content is, so a move in between only costs the next search a rebuild. */
async function currentStamp(cwd: string): Promise<Stamp> {
	return {
		head: (await headOf(cwd, 'HEAD')) ?? '',
		memory: (await headOf(cwd, MEMORY_REF)) ?? '',
	};
}

async function build(
	cwd: string,
	stamp: Stamp,
): Promise<Loaded & {stamp: Stamp}> {
	const documents: StoredDocument[] = [];
	const searchable: SearchDocument[] = [];
	if (stamp.head !== '') {
		for (const raw of await readCommits(cwd, stamp.head)) {
			const {hash, subject, body, card} = parseCommit(raw);
			const stored: StoredDocument = {
				kind: 'commit',
				id: hash,
				title: subject,
				...(card === undefined ? {} : {card}),
			};
			documents.push(stored);
			searchable.push({
				id: key(stored),
				fields: [
					{text: cardText(card ? [card] : []), weight: WEIGHT.card},
					{text: subject, weight: WEIGHT.subject},
					{text: body, weight: WEIGHT.body},
				],
			});
		}
	}

	for (const entry of await listMemory(cwd)) {
		const cards = entry.commits.flatMap(commit =>
			commit.card ? [commit.card] : [],
		);
		const card = joinCards(cards);
		const stored: StoredDocument = {
			kind: 'workstream',
			id: entry.slug,
			title: entry.title,
			...(card === undefined ? {} : {card}),
		};
		documents.push(stored);
		searchable.push({
			id: key(stored),
			fields: [
				{text: cardText(cards), weight: WEIGHT.card},
				{text: entry.title, weight: WEIGHT.subject},
				{
					text: entry.commits.map(commit => commit.subject).join('\n'),
					weight: WEIGHT.body,
				},
			],
		});
	}

	return {documents, index: buildIndex(searchable), stamp};
}

function cardText(cards: IntentCard[]): string {
	return cards
		.flatMap(card => [
			...card.why,
			...card.constraint,
			...card.gotcha,
			...card.followUp,
		])
		.join('\n');
}

/** One card from several, repeats dropped, or undefined when none says anything. */
function joinCards(cards: IntentCard[]): IntentCard | undefined {
	const joined: IntentCard = {
		why: [],
		constraint: [],
		gotcha: [],
		followUp: [],
	};
	for (const card of cards) {
		for (const field of Object.keys(joined) as Array<keyof IntentCard>) {
			for (const value of card[field]) {
				if (!joined[field].includes(value)) joined[field].push(value);
			}
		}
	}

	return Object.values(joined).some(values => values.length > 0)
		? joined
		: undefined;
}

async function indexPath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return path.join(gitDir, 'chamoji', 'memory-index.json');
}

/**
 * The stored index when it was built from this HEAD and memory ref. The file
 * is local but can be cut short or edited, so anything that does not check
 * out is treated as absent.
 */
async function readIndex(
	cwd: string,
	stamp: Stamp,
): Promise<Loaded | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(await indexPath(cwd), 'utf8'));
	} catch {
		return undefined;
	}

	if (typeof raw !== 'object' || raw === null) return undefined;
	const {version, head, memory, documents, index} = raw as Record<
		string,
		unknown
	>;
	if (
		version !== INDEX_VERSION ||
		head !== stamp.head ||
		memory !== stamp.memory ||
		!Array.isArray(documents)
	) {
		return undefined;
	}

	const parsed = indexFromJson(index);
	if (!parsed || parsed.ids.length !== documents.length) return undefined;
	const stored: StoredDocument[] = [];
	for (const [position, item] of (documents as unknown[]).entries()) {
		const document = toDocument(item);
		if (!document || key(document) !== parsed.ids[position]) return undefined;
		stored.push(document);
	}

	return {documents: stored, index: parsed};
}

function toDocument(raw: unknown): StoredDocument | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}

	const {kind, id, title, card} = raw as Record<string, unknown>;
	if (kind !== 'commit' && kind !== 'workstream') return undefined;
	if (typeof id !== 'string' || typeof title !== 'string') return undefined;
	if (card === undefined) return {kind, id, title};
	const parsed = toCard(card);
	return parsed && {kind, id, title, card: parsed};
}

/** Written aside and renamed, so a search racing this one never reads half a file. */
async function writeIndex(
	cwd: string,
	stamp: Stamp,
	{documents, index}: Loaded,
): Promise<void> {
	const file = await indexPath(cwd);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), {recursive: true});
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({version: INDEX_VERSION, ...stamp, documents, index: indexToJson(index)})}\n`,
		);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, {force: true});
		throw error;
	}
}
