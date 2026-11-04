import semver from 'semver';
import {bumpFor, nextVersion} from '../version.js';
import type {ParsedCommit, SemverBump} from '../types.js';
import type {UnitTag} from './tags.js';
import type {ResolvedUnit} from './workspace.js';

export type VersionInput = {
	unit: ResolvedUnit;
	last: UnitTag | null; // from unitTagHistory
	manifestVersion: string | null; // unit.pkg?.version
	commits: ParsedCommit[]; // own + shared (+ syncs) in the window
	today: string; // YYYY-MM-DD
	releasesThisMonth: number; // calver: this unit's tags in today's YYYY.MM
	zeroMajor?: 'minor';
};

export type NextVersion = {
	version: string;
	bump: SemverBump | 'prerelease' | 'first' | 'calver' | 'fixed';
} | null; // 'fixed': raised only to match its group

/** The version `input.unit` releases next, or null when nothing is due. */
export function nextUnitVersion(input: VersionInput): NextVersion {
	const {unit, last, manifestVersion, commits, today, releasesThisMonth} =
		input;
	const calver = unit.versioning === 'calver';

	if (!last) {
		const version =
			unit.firstVersion ??
			(calver
				? `${today.slice(0, 7).replace('-', '.')}.${releasesThisMonth}`
				: (manifestVersion ?? '0.1.0'));
		return {version, bump: 'first'};
	}

	let bump = bumpFor(commits);
	if (!bump) {
		return null;
	}

	if (calver) {
		return {
			version: `${today.slice(0, 7).replace('-', '.')}.${releasesThisMonth}`,
			bump: 'calver',
		};
	}

	if (
		input.zeroMajor === 'minor' &&
		bump === 'major' &&
		semver.major(last.version) === 0
	) {
		bump = 'minor';
	}

	const version = nextVersion(last.version, bump);
	return version ? {version, bump} : null;
}

const RANK: Record<SemverBump, number> = {patch: 1, minor: 2, major: 3};
const isSemverBump = (bump: string): bump is SemverBump => bump in RANK;

/** Fixed groups: every member gets the largest of the members' versions. */
export function alignFixed(
	next: Map<string, NextVersion>,
	fixed: string[][],
	current: Map<string, string | null>,
): Map<string, NextVersion> {
	const result = new Map(next);
	for (const group of fixed) {
		const releasing = group.flatMap(name => {
			const entry = next.get(name);
			return entry ? [entry] : [];
		});
		if (releasing.length === 0) {
			continue;
		}

		let largest: SemverBump = 'patch';
		let seen = false;
		for (const {bump} of releasing) {
			if (isSemverBump(bump) && (!seen || RANK[bump] > RANK[largest])) {
				largest = bump;
				seen = true;
			}
		}

		const candidates = releasing.map(entry => entry.version);
		for (const name of group) {
			const version = current.get(name);
			const bumped = version ? semver.inc(version, largest) : null;
			if (bumped) {
				candidates.push(bumped);
			}
		}

		const winner = candidates.reduce((best, version) =>
			semver.gt(version, best) ? version : best,
		);
		for (const name of group) {
			const own = next.get(name);
			result.set(
				name,
				own?.version === winner ? own : {version: winner, bump: 'fixed'},
			);
		}
	}

	return result;
}
