import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
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
	preflight,
	releaseSubject,
	type FileChange,
	type ReleaseOptions,
} from '../release.js';
import type {
	ChamojiConfig,
	ParsedCommit,
	Release,
	SemverBump,
} from '../types.js';
import {bumpFor} from '../version.js';
import {attribute, releaseTargets} from './attribute.js';
import {readStyle, renderUnitSection, writeUnitChangelog} from './notes.js';
import type {ReleaseSettings} from './settings.js';
import {renderTag, unitTagHistory, type UnitTag} from './tags.js';
import {
	readUpstream,
	sinceRange,
	syncFiles,
	type Upstream,
} from './upstream.js';
import {editVersionFiles, readEasRemote} from './version-files.js';
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
	bump: SemverBump | 'prerelease' | 'first' | 'calver' | 'fixed';
	own: number;
	shared: number;
	/** The new section of the unit's changelog. */
	notes: string;
	/** The files this unit's release changes. */
	files: string[];
	/** Version files whose old value differed from the last tag. */
	disagreed: string[];
	/** Released by `Release:` or `--unit` with only shared commits. */
	forced: boolean;
};

export type UnitPending = {unit: string; own: number; shared: number};

export type UnitReleasePlan =
	| {status: 'nothing'; pending: UnitPending[]}
	| {
			status: 'ready';
			/** Repository root; `changes` paths are relative to it. */
			root: string;
			/** In dependency order: a unit others depend on comes first. */
			units: UnitPlan[];
			/** Units not releasing that have shared commits waiting. */
			pending: UnitPending[];
			changes: FileChange[];
			subject: string;
			/** HEAD before the release, for rolling back. */
			start: string;
			warnings: string[];
			/** One line per excluded path whose commits are left out. */
			excludedNote?: string;
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
	const settings = config.release;
	if (!settings || settings.units.length === 0) {
		throw new Error(
			'no release units are set up; add them under release.units in chamoji.config.json',
		);
	}

	const names = settings.units.map(unit => unit.name);
	for (const name of [
		...(options.units ?? []),
		...Object.keys(options.versions ?? {}),
	]) {
		if (!names.includes(name)) {
			throw new Error(
				`unknown unit "${name}"; the units are ${names.join(', ')}`,
			);
		}
	}

	const {root, warnings} = await preflight(options);
	const git = async (...args: string[]) => (await runGit(args, root)).trim();
	const packages = await readWorkspace(root);
	const units = dependencyOrder(resolveUnits(settings, packages));
	const tags = await listTags(root, 'HEAD');
	const today = options.today ?? new Date().toISOString().slice(0, 10);

	// Read once for the whole plan: it covers every unit's window.
	const upstream = await readUpstream(root, 'HEAD', settings, tags);
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
		const sorted = attribute(
			read.commits,
			read.files,
			unit,
			units,
			packages,
			settings,
		);
		const own = [...sorted.own];
		for (const sync of upstream.syncs) {
			if (!read.position.has(sync.hash)) continue;
			const files = await reader.syncFiles(sync);
			if (files.some(file => ownsFile(file, unit, units, packages, settings))) {
				own.push(sync);
			}
		}

		const byPosition = (a: ParsedCommit, b: ParsedCommit) =>
			read.position.get(a.hash)! - read.position.get(b.hash)!;
		windows.push({
			unit,
			history,
			last,
			own: own.sort(byPosition),
			shared: sorted.shared,
			root: sorted.root,
			targeted: read.commits.some(commit =>
				releaseTargets(commit, [unit.name]).includes(unit.name),
			),
			position: read.position,
		});
	}

	const reasons = decide(windows, settings, options);
	const pending = windows
		.filter(window => !reasons.has(window.unit.name))
		.filter(window => window.shared.length > 0)
		.map(window => ({
			unit: window.unit.name,
			own: window.own.length,
			shared: window.shared.length,
		}));
	if (reasons.size === 0) {
		return {status: 'nothing', pending};
	}

	const releasing = windows.filter(window => reasons.has(window.unit.name));
	const current = new Map(
		windows.map(window => [
			window.unit.name,
			window.last?.version ?? window.unit.pkg?.version ?? null,
		]),
	);
	const versions = workOutVersions(
		releasing,
		reasons,
		units,
		current,
		settings,
		options,
		today,
	);

	const tagOf = new Map<string, string>();
	for (const {unit} of releasing) {
		const tag = renderTag(unit.tag, {
			unit: unit.name,
			name: unit.pkg?.name ?? '',
			version: versions.get(unit.name)!.version,
		});
		if (await git('tag', '--list', tag)) {
			throw new ReleaseError(
				'tag-exists',
				`tag ${tag} already exists, though not on this branch; pick another version`,
			);
		}

		tagOf.set(unit.name, tag);
	}

	const start = await git('rev-parse', 'HEAD');
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
		const {plan, changes: unitChanges} = await planUnit(
			window,
			tagOf.get(window.unit.name)!,
			reasons.get(window.unit.name) === 'forced',
			{
				root,
				config,
				settings,
				units,
				versions,
				current,
				today,
				start,
				repositoryUrl: config.repositoryUrl ?? (await getRemoteWebUrl(root)),
			},
		);
		for (const change of unitChanges) add(window.unit.name, change);
		plans.push(plan);
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
	return {
		status: 'ready',
		root,
		units: plans,
		pending,
		changes,
		subject: releaseSubject(
			(await git('log', '-30', '--no-merges', '--format=%s')).split('\n'),
			plans.map(plan => plan.tag).join(', '),
		),
		start,
		warnings,
		...(excludedNote ? {excludedNote} : {}),
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
		for (const {tag} of plan.units) {
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

/** Pushes HEAD and every unit tag, by name, to origin in one push. A failure keeps the local release. */
export async function pushUnitReleases(
	plan: ReadyUnitPlan,
	env?: Record<string, string>,
): Promise<void> {
	const tags = plan.units.map(unit => unit.tag);
	try {
		await runGit(
			['push', '--quiet', 'origin', 'HEAD', ...tags],
			plan.root,
			env,
		);
	} catch (error) {
		throw new Error(
			`released ${tags.join(', ')} locally, but the push failed; the release commit and tags are kept:\n${gitMessage(error)}`,
		);
	}
}

const SECTION_ADDED =
	'new section added above the previous release; older entries untouched';

/** Units whose packages another unit depends on come first; otherwise config order. */
function dependencyOrder(units: ResolvedUnit[]): ResolvedUnit[] {
	const done = new Set<string>();
	const visiting = new Set<string>();
	const ordered: ResolvedUnit[] = [];
	const visit = (unit: ResolvedUnit) => {
		if (done.has(unit.name) || visiting.has(unit.name)) return;
		visiting.add(unit.name);
		for (const dep of dependencies(unit, units)) visit(dep);
		visiting.delete(unit.name);
		done.add(unit.name);
		ordered.push(unit);
	};

	for (const unit of units) visit(unit);
	return ordered;
}

/** The units whose packages `unit`'s package has as runtime dependencies. */
function dependencies(
	unit: ResolvedUnit,
	units: ResolvedUnit[],
): ResolvedUnit[] {
	const deps = new Set(unit.pkg?.runtimeDeps ?? []);
	return units.filter(
		other => other !== unit && other.pkg && deps.has(other.pkg.name),
	);
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

type Read = {
	/** Non-merge commits, upstream ones left out, newest first. */
	commits: ParsedCommit[];
	files: Map<string, string[]>;
	/** Every commit's position in the range, merges included when there are syncs. */
	position: Map<string, number>;
};

/**
 * Reads windows, once per range. A commit in several windows is parsed once,
 * so a classifier's picks reach every unit.
 */
function windowReader(root: string, upstream: Upstream) {
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
 * Which units release, and why. Own commits that imply a bump, `--unit`,
 * `versions` or a `Release:` trailer release a unit; under
 * release-dependents so do shared commits and a released dependency. A
 * fixed group releases together. `--unit` limits all but fixed groups.
 */
function decide(
	windows: Window[],
	settings: ReleaseSettings,
	options: UnitReleaseOptions,
): Map<string, Reason> {
	const only = options.units?.length ? new Set(options.units) : null;
	const named = new Set([
		...(options.units ?? []),
		...Object.keys(options.versions ?? {}),
	]);
	const dependents = settings.sharedChanges === 'release-dependents';
	const reasons = new Map<string, Reason>();
	for (const {unit, own, shared, targeted} of windows) {
		if (only && !only.has(unit.name)) continue;
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
				if (!reasons.has(name)) {
					reasons.set(name, 'fixed');
					changed = true;
				}
			}
		}

		if (!dependents) continue;
		for (const unit of units) {
			if (reasons.has(unit.name) || (only && !only.has(unit.name))) continue;
			if (dependencies(unit, units).some(dep => reasons.has(dep.name))) {
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
			dependencies(unit, units).some(dep => reasons.has(dep.name));
		const month = `${Number(today.slice(0, 4))}.${Number(today.slice(5, 7))}.`;
		const version = nextUnitVersion({
			unit,
			last,
			manifestVersion: unit.pkg?.version ?? null,
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

type UnitContext = {
	root: string;
	config: ChamojiConfig;
	settings: ReleaseSettings;
	units: ResolvedUnit[];
	versions: Map<string, Exclude<NextVersion, null>>;
	current: Map<string, string | null>;
	today: string;
	/** HEAD, which the release commit goes on top of. */
	start: string;
	repositoryUrl: string | undefined;
};

/**
 * One releasing unit's notes and file changes: its changelog, then its
 * version files, with any dependency ranges set in its package.json.
 */
async function planUnit(
	window: Window,
	tag: string,
	forced: boolean,
	context: UnitContext,
): Promise<{plan: UnitPlan; changes: FileChange[]}> {
	const {root, config, settings, versions, current, today} = context;
	const {unit, last} = window;
	const {version, bump} = versions.get(unit.name)!;
	const manifest = path.posix.join(unit.path, 'package.json');
	const manifestText = await readText(root, manifest);
	const updates = rangeUpdates(
		unit,
		context.units,
		declaredDependencies(manifestText),
		versions,
		current,
	);

	const noted = [...window.own, ...window.shared].sort(
		(a, b) => window.position.get(a.hash)! - window.position.get(b.hash)!,
	);
	for (const update of updates) {
		noted.push(dependencyCommit(update.name, update.version, context.start));
	}

	const release: Release = {
		...(await buildRelease(
			root,
			config,
			{version, tag, previousTag: last?.tag ?? null, date: today},
			noted,
			'HEAD',
			true,
		)),
		nextVersion: null,
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
		current: current.get(unit.name) ?? null,
		buildNumber: unit.buildNumber,
		easRemote: await readEasRemote(root, unit.path),
	});
	const ranged = updates.filter(update => update.range !== null);
	const withRanges = (text: string) =>
		ranged.reduce(
			(next, update) =>
				setDependencyRange(next, update.name, update.range!) ??
				missingRange(manifest, update.name),
			text,
		);
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
			bump,
			own: window.own.length,
			shared: window.shared.length,
			notes,
			files: changes.map(change => change.file),
			disagreed: last
				? edits
						.filter(edit => edit.from !== null && edit.from !== last.version)
						.map(edit => edit.file)
				: [],
			forced,
		},
		changes,
	};
}

type RangeUpdate = {
	/** The dependency's package name. */
	name: string;
	/** Its version in this release, for the Dependencies line. */
	version: string;
	/** The new range for `dependencies`, or null to leave it as written. */
	range: string | null;
};

/**
 * What a releasing unit's notes and manifest say about the units it depends
 * on: every dependency releasing now gets a Dependencies line and, when it
 * is in `dependencies`, a `^<version>` range, unless its range is a
 * `workspace:` one, which pnpm rewrites when it publishes. Peer ranges are
 * left as written. A dependency that isn't releasing changes the range only
 * when the range no longer accepts its current version.
 */
function rangeUpdates(
	unit: ResolvedUnit,
	units: ResolvedUnit[],
	declared: Record<string, string>,
	versions: Map<string, Exclude<NextVersion, null>>,
	current: Map<string, string | null>,
): RangeUpdate[] {
	const updates: RangeUpdate[] = [];
	for (const dep of dependencies(unit, units)) {
		const name = dep.pkg!.name;
		const written = declared[name];
		const releasing = versions.get(dep.name)?.version;
		const version = releasing ?? current.get(dep.name) ?? null;
		if (version === null) continue;
		const range =
			written === undefined || written.startsWith('workspace:')
				? null
				: `^${version}`;
		if (releasing !== undefined) {
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

/** The Dependencies line for a dependency's new version. `at` is the commit the release is made on. */
function dependencyCommit(
	name: string,
	version: string,
	at: string,
): ParsedCommit {
	return parseCommit({
		hash: at,
		shortHash: at.slice(0, 7),
		authorName: '',
		authorEmail: '',
		date: '',
		subject: `⬆️ Bump ${name} to ${version}`,
		body: '',
		trailers: '',
	});
}

function missingRange(file: string, name: string): never {
	throw new ReleaseError(
		'invalid-version',
		`can't set the range of ${name} in ${file}: it isn't in "dependencies"`,
	);
}

/**
 * `text` with the top-level `dependencies[name]` set to `range`, edited as
 * text so formatting survives; null when the package.json doesn't list it.
 */
export function setDependencyRange(
	text: string,
	name: string,
	range: string,
): string | null {
	const colon = /\s*:/y;
	let depth = 0;
	let inDependencies = false;
	let key: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') {
				end += text[end] === '\\' ? 2 : 1;
			}

			end++;
			colon.lastIndex = end;
			if (colon.test(text)) {
				key = JSON.parse(text.slice(i, end)) as string;
				i = colon.lastIndex - 1;
			} else if (inDependencies && depth === 2 && key === name) {
				return `${text.slice(0, i)}${JSON.stringify(range)}${text.slice(end)}`;
			} else {
				i = end - 1;
			}
		} else if (ch === '{' || ch === '[') {
			depth++;
			if (ch === '{' && depth === 2 && key === 'dependencies') {
				inDependencies = true;
			}
		} else if (ch === '}' || ch === ']') {
			if (depth === 2) inDependencies = false;
			depth--;
		}
	}

	return null;
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

async function readText(root: string, file: string): Promise<string | null> {
	try {
		return await readFile(path.join(root, file), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
