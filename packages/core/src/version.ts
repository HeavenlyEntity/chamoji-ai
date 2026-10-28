import semver from 'semver';
import {getGitmoji} from './gitmojis.js';
import type {ParsedCommit, SemverBump} from './types.js';

const RANK: Record<SemverBump, number> = {patch: 1, minor: 2, major: 3};

/** The release bump implied by `commits`, from gitmoji semver data. */
export function bumpFor(commits: ParsedCommit[]): SemverBump | null {
	let bump: SemverBump | null = null;
	for (const commit of commits) {
		if (commit.breaking) {
			return 'major';
		}

		const level = commit.gitmoji ? getGitmoji(commit.gitmoji)?.semver : null;
		if (level && (!bump || RANK[level] > RANK[bump])) {
			bump = level;
		}
	}

	return bump;
}

/** `current` bumped by `bump`, without a `v` prefix. */
export function nextVersion(
	current: string | null,
	bump: SemverBump | null,
): string | null {
	return bump ? semver.inc(current ?? '0.0.0', bump) : null;
}
