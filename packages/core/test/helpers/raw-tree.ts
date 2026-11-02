import {runGitWithInput} from '../../src/git.js';
import {MEMORY_REF} from '../../src/memory.js';
import {gitOutput} from './fixture-repo.js';

/** One entry of a tree, as `ls-tree -r` prints it. */
export type RawEntry = {path: string; mode: string; type: string; id: string};

/**
 * The entries at the tip of `ref` straight from git, and in no way through
 * chamoji's own reader, so a test can say what a write really left behind.
 */
export async function lsTree(dir: string, ref = MEMORY_REF) {
	const text = await gitOutput(dir, [
		'ls-tree',
		'-r',
		'-z',
		'--full-tree',
		ref,
	]);
	return text
		.split('\0')
		.filter(Boolean)
		.map((line): RawEntry => {
			const [meta = '', path = ''] = line.split('\t');
			const [mode = '', type = '', id = ''] = meta.split(' ');
			return {path, mode, type, id};
		});
}

/** Builds nested trees for `entries` with `mktree`, and returns the root's id. */
async function build(dir: string, entries: RawEntry[]): Promise<string> {
	const lines: string[] = [];
	const folders = new Map<string, RawEntry[]>();
	for (const entry of entries) {
		const slash = entry.path.indexOf('/');
		if (slash === -1) {
			lines.push(`${entry.mode} ${entry.type} ${entry.id}\t${entry.path}`);
		} else {
			const folder = entry.path.slice(0, slash);
			folders.set(folder, [
				...(folders.get(folder) ?? []),
				{...entry, path: entry.path.slice(slash + 1)},
			]);
		}
	}

	for (const [folder, below] of folders) {
		lines.push(`040000 tree ${await build(dir, below)}\t${folder}`);
	}

	const input = lines.map(line => `${line}\0`).join('');
	const args = ['mktree', '-z', '--missing'];
	return (await runGitWithInput(args, dir, input)).trim();
}

/**
 * Commits what the ref holds now plus `extras` on top of it, the way a newer
 * chamoji, or anyone who can push, could have. `mode` is a plain file's by
 * default; `text` is stored as the blob. An entry at a path the ref already
 * has replaces it.
 */
export async function plantForeign(
	dir: string,
	extras: Array<{path: string; text?: string; mode?: string; id?: string}>,
	ref = MEMORY_REF,
): Promise<void> {
	const head = await gitOutput(dir, ['rev-parse', '--verify', '-q', ref])
		.then(stdout => stdout.trim())
		.catch(() => undefined);
	const kept = head === undefined ? [] : await lsTree(dir, ref);
	const added: RawEntry[] = [];
	for (const {path, text = '', mode = '100644', id} of extras) {
		const isSubmodule = mode === '160000';
		added.push({
			path,
			mode,
			type: isSubmodule ? 'commit' : 'blob',
			id:
				id ??
				(
					await runGitWithInput(['hash-object', '-w', '--stdin'], dir, text)
				).trim(),
		});
	}

	const paths = new Set(added.map(entry => entry.path));
	const tree = await build(dir, [
		...kept.filter(entry => !paths.has(entry.path)),
		...added,
	]);
	const commit = (
		await gitOutput(dir, [
			'-c',
			'user.name=Planted',
			'-c',
			'user.email=planted@example.com',
			'commit-tree',
			tree,
			...(head ? ['-p', head] : []),
			'-m',
			'Planted',
		])
	).trim();
	await gitOutput(dir, ['update-ref', ref, commit]);
}
