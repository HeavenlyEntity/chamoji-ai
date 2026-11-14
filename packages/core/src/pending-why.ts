import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from './git.js';
import {headOf} from './memory.js';

/** A reason the user gave their agent, kept until the next commit. */
export type PendingWhy = {
	why: string;
	/** Where it came from, reading naturally after "from". */
	source: string;
	/** The commit that was HEAD when it was kept. */
	head: string;
	/** An ISO time. */
	at: string;
};

/** What the composer offers to fill in the Why. */
export type WhyDraft = {text: string; source: string};

/** A reason older than this is no longer offered. */
export const PENDING_WHY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Per worktree, in its git directory. */
async function pendingWhyPath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return path.join(gitDir, 'chamoji', 'pending-why.json');
}

/** Keeps `input` for the current HEAD. Written aside and renamed, so a reader never sees half a file. */
export async function writePendingWhy(
	cwd: string,
	input: {why: string; source: string},
	now = new Date(),
): Promise<void> {
	const file = await pendingWhyPath(cwd);
	const pending: PendingWhy = {
		why: input.why,
		source: input.source,
		head: (await headOf(cwd, 'HEAD')) ?? '',
		at: now.toISOString(),
	};
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), {recursive: true});
	try {
		await writeFile(temporary, `${JSON.stringify(pending)}\n`);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, {force: true});
		throw error;
	}
}

/**
 * The kept reason, or undefined when there is none, the file is damaged, it
 * is older than a day, or HEAD has moved since.
 */
export async function readPendingWhy(
	cwd: string,
	now = new Date(),
): Promise<PendingWhy | undefined> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(await pendingWhyPath(cwd), 'utf8'),
		);
		if (typeof parsed !== 'object' || parsed === null) return undefined;
		const {why, source, head, at} = parsed as Record<string, unknown>;
		if (
			typeof why !== 'string' ||
			why === '' ||
			typeof source !== 'string' ||
			typeof head !== 'string' ||
			typeof at !== 'string'
		) {
			return undefined;
		}

		const age = now.getTime() - new Date(at).getTime();
		if (!Number.isFinite(age) || age > PENDING_WHY_MAX_AGE_MS) return undefined;
		if (head !== ((await headOf(cwd, 'HEAD')) ?? '')) return undefined;
		return {why, source, head, at};
	} catch {
		return undefined;
	}
}

/** Drops the kept reason. Nothing kept is fine. */
export async function clearPendingWhy(cwd: string): Promise<void> {
	try {
		await rm(await pendingWhyPath(cwd), {force: true});
	} catch {
		// Not a repo: nothing to clear.
	}
}
