import type {ParsedCommit} from '../types.js';
import type {ReleaseSettings} from './settings.js';
import {
	ownerOf,
	type ResolvedUnit,
	type WorkspacePackage,
} from './workspace.js';

export type Attributed = {
	own: ParsedCommit[];
	/** `via` is the internal package path the commit changed. */
	shared: Array<ParsedCommit & {via: string}>;
	/** Root-only commits, kept for rootFiles 'all' or 'note'. */
	root: ParsedCommit[];
};

/**
 * Sorts `commits` into what belongs to `unit`, by the files each one changed.
 * Own: a file the unit holds. Shared: otherwise, a file of an internal package
 * the unit uses. Root: only root files (excluded paths don't count), kept under
 * `rootFiles: 'note'`. Anything
 * else, like another unit's commits or excluded-only ones, is dropped. Under
 * `rootFiles: 'all'` root commits are own.
 */
export function attribute(
	commits: ParsedCommit[],
	files: Map<string, string[]>,
	unit: ResolvedUnit,
	units: ResolvedUnit[],
	packages: WorkspacePackage[],
	settings: ReleaseSettings,
): Attributed {
	const result: Attributed = {own: [], shared: [], root: []};
	const uses = new Set(unit.uses);
	for (const commit of commits) {
		let owns = false;
		let hasRoot = false;
		let other = false;
		const via: string[] = [];
		for (const file of files.get(commit.hash) ?? []) {
			const owner = ownerOf(file, units, packages, settings.exclude);
			if (owner.kind === 'unit') {
				if (owner.unit === unit.name) owns = true;
				else other = true;
			} else if (owner.kind === 'internal') {
				if (uses.has(owner.path)) via.push(owner.path);
				else other = true;
			} else if (owner.kind === 'root') {
				hasRoot = true;
			}
		}

		if (owns) {
			result.own.push(commit);
		} else if (via.length > 0) {
			result.shared.push({...commit, via: via.sort()[0]!});
		} else if (hasRoot && !other) {
			if (settings.rootFiles === 'all') result.own.push(commit);
			else if (settings.rootFiles === 'note') result.root.push(commit);
		}
	}

	return result;
}

/** Units named by `Release:` trailers on the commit; 'all' expands to every unit name. */
export function releaseTargets(
	commit: ParsedCommit,
	unitNames: string[],
): string[] {
	const wanted = new Set<string>();
	for (const trailer of commit.trailers) {
		if (trailer.key.toLowerCase() !== 'release') continue;
		for (const part of trailer.value.split(',')) {
			const name = part.trim().toLowerCase();
			if (name !== '') wanted.add(name);
		}
	}

	if (wanted.has('all')) return [...unitNames];
	return unitNames.filter(name => wanted.has(name.toLowerCase()));
}
