import {
	MEMORY_REF,
	MemoryError,
	archiveMemory,
	assertGitRepo,
	listMemory,
	purgeMemory,
	readMemory,
	type MemoryEntry,
} from '@chamoji/core';
import type {Io} from './run.js';
import {stripControl} from './text.js';
import {cardLines} from './why.js';

/** Same code run.ts uses for a command that was used wrongly. */
const USAGE_ERROR = 2;

/**
 * `chamoji memory`: `input` is what follows `memory`. Problems with memory
 * itself throw a MemoryError, which run.ts reports and exits 1 for; misuse of
 * the command exits 2. It works on the local ref and never touches the network.
 */
export async function runMemory(
	input: string[],
	flags: {json?: boolean; purge?: boolean},
	io: Io,
): Promise<number> {
	const [command = 'list', ...args] = input;
	await assertGitRepo(io.cwd);
	switch (command) {
		case 'list': {
			return list(io, flags.json ?? false);
		}

		case 'show': {
			return args.length === 1
				? show(io, args[0]!, flags.json ?? false)
				: usage(io, 'memory show needs one slug: chamoji memory show <slug>');
		}

		case 'archive': {
			return args.length === 1
				? archive(io, args[0]!, flags.purge ?? false)
				: usage(
						io,
						'memory archive needs one slug: chamoji memory archive <slug> [--purge]',
					);
		}

		default: {
			return usage(io, `memory needs list, show or archive, not "${command}"`);
		}
	}
}

function usage(io: Io, message: string): number {
	io.stderr(`chamoji: ${stripControl(message)}\n`);
	return USAGE_ERROR;
}

async function list(io: Io, json: boolean): Promise<number> {
	const entries = await listMemory(io.cwd);
	if (json) {
		io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
	} else if (entries.length === 0) {
		io.stdout(
			'Nothing in memory yet. Shipping or dropping a workstream saves it here.\n',
		);
	} else {
		const slugWidth = Math.max(...entries.map(entry => entry.slug.length));
		const statusWidth = Math.max(...entries.map(entry => entry.status.length));
		const counts = entries.map(entry => commitCount(entry));
		const countWidth = Math.max(...counts.map(count => count.length));
		for (const [index, entry] of entries.entries()) {
			io.stdout(
				`${entry.slug.padEnd(slugWidth)}  ${entry.status.padEnd(statusWidth)}  ${(counts[index] ?? '').padEnd(countWidth)}  ${label(entry)}\n`,
			);
		}
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

async function archive(io: Io, slug: string, purge: boolean): Promise<number> {
	if (purge) {
		await purgeMemory(io.cwd, slug);
		io.stdout(
			`Purged ${slug} from local memory. If it was ever synced, the remote still has it; remove it there with: git push --force origin ${MEMORY_REF}\n`,
		);
	} else {
		await archiveMemory(io.cwd, slug);
		io.stdout(
			`Archived ${slug}. It stays in memory, out of the list; chamoji memory show ${slug} still finds it.\n`,
		);
	}

	return 0;
}

function commitCount({commits}: MemoryEntry): string {
	return `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'}`;
}

/** Memory comes from other people's clones, so none of it reaches the terminal raw. */
function label({emoji, title}: MemoryEntry): string {
	return stripControl(`${emoji ? `${emoji} ` : ''}${title}`);
}

function day(date: string): string {
	return stripControl(date).slice(0, 10);
}
