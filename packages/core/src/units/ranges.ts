import semver from 'semver';
import {parseCommit} from '../parse.js';
import {ReleaseError} from '../release.js';
import type {ParsedCommit} from '../types.js';
import {setJsonString} from './version-files.js';
import type {ResolvedUnit} from './workspace.js';

export type RangeUpdate = {
	/** The dependency's package name. */
	name: string;
	/** Its version in this release, for the Dependencies line. */
	version: string;
	/** The new range for `dependencies`, or null to leave it as written. */
	range: string | null;
};

/** The units whose packages `unit`'s package has as runtime dependencies. */
export function dependencyUnits(
	unit: ResolvedUnit,
	units: ResolvedUnit[],
): ResolvedUnit[] {
	const deps = new Set(unit.pkg?.runtimeDeps ?? []);
	return units.filter(
		other => other !== unit && other.pkg && deps.has(other.pkg.name),
	);
}

/**
 * What a releasing unit's notes and manifest say about the units it depends
 * on: every dependency releasing now gets a Dependencies line and, when it
 * is in `dependencies`, a `^<version>` range, unless its range is a
 * `workspace:` one, which pnpm rewrites when it publishes. Peer ranges are
 * left as written. A dependency that isn't releasing changes the range only
 * when the range no longer accepts its current version.
 */
export function rangeUpdates(
	unit: ResolvedUnit,
	units: ResolvedUnit[],
	manifest: string | null,
	releasing: Map<string, {version: string}>,
	current: Map<string, string | null>,
): RangeUpdate[] {
	const declared = declaredDependencies(manifest);
	const updates: RangeUpdate[] = [];
	for (const dep of dependencyUnits(unit, units)) {
		const name = dep.pkg!.name;
		const written = declared[name];
		const next = releasing.get(dep.name)?.version;
		const version = next ?? current.get(dep.name) ?? null;
		if (version === null) continue;
		const range =
			written === undefined || written.startsWith('workspace:')
				? null
				: `^${version}`;
		if (next !== undefined) {
			updates.push({name, version, range: range === written ? null : range});
		} else if (
			range !== null &&
			semver.validRange(written) !== null &&
			!semver.satisfies(version, written!)
		) {
			updates.push({name, version, range});
		}
	}

	return updates;
}

/** The package.json `text` with every update's range set, as text. */
export function setRanges(
	text: string,
	file: string,
	updates: RangeUpdate[],
): string {
	let next = text;
	for (const {name, range} of updates) {
		if (range === null) continue;
		const edited = setJsonString(next, ['dependencies', name], range);
		if (edited === undefined) {
			throw new ReleaseError(
				'invalid-version',
				`can't set the range of ${name} in ${file}: it isn't a string in "dependencies"`,
			);
		}

		next = edited;
	}

	return next;
}

/** The Dependencies line for a dependency's new version. It has no commit of its own. */
export function dependencyLine(update: RangeUpdate): ParsedCommit {
	return parseCommit({
		hash: '',
		shortHash: '',
		authorName: '',
		authorEmail: '',
		date: '',
		subject: `⬆️ Bump ${update.name} to ${update.version}`,
		body: '',
		trailers: '',
	});
}

/** The `dependencies` of a package.json's text, or none. */
function declaredDependencies(text: string | null): Record<string, string> {
	const deps =
		text === null
			? undefined
			: (JSON.parse(text) as {dependencies?: unknown}).dependencies;
	if (!deps || typeof deps !== 'object') return {};
	return Object.fromEntries(
		Object.entries(deps).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		),
	);
}
