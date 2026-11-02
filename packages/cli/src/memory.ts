import {
	MEMORY_REF,
	MemoryError,
	archiveMemory,
	assertGitRepo,
	inspectMemory,
	purgeMemory,
	readMemory,
	reindexMemory,
	searchMemory,
	syncMemory,
	type MemoryEntry,
	type MemoryHit,
	type SyncResult,
} from '@chamoji/core';
import {MISSING_KEY} from './env.js';
import type {MemoryReranker} from './rerank.js';
import type {Io} from './run.js';
import {stripControl} from './text.js';
import {cardLines} from './why.js';

/** Same code run.ts uses for a command that was used wrongly. */
const USAGE_ERROR = 2;

/**
 * What to do about an entry purged here that origin still holds. It's said
 * only after a merge, so the local ref has all that origin held when it was
 * fetched. A force-push still replaces origin's history, and the text says so.
 */
export const FORCE_STEP = `A purged entry is still on origin, so nothing was pushed. Origin's memory is merged into yours already. To remove the entry there, replace origin's memory with yours. This overwrites origin's history, and drops anything pushed there since this sync: git push --force origin ${MEMORY_REF}`;

/**
 * `chamoji memory`: `input` is what follows `memory`. Problems with memory
 * itself throw a MemoryError, which run.ts reports and exits 1 for; misuse of
 * the command exits 2. Only `sync` touches the network, and `search --ai` the
 * TypeSafe API through `reranker`, which gives undefined when there is no key;
 * the rest work on the local ref.
 */
export async function runMemory(
	input: string[],
	flags: {json?: boolean; purge?: boolean; ai?: boolean; archived?: boolean},
	io: Io,
	reranker: () => Promise<MemoryReranker | undefined> = async () => undefined,
): Promise<number> {
	const [command = 'list', ...args] = input;
	await assertGitRepo(io.cwd);
	switch (command) {
		case 'list': {
			return list(io, flags.json ?? false, flags.archived ?? false);
		}

		case 'show': {
			return args.length === 1
				? show(io, args[0]!, flags.json ?? false)
				: usage(io, 'memory show needs one slug: chamoji memory show <slug>');
		}

		case 'search': {
			return args.length > 0
				? search(
						io,
						args.join(' '),
						{json: flags.json ?? false, ai: flags.ai ?? false},
						reranker,
					)
				: usage(
						io,
						'memory search needs a query: chamoji memory search <query> [--ai]',
					);
		}

		case 'reindex': {
			return args.length === 0
				? reindex(io)
				: usage(
						io,
						'memory reindex takes no arguments: chamoji memory reindex',
					);
		}

		case 'archive': {
			return args.length === 1
				? archive(io, args[0]!, flags.purge ?? false)
				: usage(
						io,
						'memory archive needs one slug: chamoji memory archive <slug> [--purge]',
					);
		}

		case 'sync': {
			return args.length === 0
				? sync(io, flags.json ?? false)
				: usage(io, 'memory sync takes no arguments: chamoji memory sync');
		}

		default: {
			return usage(
				io,
				`memory needs list, show, search, reindex, archive or sync, not "${command}"`,
			);
		}
	}
}

function usage(io: Io, message: string): number {
	io.stderr(`chamoji: ${stripControl(message)}\n`);
	return USAGE_ERROR;
}

async function list(io: Io, json: boolean, archived: boolean): Promise<number> {
	const {entries, unreadable} = await inspectMemory(io.cwd, {archived});
	if (json) {
		io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
	} else if (entries.length === 0) {
		// An empty list that hides damaged entries must not read as an empty memory.
		const hidden = archived
			? 0
			: (await inspectMemory(io.cwd, {archived: true})).entries.length;
		if (hidden > 0) {
			io.stdout(
				`No live entries. ${entryCount(hidden)} archived: chamoji memory list --archived shows ${hidden === 1 ? 'it' : 'them'}.\n`,
			);
		} else if (unreadable.length === 0) {
			io.stdout(
				'Nothing in memory yet. Shipping or dropping a workstream saves it here.\n',
			);
		}
	} else {
		const slugWidth = Math.max(...entries.map(entry => entry.slug.length));
		const statuses = entries.map(entry =>
			entry.archived ? `${entry.status}, archived` : entry.status,
		);
		const statusWidth = Math.max(...statuses.map(status => status.length));
		const counts = entries.map(entry => commitCount(entry));
		const countWidth = Math.max(...counts.map(count => count.length));
		for (const [index, entry] of entries.entries()) {
			io.stdout(
				`${entry.slug.padEnd(slugWidth)}  ${(statuses[index] ?? '').padEnd(statusWidth)}  ${(counts[index] ?? '').padEnd(countWidth)}  ${label(entry)}\n`,
			);
		}
	}

	if (unreadable.length > 0) {
		io.stderr(
			`chamoji: memory has ${entryCount(unreadable.length)} that can't be read: ${unreadable.map(slug => stripControl(slug)).join(', ')}. chamoji memory show <slug> says what is wrong.\n`,
		);
	}

	return 0;
}

