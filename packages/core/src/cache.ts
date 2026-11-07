import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from './git.js';

/** What Jev decided about one commit: a gitmoji code, or null for none. */
export type Judgment = {gitmoji: string | null; confidence: number};

export type JudgmentCache = {
	get(hash: string): Judgment | undefined;
	set(hash: string, judgment: Judgment): void;
	/** Writes the cache if anything changed. */
	save(): Promise<void>;
};

/**
 * Jev's judgments, kept in `<git-dir>/chamoji/cache.json` by commit hash so
 * `changelog --ai` never asks about the same commit twice. It holds only the
 * judgments, never commit text. A different `version` (model and questions)
 * starts empty, so a changed question is never answered from old results.
 */
export async function openJudgmentCache(
	cwd: string,
	version: string,
): Promise<JudgmentCache> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	const file = path.join(gitDir, 'chamoji', 'cache.json');
	const judgments = new Map<string, Judgment>(
		Object.entries(await readJudgments(file, version)),
	);
	let changed = false;
	return {
		get: hash => judgments.get(hash),
		set(hash, judgment) {
			judgments.set(hash, judgment);
			changed = true;
		},
		async save() {
			if (!changed) return;
			await mkdir(path.dirname(file), {recursive: true});
			await writeFile(
				file,
				`${JSON.stringify({version, judgments: Object.fromEntries(judgments)})}\n`,
			);
			changed = false;
		},
	};
}

async function readJudgments(
	file: string,
	version: string,
): Promise<Record<string, Judgment>> {
	try {
		const data = JSON.parse(await readFile(file, 'utf8')) as {
			version?: unknown;
			judgments?: unknown;
		};
		return data.version === version &&
			typeof data.judgments === 'object' &&
			data.judgments !== null
			? (data.judgments as Record<string, Judgment>)
			: {};
	} catch {
		return {};
	}
}
