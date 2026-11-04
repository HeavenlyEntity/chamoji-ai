import semver from 'semver';
import {listTags, runGit, runGitWithInput, type ReleaseTag} from '../git.js';
import {renderTag, versionFromTag} from '../units/tags.js';
import {VERSION_LIKE} from '../units/upstream.js';
import type {LayoutDetection, UnitFacts} from './detect.js';

export type UnitTagFormats = {
	/** The recommended template. */
	write: string;
	/** Other formats its old tags use. */
	read: string[];
	last: {tag: string; version: string} | null;
	/** Tags naming the unit with no version. */
	unparseable: string[];
	/** The last tag's version isn't the manifest version. */
	manifestDisagrees: boolean;
};

export type TagDetection = {
	/** `patterns` are `tags.ignore` regexes; `examples` the 3 newest tags. */
	inherited: {tags: string[]; patterns: string[]; examples: string[]};
	/** e.g. wip/* -> '^wip/'. */
	stray: {tags: string[]; patterns: string[]};
	perUnit: Record<string, UnitTagFormats>;
};

const FIELD = '\u001F';
const RECENT_COMMITS = 50;
const MAX_EXAMPLES = 3;
// What setup strips from the end of a tag to find its prefix.
const TRAILING_VERSION = /v?\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;
// Rendered into each unit's write template, so no ignore pattern hides the
// unit's next release either.
const SAMPLE_VERSION = '1.0.0';

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactPattern = (tag: string): string => `^${escapeRegExp(tag)}$`;

/** '4.0.1' -> '^\d+\.\d+\.\d+$'. */
const shapeOf = (tag: string): string =>
	`^${escapeRegExp(tag).replace(/\d+/g, String.raw`\d+`)}$`;

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const matchesAny = (pattern: string, tags: string[]): boolean => {
	const regex = new RegExp(pattern);
	return tags.some(tag => regex.test(tag));
};

async function hasHead(root: string): Promise<boolean> {
	try {
		await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root);
		return true;
	} catch {
		return false;
	}
}

async function sharesHistory(root: string, commit: string): Promise<boolean> {
	try {
		await runGit(['merge-base', 'HEAD', commit], root);
		return true;
	} catch {
		return false;
	}
}

