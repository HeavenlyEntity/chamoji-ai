import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {readCommits, runGit} from './git.js';
import {parseCommit} from './parse.js';
import {judgeWhy, type WhyReason} from './why-quality.js';
import {mergeCards, readNoteCards} from './why-notes.js';

/** A commit whose Why is thin or missing, and how many lines it wrote. */
export type ThinWhy = {
	hash: string;
	shortHash: string;
	subject: string;
	lines: number;
	kind: 'thin' | 'missing';
	/** The reasons the card gives, joined; empty when there is no card. */
	why: string;
	reasons: WhyReason[];
};

/** The path asked for is not inside the repository. */
export class OutsideRepoError extends Error {
	constructor(readonly pathspec: string) {
		super(`${pathspec} is outside the repository.`);
		this.name = 'OutsideRepoError';
	}
}

const DEFAULT_LIMIT = 20;
const HEADER = /^([0-9a-f]{40,64}) \d+ \d+/;

/**
 * The commits behind the lines under `pathspec` whose Why is thin or missing,
 * the ones that wrote the most lines first. Every file is blamed in the
 * working copy, so lines that aren't committed yet, and files git can't
 * blame, count for no one. An added reason (a git note) counts as part of the
 * commit's card. Reads git only.
 */
export async function listThinWhys(
	cwd: string,
	pathspec = '.',
	options: {limit?: number} = {},
): Promise<ThinWhy[]> {
	const inside = await assertInside(cwd, pathspec);
	const files = (await runGit(['ls-files', '-z', '--', inside], cwd))
		.split('\0')
		.filter(Boolean);
	const counts = new Map<string, number>();
	for (const file of files) {
		for (const [hash, lines] of await blameCounts(cwd, file)) {
			counts.set(hash, (counts.get(hash) ?? 0) + lines);
		}
	}

	if (counts.size === 0) return [];
	const notes = await readNoteCards(cwd);
	const found: ThinWhy[] = [];
	for (const [hash, lines] of counts) {
		// `^!` is the commit alone, which also works for a root commit.
		const [raw] = await readCommits(cwd, `${hash}^!`);
		if (!raw) continue; // A merge commit has no card.
		const commit = parseCommit(raw);
		const card = mergeCards(notes.get(commit.hash), commit.card);
		const base = {
			hash: commit.hash,
			shortHash: commit.shortHash,
			subject: commit.subject,
			lines,
		};
		if (card === undefined) {
			found.push({...base, kind: 'missing', why: '', reasons: []});
			continue;
		}

		const {level, reasons} = judgeWhy(card, commit.description);
		if (level === 'ok') continue;
		found.push({...base, kind: 'thin', why: card.why.join('; '), reasons});
	}

	return found
		.sort(
			(a, b) =>
				b.lines - a.lines ||
				(a.kind === b.kind ? 0 : a.kind === 'thin' ? -1 : 1) ||
				(a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
		)
		.slice(0, options.limit ?? DEFAULT_LIMIT);
}

/**
 * The pathspec to give git, or OutsideRepoError for a plain path that leaves
 * the repository. A relative path is placed with the folder's prefix from git
 * (`--show-prefix`). An absolute one is compared with the repo's top folder
 * after `realpath` on both sides, so /tmp and /private/tmp agree; a part that
 * doesn't exist yet is kept as written. An absolute path inside the repo is
 * given to git by its real path. A pathspec with magic (`:(glob)...`) is left
 * to git.
 */
async function assertInside(cwd: string, pathspec: string): Promise<string> {
	if (pathspec.startsWith(':')) return pathspec;
	if (path.isAbsolute(pathspec)) {
		const top = await realpath(
			(await runGit(['rev-parse', '--show-toplevel'], cwd)).trim(),
		);
		const target = await realTarget(pathspec);
		const relative = path.relative(top, target);
		if (
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new OutsideRepoError(pathspec);
		}

		return target;
	}

	const prefix = (await runGit(['rev-parse', '--show-prefix'], cwd)).trim();
	const target = path.posix.normalize(
		path.posix.join(prefix, pathspec.replaceAll('\\', '/')),
	);
	if (target === '..' || target.startsWith('../')) {
		throw new OutsideRepoError(pathspec);
	}

	return pathspec;
}

/** `realpath` of the nearest part of `target` that exists, plus the rest. */
async function realTarget(target: string): Promise<string> {
	const resolved = path.resolve(target);
	let existing = resolved;
	for (;;) {
		try {
			const real = await realpath(existing);
			return path.join(real, path.relative(existing, resolved));
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			existing = parent;
		}
	}
}

/**
 * Lines per commit in one file. Each line has a header in the porcelain
 * output; its text starts with a tab, so it can't be mistaken for one. A
 * file git can't blame, or a line no commit wrote, gives nothing.
 */
async function blameCounts(
	cwd: string,
	file: string,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	let stdout: string;
	try {
		stdout = await runGit(
			['blame', '--porcelain', '-w', '-M', '--', file],
			cwd,
		);
	} catch {
		return counts;
	}

	for (const line of stdout.split('\n')) {
		if (line.startsWith('\t')) continue;
		const hash = HEADER.exec(line)?.[1];
		if (hash !== undefined) counts.set(hash, (counts.get(hash) ?? 0) + 1);
	}

	for (const hash of counts.keys()) {
		if (/^0+$/.test(hash)) counts.delete(hash);
	}

	return counts;
}
