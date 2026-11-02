import {
	MEMORY_FETCH_REFSPEC,
	MemoryError,
	assertGitRepo,
	fetchesMemory,
	hasOrigin,
	pullMemory,
	runGit,
} from '@chamoji/core';
import {entryCount, FORCE_STEP} from './memory.js';
import type {Io} from './run.js';
import {stripControlLines} from './text.js';

/**
 * `chamoji init`: sets this clone up to share memory, and takes in what origin
 * has so a fresh clone needs nothing else. It adds a fetch refspec and leaves
 * `remote.origin.push` unset, because setting that makes a plain `git push`
 * push only memory and leave the branch behind. It pushes nothing.
 */
export async function runInit(
	_flags: {agents?: boolean},
	io: Io,
): Promise<number> {
	await assertGitRepo(io.cwd);
	if (!(await hasOrigin(io.cwd))) {
		io.stdout(
			'No remote named origin, so there is nothing to share memory with. Add one and run chamoji init again.\n',
		);
		return 0;
	}

	io.stdout(
		(await addFetchRefspec(io.cwd))
			? 'origin now fetches chamoji memory.\n'
			: 'origin already fetches chamoji memory.\n',
	);
	// The setup is done and sound; the next sync can do the rest.
	try {
		const {fetched, entries, needsForce} = await pullMemory(io.cwd);
		io.stdout(
			fetched
				? `Took in memory from origin: ${entryCount(entries)}.\n`
				: 'No memory on origin yet.\n',
		);
		if (needsForce) io.stdout(`${FORCE_STEP}\n`);
	} catch (error) {
		if (!(error instanceof MemoryError)) throw error;
		io.stderr(`chamoji: ${stripControlLines(error.message)}\n`);
	}

	return 0;
}

/** Adds the refspec unless it's there. Says whether it was added. */
async function addFetchRefspec(cwd: string): Promise<boolean> {
	if (await fetchesMemory(cwd)) return false;
	await runGit(
		['config', '--add', 'remote.origin.fetch', MEMORY_FETCH_REFSPEC],
		cwd,
	);
	return true;
}
