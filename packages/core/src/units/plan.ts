import {lstat, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import {applyClassifier, buildRelease} from '../changelog.js';
import {
	getRemoteWebUrl,
	listTags,
	readCommitFiles,
	readCommits,
	runGit,
} from '../git.js';
import {parseCommit} from '../parse.js';
import {
	CHANGELOG_FILE,
	ReleaseError,
	gitMessage,
	movedPrefix,
	preflight,
	releaseSubject,
	type FileChange,
	type ReleaseOptions,
} from '../release.js';
import type {
	ChamojiConfig,
	Group,
	ParsedCommit,
	Release,
	SemverBump,
} from '../types.js';
import {bumpFor} from '../version.js';
import {attribute, releaseTargets, type Attributed} from './attribute.js';
import {editMentions} from './mentions.js';
import {readStyle, renderUnitSection, writeUnitChangelog} from './notes.js';
import {
	dependencyLine,
	dependencyUnits,
	rangeUpdates,
	setRanges,
} from './ranges.js';
import type {ReleaseSettings} from './settings.js';
import {renderTag, unitTagHistory, type UnitTag} from './tags.js';
import {
	readUpstream,
	sinceRange,
	syncFiles,
	type Upstream,
} from './upstream.js';
import {
	editVersionFiles,
	readEasRemote,
	readUnitVersion,
} from './version-files.js';
import {alignFixed, nextUnitVersion, type NextVersion} from './versions.js';
import {
	ownerOf,
	readWorkspace,
	resolveUnits,
	type ResolvedUnit,
	type WorkspacePackage,
} from './workspace.js';

export type UnitPlan = {
	unit: string;
	version: string;
	tag: string;
	lastTag: string | null;
	/** The version before this release: the last tag's, else the manifest's. */
	from: string | null;
	bump: SemverBump | 'prerelease' | 'first' | 'calver' | 'fixed';
	own: number;
	shared: number;
	/** The new section of the unit's changelog. */
	notes: string;
	/** The files this unit's release changes. */
	files: string[];
	/** Version files whose old value differed from `from`. */
	disagreed: string[];
	/** Released by `Release:` or `--unit` with only shared commits. */
	forced: boolean;
};

export type UnitPending = {unit: string; own: number; shared: number};

export type UnitReleasePlan =
	| {status: 'nothing'; pending: UnitPending[]; held?: string[]}
	| {
			status: 'ready';
			/** Repository root; `changes` paths are relative to it. */
			root: string;
			/** In dependency order: a unit others depend on comes first. */
			units: UnitPlan[];
			/** Units not releasing that have commits waiting, their own or shared. */
			pending: UnitPending[];
			changes: FileChange[];
			subject: string;
			/** HEAD before the release, for rolling back. */
			start: string;
			warnings: string[];
			/** One line per excluded path whose commits are left out. */
			excludedNote?: string;
			/** Units held back by `holdMajors`, for a breaking change. */
			held?: string[];
	  };

export type ReadyUnitPlan = Extract<UnitReleasePlan, {status: 'ready'}>;

export type UnitReleaseOptions = Omit<ReleaseOptions, 'version'> & {
	/** Release only these units, even with only shared commits. */
	units?: string[];
	/** The version to release, per unit, instead of the one its commits imply. */
	versions?: Record<string, string>;
};

/** One unit's window: the commits since its last tag, sorted out. */
type Window = {
	unit: ResolvedUnit;
	history: UnitTag[];
	last: UnitTag | null;
	/** Own commits, syncs that touched the unit included. */
	own: ParsedCommit[];
	shared: ParsedCommit[];
	/** Root-only commits, under `rootFiles: 'note'`. */
	root: ParsedCommit[];
	/** Named by a `Release:` trailer in the window. */
	targeted: boolean;
	/** Position of a commit in the window, newest first. */
	position: Map<string, number>;
};

type Reason = 'own' | 'forced' | 'shared' | 'dependency' | 'fixed';

/**
 * Works out every unit's release without changing anything: the same checks
 * as `planRelease`, then each unit's window, which units release, their
 * versions, notes and file changes, in dependency order.
 */
export async function planUnitReleases(
	options: UnitReleaseOptions,
): Promise<UnitReleasePlan> {
	const {config} = options;
	const settings = unitSettings(config, [
		...(options.units ?? []),
		...Object.keys(options.versions ?? {}),
	]);

	const {root, warnings: checks} = await preflight(options);
	const git = async (...args: string[]) => (await runGit(args, root)).trim();
	const packages = await readWorkspace(root);
	const resolved = resolveUnits(settings, packages);
	// Units whose packages another unit depends on come first; otherwise config order.
	const units = dependencyOrder(
		resolved,
		unit => unit.name,
		unit => dependencyUnits(unit, resolved),
	);
	const tags = await listTags(root, 'HEAD');
	const today = options.today ?? new Date().toISOString().slice(0, 10);

	// Read once for the whole plan: it covers every unit's window.
	const upstream = await readUpstream(root, 'HEAD', settings, tags);
	const warnings = [...checks, ...(upstream.warning ? [upstream.warning] : [])];
	const reader = windowReader(root, upstream);
	const since = await sinceRange(root, settings);
	const ranges = units.map(unit => {
		const history = unitTagHistory(tags, unit, settings);
		const last = history[0] ?? null;
		const range = last ? `refs/tags/${last.tag}..HEAD` : (since ?? 'HEAD');
		return {unit, history, last, range};
	});
	for (const {range} of ranges) await reader.read(range);
	if (options.classify) {
		await applyClassifier(options.classify, reader.parsed());
	}

	const windows: Window[] = [];
	for (const {unit, history, last, range} of ranges) {
		const read = await reader.read(range);
		const sorted = await sortWindow(
			reader,
			read,
			unit,
			units,
			packages,
			settings,
		);
		windows.push({
			unit,
			history,
			last,
			...sorted,
			targeted: read.commits.some(commit =>
				releaseTargets(commit, [unit.name]).includes(unit.name),
			),
			position: read.position,
		});
	}

	// With holdMajors, a unit whose next bump is major (and its whole fixed
	// group) is left out, and everything that depended on it is worked out
	// again without it: the commit subject, notes, changes and ranges all follow
	// from what is left.
	const held = new Set<string>();
	// The held units that would have released, for the report.
	const named = new Set<string>();
	let reasons = decide(windows, settings, options, held);
	let releasing = windows.filter(window => reasons.has(window.unit.name));
	const manifestVersions = new Map<string, string | null>();
	for (const {unit} of windows) {
		manifestVersions.set(unit.name, await readUnitVersion(root, unit));
	}

	const current = new Map(
		windows.map(window => [
			window.unit.name,
			window.last?.version ?? manifestVersions.get(window.unit.name) ?? null,
		]),
	);
	let versions = new Map<string, Exclude<NextVersion, null>>();
	for (;;) {
		if (reasons.size === 0) break;
		versions = workOutVersions(
			releasing,
			reasons,
			units,
			current,
			manifestVersions,
			settings,
			options,
			today,
		);
		if (!options.holdMajors) break;
		const before = held.size;
		for (const [name, next] of versions) {
			if (next.bump !== 'major') continue;
			held.add(name);
			named.add(name);
			for (const group of settings.fixed) {
				if (!group.includes(name)) continue;
				for (const member of group) {
					held.add(member);
					if (reasons.has(member)) named.add(member);
				}
			}
		}

		if (held.size === before) break;
		reasons = decide(windows, settings, options, held);
		releasing = windows.filter(window => reasons.has(window.unit.name));
	}

	const heldNames = units
		.filter(unit => named.has(unit.name))
		.map(unit => unit.name);
	const pending = windows
		.filter(window => !reasons.has(window.unit.name))
		.filter(window => window.own.length + window.shared.length > 0)
		.map(window => ({
			unit: window.unit.name,
			own: window.own.length,
			shared: window.shared.length,
		}));
	if (reasons.size === 0) {
		return {
			status: 'nothing',
			pending,
			...(heldNames.length > 0 ? {held: heldNames} : {}),
		};
	}

	const tagOf = new Map<string, string>();
	const taggedBy = new Map<string, string>();
	const groupOf = (name: string) =>
		settings.fixed.findIndex(group => group.includes(name));
	for (const {unit} of releasing) {
		const tag = renderTag(unit.tag, {
			unit: unit.name,
			name: unit.pkg?.name ?? '',
			version: versions.get(unit.name)!.version,
		});
		tagOf.set(unit.name, tag);
		// Members of one fixed group on one template share one tag.
		const other = taggedBy.get(tag);
		if (other !== undefined) {
			if (groupOf(other) !== -1 && groupOf(other) === groupOf(unit.name)) {
				continue;
			}

			throw new Error(
				`${other} and ${unit.name} would both be tagged ${tag}; give them tag templates that differ, or put them in one fixed group`,
			);
		}

		taggedBy.set(tag, unit.name);
		if (await git('tag', '--list', tag)) {
			throw new ReleaseError(
				'tag-exists',
				`tag ${tag} already exists, though not on this branch; pick another version`,
			);
		}
	}

	const start = await git('rev-parse', 'HEAD');
	const repositoryUrl = config.repositoryUrl ?? (await getRemoteWebUrl(root));
	const changes: FileChange[] = [];
	const changedBy = new Map<string, string>();
	const add = (owner: string, change: FileChange) => {
		const other = changedBy.get(change.file);
		if (other !== undefined) {
			throw new Error(
				`${change.file} would be changed by both ${other} and ${owner}; give each unit its own files`,
			);
		}

		changedBy.set(change.file, owner);
		changes.push(change);
	};

	const plans: UnitPlan[] = [];
	for (const window of releasing) {
		const {name} = window.unit;
		const {plan, changes: unitChanges} = await planUnit(
			window,
			{
				tag: tagOf.get(name)!,
				forced: reasons.get(name) === 'forced',
				releasedWith: releasedWith(window, reasons, settings),
			},
			{root, config, settings, units, versions, current, today, repositoryUrl},
		);
		for (const change of unitChanges) add(window.unit.name, change);
		plans.push(plan);
	}

	// Mentions go last, each unit's edit on top of the others', so one file
	// can pin several units without counting as a collision.
	for (const plan of plans) {
		const before = new Map(changes.map(change => [change.file, change.text]));
		const edited = await editMentions(
			root,
			settings.mentions ?? [],
			plan.unit,
			plan.version,
			changes,
		);
		changes.splice(0, changes.length, ...edited);
		for (const change of changes) {
			if (
				before.get(change.file) !== change.text &&
				!plan.files.includes(change.file)
			) {
				plan.files.push(change.file);
			}
		}
	}

	if (settings.rootChangelog) {
		const existing = await readText(root, CHANGELOG_FILE);
		const link = (file: string) =>
			encodeURI(file).replaceAll('(', '%28').replaceAll(')', '%29');
		const section = [
			`## ${today}`,
			'',
			...plans.map(
				plan =>
					`- ${plan.unit} [${plan.version}](${link(units.find(unit => unit.name === plan.unit)!.changelog)})`,
			),
		].join('\n');
		add('the root changelog', {
			file: CHANGELOG_FILE,
			text: writeUnitChangelog(existing, section),
			how: existing === null ? 'created with this release' : SECTION_ADDED,
		});
	}

	const excludedNote = excluded(
		reader.parsed(),
		reader.files(),
		units,
		packages,
		settings,
	);
	await refuseLinks(
		root,
		changes.map(change => change.file),
	);
	return {
		status: 'ready',
		root,
		units: plans,
		pending,
		changes,
		subject: releaseSubject(
			(await git('log', '-30', '--no-merges', '--format=%s')).split('\n'),
			uniqueTags(plans).join(', '),
		),
		start,
		warnings,
		...(excludedNote ? {excludedNote} : {}),
		...(heldNames.length > 0 ? {held: heldNames} : {}),
	};
}

/**
 * Writes the plan's changes, commits them with the release subject (and any
 * trailers) and makes one annotated tag per unit. If anything fails, the tags
 * it made are deleted and the repository is reset to where it started; tags
 * that were already there are never touched.
 */
export async function applyUnitReleases(
	plan: ReadyUnitPlan,
	options: {trailers?: string[]} = {},
): Promise<{commit: string}> {
	const git = async (...args: string[]) =>
		(await runGit(args, plan.root)).trim();
	// Checked again here: the tree may have changed since the plan was made.
	await refuseLinks(
		plan.root,
		plan.changes.map(change => change.file),
	);
	const made: string[] = [];
	const created: string[] = [];
	try {
		for (const change of plan.changes) {
			const file = path.join(plan.root, change.file);
			if ((await readText(plan.root, change.file)) === null) {
				created.push(file);
			}

			await mkdir(path.dirname(file), {recursive: true});
			await writeFile(file, change.text);
		}

		await git('add', '--', ...plan.changes.map(change => change.file));
		await git(
			'commit',
			'--quiet',
			'-m',
			plan.subject,
			...(options.trailers ?? []).flatMap(trailer => ['--trailer', trailer]),
		);
		for (const tag of uniqueTags(plan.units)) {
			await git('tag', '-a', tag, '-m', tag);
			made.push(tag);
		}
	} catch (error) {
		for (const tag of made) {
			await git('tag', '-d', tag).catch(() => undefined);
		}

		await git('reset', '--quiet', '--hard', plan.start).catch(() => undefined);
		for (const file of created) {
			await rm(file, {force: true}).catch(() => undefined);
		}

		throw new Error(
			`${gitMessage(error)}\nRolled back to ${plan.start.slice(0, 7)}; nothing was released.`,
		);
	}

	return {commit: await git('rev-parse', '--short', 'HEAD')};
}

/** Pushes HEAD and every unit tag, as refs/tags/<tag>, to origin in one atomic push. A failure keeps the local release. */
export async function pushUnitReleases(
	plan: ReadyUnitPlan,
	env?: Record<string, string>,
): Promise<void> {
	const tags = uniqueTags(plan.units);
	try {
		await runGit(
			[
				'push',
				'--atomic',
				'--quiet',
				'origin',
				'HEAD',
				...tags.map(tag => `refs/tags/${tag}`),
			],
			plan.root,
			env,
		);
	} catch (error) {
		throw new Error(
			`${movedPrefix(error)}released ${tags.join(', ')} locally, but the push failed; the release commit and tags are kept:\n${gitMessage(error)}`,
		);
	}
}

/** Each tag once, in plan order: fixed-group members can share one. */
export function uniqueTags(units: Array<{tag: string}>): string[] {
	return [...new Set(units.map(unit => unit.tag))];
}

const SECTION_ADDED =
	'new section added above the previous release; older entries untouched';

/**
 * The release settings, once every name in `names` is checked against them.
 * Throws when there are no units, or for a name that isn't one.
 */
export function unitSettings(
	config: ChamojiConfig,
	names: string[],
): ReleaseSettings {
	const settings = config.release;
	if (!settings || settings.units.length === 0) {
		throw new Error(
			'no release units are set up; add them under release.units in chamoji.config.json',
		);
	}

	const known = settings.units.map(unit => unit.name);
	for (const name of names) {
		if (!known.includes(name)) {
			throw new Error(
				`unknown unit "${name}"; the units are ${known.join(', ')}`,
			);
		}
	}

	return settings;
}

/**
 * What others depend on comes first; otherwise the order given. A cycle is
 * broken where it's first met. Units and published packages both use it.
 */
export function dependencyOrder<T>(
	items: readonly T[],
	key: (item: T) => string,
	dependencies: (item: T) => readonly T[],
): T[] {
	const done = new Set<string>();
	const visiting = new Set<string>();
	const ordered: T[] = [];
	const visit = (item: T) => {
		const id = key(item);
		if (done.has(id) || visiting.has(id)) return;
		visiting.add(id);
		for (const dep of dependencies(item)) visit(dep);
		visiting.delete(id);
		done.add(id);
		ordered.push(item);
	};

	for (const item of items) visit(item);
	return ordered;
}

function ownsFile(
	file: string,
	unit: ResolvedUnit,
	units: ResolvedUnit[],
	packages: WorkspacePackage[],
	settings: ReleaseSettings,
): boolean {
	const owner = ownerOf(file, units, packages, settings.exclude);
	return owner.kind === 'unit' && owner.unit === unit.name;
}

export type Read = {
	/** Non-merge commits, upstream ones left out, newest first. */
	commits: ParsedCommit[];
	files: Map<string, string[]>;
	/** Every commit's position in the range, merges included when there are syncs. */
	position: Map<string, number>;
};

export type WindowReader = ReturnType<typeof windowReader>;

/**
 * Reads windows, once per range. A commit in several windows is parsed once,
 * so a classifier's picks reach every unit.
 */
export function windowReader(root: string, upstream: Upstream) {
	const parsed = new Map<string, ParsedCommit>();
	const files = new Map<string, string[]>();
	const reads = new Map<string, Promise<Read>>();
	const synced = new Map<string, Promise<string[]>>();

	const load = async (range: string): Promise<Read> => {
		const raw = await readCommits(root, range);
		const commits = raw
			.filter(commit => !upstream.commits.has(commit.hash))
			.map(commit => {
				let found = parsed.get(commit.hash);
				if (!found) {
					found = parseCommit(commit);
					parsed.set(commit.hash, found);
				}

				return found;
			});
		const rangeFiles = await readCommitFiles(root, range);
		for (const [hash, list] of rangeFiles) files.set(hash, list);
		const order =
			upstream.syncs.length > 0
				? (await runGit(['rev-list', '--end-of-options', range, '--'], root))
						.split('\n')
						.filter(Boolean)
				: commits.map(commit => commit.hash);
		return {
			commits,
			files: rangeFiles,
			position: new Map(order.map((hash, index) => [hash, index])),
		};
	};

	return {
		/** Sync merges anywhere in history; a window holds the ones in its range. */
		syncs: upstream.syncs,
		read(range: string): Promise<Read> {
			let read = reads.get(range);
			if (!read) {
				read = load(range);
				reads.set(range, read);
			}

			return read;
		},
		syncFiles(sync: ParsedCommit): Promise<string[]> {
			let list = synced.get(sync.hash);
			if (!list) {
				list = syncFiles(root, sync);
				synced.set(sync.hash, list);
			}

			return list;
		},
		/** Every commit read so far, upstream ones left out. */
		parsed: () => [...parsed.values()],
		files: () => files,
	};
}

/**
 * A window's commits for `unit`: own ones, with the syncs that changed its
 * files, in window order; shared ones; and root-only ones.
 */
export async function sortWindow(
	reader: WindowReader,
	read: Read,
	unit: ResolvedUnit,
	units: ResolvedUnit[],
	packages: WorkspacePackage[],
	settings: ReleaseSettings,
): Promise<Attributed> {
	const sorted = attribute(
		read.commits,
		read.files,
		unit,
		units,
		packages,
		settings,
	);
	const own = [...sorted.own];
	for (const sync of reader.syncs) {
		if (!read.position.has(sync.hash)) continue;
		const files = await reader.syncFiles(sync);
		if (files.some(file => ownsFile(file, unit, units, packages, settings))) {
			own.push(sync);
		}
	}

	return {...sorted, own: inWindowOrder(own, read.position)};
}

/** `commits` newest first, by their position in the window. */
export function inWindowOrder<T extends ParsedCommit>(
	commits: T[],
	position: Map<string, number>,
): T[] {
	return [...commits].sort(
		(a, b) => position.get(a.hash)! - position.get(b.hash)!,
	);
}

/**
 * Which units release, and why. Own commits that imply a bump, `--unit`,
 * `versions` or a `Release:` trailer release a unit; under
 * release-dependents so do shared commits and a released dependency. A
 * fixed group releases together. `--unit` limits all but fixed groups.
 */
function decide(
	windows: Window[],
	settings: ReleaseSettings,
	options: UnitReleaseOptions,
	held: Set<string> = new Set(),
): Map<string, Reason> {
	const only = options.units?.length ? new Set(options.units) : null;
	const named = new Set([
		...(options.units ?? []),
		...Object.keys(options.versions ?? {}),
	]);
	const dependents = settings.sharedChanges === 'release-dependents';
	const reasons = new Map<string, Reason>();
	for (const {unit, own, shared, targeted} of windows) {
		if ((only && !only.has(unit.name)) || held.has(unit.name)) continue;
		if (bumpFor(own)) reasons.set(unit.name, 'own');
		else if (named.has(unit.name) || targeted) reasons.set(unit.name, 'forced');
		else if (dependents && bumpFor(shared)) reasons.set(unit.name, 'shared');
	}

	const units = windows.map(window => window.unit);
	for (let changed = true; changed;) {
		changed = false;
		for (const group of settings.fixed) {
			if (!group.some(name => reasons.has(name))) continue;
			for (const name of group) {
				if (!reasons.has(name) && !held.has(name)) {
					reasons.set(name, 'fixed');
					changed = true;
				}
			}
		}

		if (!dependents) continue;
		for (const unit of units) {
			if (
				reasons.has(unit.name) ||
				held.has(unit.name) ||
				(only && !only.has(unit.name))
			) {
				continue;
			}

			if (dependencyUnits(unit, units).some(dep => reasons.has(dep.name))) {
				reasons.set(unit.name, 'dependency');
				changed = true;
			}
		}
	}

	return reasons;
}

/** A patch-level stand-in, so a forced or dependency release bumps at least a patch. */
const PATCH_FLOOR = parseCommit({
	hash: '',
	shortHash: '',
	authorName: '',
	authorEmail: '',
	date: '',
	subject: '⬆️ Dependencies',
	body: '',
	trailers: '',
});

function workOutVersions(
	releasing: Window[],
	reasons: Map<string, Reason>,
	units: ResolvedUnit[],
	current: Map<string, string | null>,
	manifestVersions: Map<string, string | null>,
	settings: ReleaseSettings,
	options: UnitReleaseOptions,
	today: string,
): Map<string, Exclude<NextVersion, null>> {
	const next = new Map<string, NextVersion>();
	const wanted = new Map<string, string>();
	for (const {unit, history, last, own, shared} of releasing) {
		const reason = reasons.get(unit.name)!;
		const given = options.versions?.[unit.name];
		if (given !== undefined) {
			const version = checkVersion(given, last);
			wanted.set(unit.name, version);
			next.set(unit.name, {version, bump: bumpBetween(last, version)});
			continue;
		}

		const floor =
			reason === 'forced' ||
			reason === 'dependency' ||
			dependencyUnits(unit, units).some(dep => reasons.has(dep.name));
		const month = `${Number(today.slice(0, 4))}.${Number(today.slice(5, 7))}.`;
		const version = nextUnitVersion({
			unit,
			last,
			manifestVersion: manifestVersions.get(unit.name) ?? null,
			commits: [...own, ...shared, ...(floor ? [PATCH_FLOOR] : [])],
			today,
			releasesThisMonth: history.filter(tag => tag.version.startsWith(month))
				.length,
			...(settings.zeroMajor ? {zeroMajor: settings.zeroMajor} : {}),
		});
		if (version) next.set(unit.name, version);
	}

	const aligned = alignFixed(next, settings.fixed, current);
	const result = new Map<string, Exclude<NextVersion, null>>();
	for (const {unit} of releasing) {
		const version = aligned.get(unit.name);
		if (!version) {
			throw new Error(`can't work out ${unit.name}'s next version`);
		}

		const given = wanted.get(unit.name);
		if (given !== undefined && given !== version.version) {
			throw new ReleaseError(
				'invalid-version',
				`${unit.name} shares one version with its fixed group, which releases ${version.version}, not ${given}`,
			);
		}

		result.set(unit.name, version);
	}

	return result;
}

/** A version given by hand, checked as `planRelease` checks `version`. */
function checkVersion(given: string, last: UnitTag | null): string {
	const version = semver.valid(given);
	if (!version) {
		throw new ReleaseError(
			'invalid-version',
			`${given} is not a semver version`,
		);
	}

	if (last && semver.lte(version, last.version)) {
		throw new ReleaseError(
			'not-newer',
			`${version} is not newer than the last release, ${last.tag}`,
		);
	}

	return version;
}

function bumpBetween(
	last: UnitTag | null,
	version: string,
): Exclude<NextVersion, null>['bump'] {
	if (!last) return 'first';
	if (semver.prerelease(version)) return 'prerelease';
	return (semver.diff(last.version, version) as SemverBump | null) ?? 'patch';
}

/**
 * The members of the window's fixed group that release with changes of their
 * own, when the window's unit releases only because it is in that group.
 */
function releasedWith(
	window: Window,
	reasons: Map<string, Reason>,
	settings: ReleaseSettings,
): string[] | null {
	const {name} = window.unit;
	if (
		reasons.get(name) !== 'fixed' ||
		window.own.length + window.shared.length > 0
	) {
		return null;
	}

	const group = settings.fixed.find(members => members.includes(name)) ?? [];
	return group.filter(member => {
		const reason = reasons.get(member);
		return reason !== undefined && reason !== 'fixed';
	});
}

/** A Changed section saying which members of the fixed group set the version. */
function releasedWithGroup(names: string[], config: ChamojiConfig): Group {
	const line: ParsedCommit = {
		...parseCommit({
			hash: '',
			shortHash: '',
			authorName: '',
			authorEmail: '',
			date: '',
			subject: `Released with ${names.join(', ')} at the group's version`,
			body: '',
			trailers: '',
		}),
		gitmoji: null,
		gitmojiSource: null,
	};
	return {
		group: 'changed',
		label:
			config.groups.find(item => item.group === 'changed')?.label ?? 'Changed',
		commits: [line],
	};
}

type UnitContext = {
	root: string;
	config: ChamojiConfig;
	settings: ReleaseSettings;
	units: ResolvedUnit[];
	versions: Map<string, Exclude<NextVersion, null>>;
	current: Map<string, string | null>;
	today: string;
	repositoryUrl: string | undefined;
};

type UnitRelease = {
	tag: string;
	forced: boolean;
	/** For a fixed-group member with no commits: the members it releases with. */
	releasedWith: string[] | null;
};

/**
 * One releasing unit's notes and file changes: its changelog, then its
 * version files, with any dependency ranges set in its package.json.
 */
async function planUnit(
	window: Window,
	{tag, forced, releasedWith}: UnitRelease,
	context: UnitContext,
): Promise<{plan: UnitPlan; changes: FileChange[]}> {
	const {root, config, settings, versions, current, today} = context;
	const {unit, last} = window;
	const from = current.get(unit.name) ?? null;
	const {version, bump} = versions.get(unit.name)!;
	const manifest = path.posix.join(unit.path, 'package.json');
	const manifestText = await readText(root, manifest);
	const updates = rangeUpdates(
		unit,
		context.units,
		manifestText,
		versions,
		current,
	);

	const noted = [
		...inWindowOrder([...window.own, ...window.shared], window.position),
		...updates.map(update => dependencyLine(update)),
	];
	const built = await buildRelease(
		root,
		config,
		{version, tag, previousTag: last?.tag ?? null, date: today},
		noted,
		'HEAD',
		true,
	);
	const release: Release = {
		...built,
		nextVersion: null,
		groups: releasedWith
			? [releasedWithGroup(releasedWith, config), ...built.groups]
			: built.groups,
	};
	const existing = await readText(root, unit.changelog);
	const notes = renderUnitSection(
		release,
		context.repositoryUrl,
		existing === null ? null : readStyle(existing),
		settings.rootFiles === 'note'
			? {rootChanges: window.root.length}
			: undefined,
	);
	const changes: FileChange[] = [
		{
			file: unit.changelog,
			text: writeUnitChangelog(existing, notes),
			how: existing === null ? 'created with this release' : SECTION_ADDED,
		},
	];

	const edits = await editVersionFiles(root, unit, version, {
		current: from,
		buildNumber: unit.buildNumber,
		easRemote: await readEasRemote(root, unit.path),
	});
	const ranged = updates.filter(update => update.range !== null);
	const withRanges = (text: string) => setRanges(text, manifest, ranged);
	const rangeNote = ranged
		.map(update => `${update.name} ${update.range}`)
		.join(', ');
	for (const edit of edits) {
		const isManifest = edit.file === manifest && ranged.length > 0;
		changes.push({
			file: edit.file,
			text: isManifest ? withRanges(edit.text) : edit.text,
			how: `version ${version}${isManifest ? `; ${rangeNote}` : ''}`,
		});
	}

	if (ranged.length > 0 && !edits.some(edit => edit.file === manifest)) {
		changes.push({
			file: manifest,
			text: withRanges(manifestText ?? ''),
			how: `dependency ranges: ${rangeNote}`,
		});
	}

	return {
		plan: {
			unit: unit.name,
			version,
			tag,
			lastTag: last?.tag ?? null,
			from,
			bump,
			own: window.own.length,
			shared: window.shared.length,
			notes,
			files: changes.map(change => change.file),
			disagreed:
				from === null
					? []
					: edits
							.filter(edit => edit.from !== null && edit.from !== from)
							.map(edit => edit.file),
			forced,
		},
		changes,
	};
}

/**
 * One line per exclude pattern whose commits no unit releases: commits that
 * change an excluded path and nothing a unit or internal package holds.
 */
function excluded(
	commits: ParsedCommit[],
	files: Map<string, string[]>,
	units: ResolvedUnit[],
	packages: WorkspacePackage[],
	settings: ReleaseSettings,
): string | undefined {
	const counts = new Map<string, number>();
	for (const commit of commits) {
		let pattern: string | undefined;
		let released = false;
		for (const file of files.get(commit.hash) ?? []) {
			const owner = ownerOf(file, units, packages, settings.exclude).kind;
			if (owner === 'unit' || owner === 'internal') released = true;
			if (owner === 'excluded') {
				pattern ??= settings.exclude.find(
					glob => ownerOf(file, [], [], [glob]).kind === 'excluded',
				);
			}
		}

		if (!released && pattern !== undefined) {
			counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
		}
	}

	const lines = settings.exclude.flatMap(pattern => {
		const count = counts.get(pattern);
		return count
			? [
					`${pattern}: ${count} commit${count === 1 ? '' : 's'} not released (excluded)`,
				]
			: [];
	});
	return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Refuses a file the release would write through a symlink (the file itself
 * or a folder between it and the repo root) or outside the repository. Git
 * commits a link, not what it points to, so writing through one would change
 * a file the release commit doesn't hold, possibly outside the repository.
 */
async function refuseLinks(root: string, files: string[]): Promise<void> {
	for (const file of files) {
		const relative = path.relative(root, path.resolve(root, file));
		if (
			relative === '' ||
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			throw new ReleaseError(
				'invalid-version',
				`${file} is outside the repository; chamoji only writes files inside it`,
			);
		}

		let at = root;
		for (const part of relative.split(path.sep)) {
			at = path.join(at, part);
			let isLink: boolean;
			try {
				isLink = (await lstat(at)).isSymbolicLink();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
				throw error;
			}

			if (isLink) {
				const link = path.relative(root, at).split(path.sep).join('/');
				throw new ReleaseError(
					'invalid-version',
					link === file
						? `${file} is a symlink; chamoji won't write through links`
						: `${file} goes through ${link}, which is a symlink; chamoji won't write through links`,
				);
			}
		}
	}
}

async function readText(root: string, file: string): Promise<string | null> {
	try {
		return await readFile(path.join(root, file), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