async function show(io: Io, slug: string, json: boolean): Promise<number> {
	const entry = await readMemory(io.cwd, slug);
	if (!entry) throw new MemoryError(`No memory for "${slug}"`);
	if (json) {
		io.stdout(`${JSON.stringify(entry, null, 2)}\n`);
		return 0;
	}

	const lines = [
		`${label(entry)} (${entry.slug})`,
		`${entry.archived ? 'archived, ' : ''}${entry.status}, updated ${day(entry.updatedAt)}, ${commitCount(entry)}`,
	];
	for (const {hash, subject, date, card} of entry.commits) {
		lines.push(
			'',
			`${hash.slice(0, 7)} ${stripControl(subject)}, ${day(date)}`,
			...cardLines(card).map(line => `  ${line}`),
		);
	}

	io.stdout(`${lines.join('\n')}\n`);
	return 0;
}

async function search(
	io: Io,
	query: string,
	{json, ai}: {json: boolean; ai: boolean},
	reranker: () => Promise<MemoryReranker | undefined>,
): Promise<number> {
	const rerank = ai ? await reranker() : undefined;
	if (ai && !rerank) return usage(io, MISSING_KEY);
	let hits = await searchMemory(io.cwd, query);
	if (rerank) hits = await rerank(query, hits);
	if (json) {
		io.stdout(`${JSON.stringify(hits, null, 2)}\n`);
	} else if (hits.length === 0) {
		io.stdout(`Nothing in memory matches "${stripControl(query)}".\n`);
	} else {
		io.stdout(hits.map(hit => hitLines(hit)).join(''));
	}

	return 0;
}

/** A hit and its card, safe to print: both come from commits and memory that others wrote. */
function hitLines({kind, id, title, card}: MemoryHit): string {
	const where = kind === 'commit' ? id.slice(0, 7) : `workstream ${id}`;
	const lines = [
		`${stripControl(where)} ${stripControl(title)}`,
		...cardLines(card).map(line => `  ${line}`),
	];
	return `${lines.join('\n')}\n`;
}

async function reindex(io: Io): Promise<number> {
	const {documents} = await reindexMemory(io.cwd);
	io.stdout(
		`Indexed ${documents} ${documents === 1 ? 'document' : 'documents'}.\n`,
	);
	return 0;
}

async function archive(io: Io, slug: string, purge: boolean): Promise<number> {
	if (purge) {
		await purgeMemory(io.cwd, slug);
		io.stdout(
			`Purged ${slug} from local memory. If it was ever synced, origin still has it. Run chamoji memory sync: it merges origin's memory into yours first, and says what to do if origin then needs replacing.\n`,
		);
	} else {
		await archiveMemory(io.cwd, slug);
		io.stdout(
			`Archived ${slug}. It stays in memory, out of the list; chamoji memory show ${slug} still finds it.\n`,
		);
	}

	return 0;
}

async function sync(io: Io, json: boolean): Promise<number> {
	const result = await syncMemory(io.cwd);
	const summary =
		syncSummary(result) ?? 'Nothing to sync: no memory here or on origin yet.';
	io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : `${summary}\n`);
	return 0;
}

/** One line on what a sync did, or undefined when there was no memory to sync. */
export function syncSummary({
	fetched,
	merged,
	pushed,
	needsForce,
	entries,
}: SyncResult): string | undefined {
	const count = entryCount(entries);
	if (needsForce) return `Merged memory here: ${count}. ${FORCE_STEP}`;
	if (pushed || merged) return `Synced memory with origin: ${count}.`;
	return fetched ? `Memory already matches origin: ${count}.` : undefined;
}

export function entryCount(entries: number): string {
	return `${entries} ${entries === 1 ? 'entry' : 'entries'}`;
}

function commitCount({commits}: MemoryEntry): string {
	return `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'}`;
}

/** Memory comes from other people's clones, so none of it reaches the terminal raw. */
function label({emoji, title}: MemoryEntry): string {
	return stripControl(`${emoji ? `${emoji} ` : ''}${title}`);
}

function day(date: string): string {
	return stripControl(date).replace(/T.*$/, ''); // A year can pass four digits.
}