/** 'upstream' when it exists; else a remote other than origin whose fetched refs share history with HEAD; else null. Task 3 uses it too. */
export async function findUpstreamRemote(root: string): Promise<string | null> {
	const remotes = lines(await runGit(['remote'], root));
	if (remotes.includes('upstream')) return 'upstream';
	if (!(await hasHead(root))) return null;
	for (const remote of remotes.sort()) {
		if (remote === 'origin') continue;
		const commits = lines(
			await runGit(
				['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}`],
				root,
			),
		);
		for (const commit of unique(commits)) {
			if (await sharesHistory(root, commit)) return remote;
		}
	}

	return null;
}

/** Each tag's commit, peeled through annotated tags. */
async function tagCommits(root: string): Promise<Map<string, string>> {
	const out = await runGit(
		[
			'for-each-ref',
			'--format=%(refname:strip=2)%1f%(objectname)%1f%(*objectname)',
			'refs/tags',
		],
		root,
	);
	const commits = new Map<string, string>();
	for (const line of lines(out)) {
		const [name, direct, peeled] = line.split(FIELD) as [
			string,
			string,
			string,
		];
		commits.set(name, peeled || direct);
	}

	return commits;
}

type Author = {name: string; email: string};

const parseAuthors = (out: string): Author[] =>
	lines(out).map(line => {
		const [name = '', email = ''] = line.split(FIELD);
		return {name, email: email.toLowerCase()};
	});

/**
 * Version-like tags none of whose commits a recent author wrote. Recent
 * authors wrote the newest 50 non-merge commits on HEAD that no version-like
 * tag reaches; when every commit is tagged, the newest 50 non-merge commits.
 */
async function inheritedByAuthors(
	root: string,
	candidates: string[],
	commitOf: Map<string, string>,
): Promise<Set<string>> {
	const log = [
		'log',
		'--no-merges',
		`--max-count=${RECENT_COMMITS}`,
		'--format=%an%x1f%ae',
	];
	// Tag names go in on stdin, so there is no limit on how many.
	const input = ['HEAD', ...candidates.map(name => `^refs/tags/${name}`)]
		.map(rev => `${rev}\n`)
		.join('');
	let recent = parseAuthors(
		await runGitWithInput([...log, '--stdin'], root, input),
	);
	if (recent.length === 0) {
		recent = parseAuthors(await runGit([...log, 'HEAD'], root));
	}

	if (recent.length === 0) return new Set();

	const names = new Set(recent.map(author => author.name));
	const emails = new Set(recent.map(author => author.email));
	// Parents come before children, so each commit knows whether a recent
	// author wrote it or any of its ancestors.
	const graph = await runGit(
		[
			'log',
			'--topo-order',
			'--reverse',
			'--format=%H%x1f%P%x1f%an%x1f%ae',
			'HEAD',
		],
		root,
	);
	const touched = new Map<string, boolean>();
	for (const line of lines(graph)) {
		const [hash, parents, name, email] = line.split(FIELD) as [
			string,
			string,
			string,
			string,
		];
		touched.set(
			hash,
			names.has(name) ||
				emails.has(email.toLowerCase()) ||
				parents.split(' ').some(parent => touched.get(parent) === true),
		);
	}

	return new Set(
		candidates.filter(name => touched.get(commitOf.get(name) ?? '') === false),
	);
}

/** Version-like tags from the upstream remote, or else from no recent author. */
async function findInherited(
	root: string,
	candidates: string[],
	remote: string | null,
): Promise<Set<string>> {
	if (candidates.length === 0) return new Set();
	const commitOf = await tagCommits(root);
	if (remote) {
		const reachable = new Set(
			lines(
				await runGit(['rev-list', `--glob=refs/remotes/${remote}/*`], root),
			),
		);
		// A remote with nothing fetched falls back to the authors rule.
		if (reachable.size > 0) {
			return new Set(
				candidates.filter(name => reachable.has(commitOf.get(name) ?? '')),
			);
		}
	}

	return inheritedByAuthors(root, candidates, commitOf);
}

type ReadTag = {
	tag: ReleaseTag;
	unit: UnitFacts | null;
	/** `<prefix>{version}`, or null when the tag has no trailing version. */
	template: string | null;
	version: string | null;
};

/** The unit names a tag prefix can carry: the short name and the package name without its scope. */
function unitNames(layout: LayoutDetection, unit: UnitFacts): string[] {
	const pkg = layout.packages.find(each => each.path === unit.path);
	const bare = pkg?.name.replace(/^@[^/]+\//, '');
	return unique([unit.name, bare].filter(Boolean) as string[]);
}

const packageName = (layout: LayoutDetection, unit: UnitFacts): string =>
	layout.packages.find(each => each.path === unit.path)?.name ?? '';

/** The unit a prefix names (the longest name wins), on separator boundaries, ignoring case. */
function unitNamedBy(
	prefix: string,
	names: Array<{unit: UnitFacts; name: string}>,
): UnitFacts | null {
	let best: {unit: UnitFacts; name: string} | null = null;
	for (const entry of names) {
		const named = new RegExp(
			`(?:^|[^a-z0-9])${escapeRegExp(entry.name)}(?:[^a-z0-9]|$)`,
			'i',
		).test(prefix);
		if (named && (!best || entry.name.length > best.name.length)) best = entry;
	}

	return best?.unit ?? null;
}

function readTag(
	layout: LayoutDetection,
	tag: ReleaseTag,
	names: Array<{unit: UnitFacts; name: string}>,
): ReadTag {
	const found = TRAILING_VERSION.exec(tag.name);
	const prefix = found ? tag.name.slice(0, found.index) : tag.name;
	const unit = unitNamedBy(prefix, names);
	if (!found || !unit) return {tag, unit, template: null, version: null};
	const template = `${prefix}${found[0].startsWith('v') ? 'v' : ''}{version}`;
	const version = versionFromTag(tag.name, template, {
		unit: unit.name,
		name: packageName(layout, unit),
	});
	return {tag, unit, template, version};
}

type Release = {tag: string; version: string; template: string};

function formatsFor(
	unit: UnitFacts,
	releases: Release[],
	unparseable: string[],
	write: string | undefined,
	fallback: string,
): UnitTagFormats {
	// Newest version first; tags are already newest first, and sort is stable.
	const sorted = [...releases].sort((a, b) =>
		semver.rcompare(a.version, b.version),
	);
	const last = sorted[0];
	const template = write ?? last?.template ?? fallback;
	const manifest =
		unit.version === null
			? null
			: (semver.coerce(unit.version, {includePrerelease: true})?.version ??
				unit.version);
	return {
		write: template,
		read: unique(sorted.map(release => release.template)).filter(
			each => each !== template,
		),
		last: last ? {tag: last.tag, version: last.version} : null,
		unparseable,
		manifestDisagrees:
			last !== undefined && manifest !== null && manifest !== last.version,
	};
}

/** Ignore patterns for `tags`: one per shape unless the shape would hide a tag in `keep`. */
function shapePatterns(tags: string[], keep: string[]): string[] {
	const byShape = new Map<string, string[]>();
	for (const tag of tags) {
		const shape = shapeOf(tag);
		byShape.set(shape, [...(byShape.get(shape) ?? []), tag]);
	}

	const patterns: string[] = [];
	for (const [shape, members] of byShape) {
		if (matchesAny(shape, keep)) patterns.push(...members.map(exactPattern));
		else patterns.push(shape);
	}

	return unique(patterns).sort();
}

/** `^<first segment>/` for tags with a `/`, the exact tag otherwise; exact when a prefix would hide a tag in `keep`. */
function strayPatterns(tags: string[], keep: string[]): string[] {
	const patterns: string[] = [];
	for (const tag of tags) {
		const slash = tag.indexOf('/');
		const prefix =
			slash > 0 ? `^${escapeRegExp(tag.slice(0, slash + 1))}` : undefined;
		patterns.push(
			prefix && !matchesAny(prefix, keep) ? prefix : exactPattern(tag),
		);
	}

	return unique(patterns).sort();
}

/** Inherited (template), stray and per-unit tags, with the ignore patterns and tag formats setup recommends. */
export async function detectTags(
	layout: LayoutDetection,
	upstreamRemote: string | null,
): Promise<TagDetection> {
	const {root, units} = layout;
	const tags = (await hasHead(root)) ? await listTags(root, 'HEAD') : [];
	const inheritedSet = await findInherited(
		root,
		tags.map(tag => tag.name).filter(name => VERSION_LIKE.test(name)),
		upstreamRemote,
	);
	const inherited = tags
		.map(tag => tag.name)
		.filter(name => inheritedSet.has(name));
	const own = tags.filter(tag => !inheritedSet.has(tag.name));

	const names = units.flatMap(unit =>
		unitNames(layout, unit).map(name => ({unit, name})),
	);
	const read = own.map(tag => readTag(layout, tag, names));
	const stray = read
		.filter(each => !each.unit && !VERSION_LIKE.test(each.tag.name))
		.map(each => each.tag.name);

	// Libraries on one version that tag plain v{version} share those tags.
	const plain = read.filter(
		each => VERSION_LIKE.test(each.tag.name) && each.tag.name.startsWith('v'),
	);
	const published = layout.packages.filter(pkg => !pkg.private);
	const shared =
		layout.kind === 'libraries' &&
		plain.length > 0 &&
		published.length > 0 &&
		published.every(
			pkg => pkg.version !== null && pkg.version === published[0]!.version,
		);
	const fallback =
		layout.kind === 'libraries' ? '{name}@{version}' : '{unit}/v{version}';

	const perUnit: Record<string, UnitTagFormats> = {};
	for (const unit of units) {
		const mine = read.filter(each => each.unit === unit);
		const releases: Release[] = mine.flatMap(each =>
			each.template && each.version
				? [{tag: each.tag.name, version: each.version, template: each.template}]
				: [],
		);
		if (shared) {
			for (const each of plain) {
				const version = versionFromTag(each.tag.name, 'v{version}', {
					unit: unit.name,
					name: '',
				});
				if (version) {
					releases.push({tag: each.tag.name, version, template: 'v{version}'});
				}
			}
		}

		perUnit[unit.name] = formatsFor(
			unit,
			releases,
			mine.filter(each => !each.version).map(each => each.tag.name),
			shared ? 'v{version}' : undefined,
			fallback,
		);
	}

	// Tags and next releases that no ignore pattern may hide.
	const samples = units.flatMap(unit => {
		try {
			return [
				renderTag(perUnit[unit.name]!.write, {
					unit: unit.name,
					name: packageName(layout, unit),
					version: SAMPLE_VERSION,
				}),
			];
		} catch {
			return [];
		}
	});
	const ownNames = own.map(tag => tag.name);
	const strays = new Set(stray);

	return {
		inherited: {
			tags: inherited,
			patterns: shapePatterns(inherited, [...ownNames, ...samples]),
			examples: inherited.slice(0, MAX_EXAMPLES),
		},
		stray: {
			tags: stray,
			patterns: strayPatterns(stray, [
				...ownNames.filter(name => !strays.has(name)),
				...samples,
			]),
		},
		perUnit,
	};
}
