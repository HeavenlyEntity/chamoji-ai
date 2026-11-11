import semver from 'semver';
import {CONFIG_FILE} from '../config.js';
import {parseReleaseSettings} from '../units/settings.js';
import {matchesTagPattern} from '../units/tags.js';
import {detectLayout, type LayoutDetection, type UnitFacts} from './detect.js';
import {
	current,
	defaultTag,
	baseName,
	factsOf,
	isObject,
	lastSegment,
	questions,
	recommendedShape,
	SHARED_TAG,
	unique,
} from './questions.js';
import {releaseSection, unasked} from './section.js';
import {detectTags, findUpstreamRemote, type TagDetection} from './tags.js';
import {detectUpstream, type UpstreamDetection} from './upstream.js';

export type Detection = {
	layout: LayoutDetection;
	tags: TagDetection;
	upstream: UpstreamDetection;
};

/** Everything setup reads from the repo: layout, tags, then upstream history. */
export async function detect(root: string): Promise<Detection> {
	const layout = await detectLayout(root);
	const remote = await findUpstreamRemote(root);
	const tags = await detectTags(layout, remote);
	const upstream = await detectUpstream(root, remote, tags.inherited.tags, {
		canonical: tags.canonical,
	});
	return {layout, tags, upstream};
}

/** Where an answer came from, for `--explain`. */
export type Source = 'detected' | 'recommended' | 'chosen' | 'kept';

export type SetupAnswers = {
	shape: 'single' | 'apps' | 'libraries';
	units: Array<{
		name: string;
		path: string;
		tag: string;
		read: string[];
		versionFiles: string[];
		buildNumber: 'untouched' | 'increment';
		firstVersion?: string;
		versioning: 'semver' | 'calver';
		/** The app's EAS appVersionSource, from detection; never written to the config. */
		eas?: 'remote' | 'local';
	}>;
	exclude: string[];
	sharedChanges: 'ride-along' | 'release-dependents';
	rootFiles: 'none' | 'all' | 'note';
	zeroMajor?: 'minor';
	fixed: string[][];
	upstream?: {
		remote?: string;
		name: string;
		since?: string;
		/** Lower-cased and sorted. */
		authors?: string[];
	};
	ignore: string[];
	rootChangelog: boolean;
	/** Hand-written keys setup doesn't ask about, carried through as written. */
	kept: Record<string, unknown>;
	/** Keyed by question id. */
	why: Record<string, Source>;
};

type Unit = SetupAnswers['units'][number];
type Shape = SetupAnswers['shape'];

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
/** Ids whose recommended answer is read from the repo rather than chamoji's default. */
const DETECTED = new Set([
	'shape',
	'units',
	'ignore',
	'name',
	'tag',
	'versionFiles',
	'upstream.authors',
]);
/** Unit questions, answered in this order when answers are replayed. */
const UNIT_KINDS = new Set([
	'name',
	'tag',
	'firstVersion',
	'versionFiles',
	'buildNumber',
	'versioning',
]);

const byPath = (a: Unit, b: Unit): number =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const easOf = (facts?: UnitFacts): Pick<Unit, 'eas'> =>
	facts?.easLocal ? {eas: 'local'} : facts?.easRemote ? {eas: 'remote'} : {};

/** A unit as setup recommends it, from its facts and its tag formats. */
function unitFor(detection: Detection, facts: UnitFacts, shape: Shape): Unit {
	const {formats} = factsOf(detection, facts);
	return {
		name: facts.name,
		path: facts.path,
		// {unit} is resolved now, so a rename keeps the tag (ruling R9).
		tag: (formats?.write ?? defaultTag(shape)).replaceAll('{unit}', facts.name),
		read: formats?.read ?? [],
		versionFiles: facts.versionFiles,
		buildNumber: 'untouched',
		versioning: 'semver',
		// With no tag the manifest's version is the one to start from, when the
		// package.json and the manifest.xml disagree.
		...(facts.versionMismatch && !formats?.last
			? {firstVersion: facts.versionMismatch.manifest}
			: {}),
		...easOf(facts),
	};
}

/** The paths that can be units under a shape. */
const candidatePaths = (layout: LayoutDetection, shape: Shape): string[] =>
	shape === 'apps'
		? layout.apps.map(app => app.path)
		: shape === 'libraries'
			? layout.libraries.map(pkg => pkg.path)
			: [];

/** The recommended answer to every question, with no prompts. */
export function recommend(detection: Detection): SetupAnswers {
	return recommendFor(detection, recommendedShape(detection.layout));
}

function recommendFor(detection: Detection, shape: Shape): SetupAnswers {
	const {layout, tags, upstream} = detection;
	const ticked =
		shape === 'apps'
			? layout.apps.filter(app => app.ticked).map(app => app.path)
			: candidatePaths(layout, shape);
	const units = layout.candidates
		.filter(facts => ticked.includes(facts.path))
		.map(facts => unitFor(detection, facts, shape));
	const shared =
		shape === 'libraries' &&
		units.length > 1 &&
		units.every(unit => unit.tag === SHARED_TAG);
	const answers: SetupAnswers = {
		shape,
		units,
		exclude: shape === 'apps' ? [...layout.excluded] : [],
		sharedChanges: shape === 'libraries' ? 'release-dependents' : 'ride-along',
		rootFiles: 'none',
		...(units.some(unit => current(detection, unit)?.startsWith('0.'))
			? {zeroMajor: 'minor' as const}
			: {}),
		fixed: shared ? [units.map(unit => unit.name)] : [],
		...(shape !== 'single' && (upstream.remote || upstream.since)
			? {
					upstream: {
						...(upstream.remote ? {remote: upstream.remote} : {}),
						name: baseName(detection).name,
						...(upstream.since ? {since: upstream.since} : {}),
						...(upstream.authors.length > 0
							? {authors: upstream.authors.map(author => author.email)}
							: {}),
					},
				}
			: {}),
		ignore:
			shape === 'single'
				? []
				: [...tags.inherited.patterns, ...tags.stray.patterns],
		rootChangelog: false,
		kept: {},
		why: {},
	};
	answers.why = whyFor(detection, answers, id =>
		DETECTED.has(id.split(':')[0]!) ||
		(id === 'fixed' && shared) ||
		(id.startsWith('firstVersion:') &&
			units.some(
				unit => id === `firstVersion:${unit.name}` && unit.firstVersion,
			))
			? 'detected'
			: 'recommended',
	);
	return answers;
}

const whyFor = (
	detection: Detection,
	answers: SetupAnswers,
	source: (id: string) => Source,
): Record<string, Source> =>
	Object.fromEntries(
		questions(detection, answers).map(question => [
			question.id,
			source(question.id),
		]),
	);

/** Answers that reproduce an existing `release` section, for a re-run. */
export function answersFromSection(
	section: unknown,
	detection: Detection,
): SetupAnswers {
	const settings = parseReleaseSettings(section, CONFIG_FILE);
	const answers: SetupAnswers = {
		shape: settings.shape,
		units: settings.units.map(unit => ({
			name: unit.name,
			path: unit.path,
			tag: unit.tag,
			read: unit.read,
			versionFiles: unit.versionFiles,
			buildNumber: unit.buildNumber,
			...(unit.firstVersion ? {firstVersion: unit.firstVersion} : {}),
			versioning: unit.versioning,
			...easOf(factsOf(detection, unit).facts),
		})),
		exclude: settings.exclude,
		sharedChanges: settings.sharedChanges,
		rootFiles: settings.rootFiles,
		...(settings.zeroMajor ? {zeroMajor: settings.zeroMajor} : {}),
		fixed: settings.fixed,
		...(settings.upstream
			? {
					upstream: {
						...settings.upstream,
						...(settings.upstream.authors
							? {authors: sortedEmails(settings.upstream.authors)}
							: {}),
					},
				}
			: {}),
		ignore: settings.tags.ignore,
		rootChangelog: settings.rootChangelog,
		kept: unasked(section as Record<string, unknown>),
		why: {},
	};
	answers.why = whyFor(detection, answers, () => 'kept');
	return answers;
}

/** Emails as upstream.authors holds them: lower-cased, unique, sorted. */
const sortedEmails = (emails: string[]): string[] =>
	unique(emails.map(email => email.trim().toLowerCase())).sort();

const text = (id: string, value: string | string[]): string => {
	if (typeof value !== 'string') throw new Error(`${id} takes one value`);
	return value.trim();
};

const ticks = (id: string, value: string | string[]): string[] => {
	if (!Array.isArray(value)) throw new Error(`${id} takes a list`);
	return unique(value);
};

function oneOf<const T extends string>(
	id: string,
	value: string | string[],
	allowed: readonly T[],
): T {
	const given = text(id, value);
	if (!allowed.includes(given as T)) {
		throw new Error(`${id} must be one of ${allowed.join(', ')}`);
	}

	return given as T;
}

/** The answers with one question answered; throws when the engine would refuse the result. */
export function applyAnswer(
	detection: Detection,
	answers: SetupAnswers,
	id: string,
	value: string | string[],
): SetupAnswers {
	const colon = id.indexOf(':');
	const kind = colon === -1 ? id : id.slice(0, colon);
	const target = colon === -1 ? '' : id.slice(colon + 1);
	let next = structuredClone(answers);
	const unit = next.units.find(each => each.name === target);
	const needUnit = (): Unit => {
		if (!unit) throw new Error(`${id}: there's no unit named ${target}`);
		return unit;
	};

	let chosen = id;
	switch (kind) {
		case 'shape': {
			const shape = oneOf(id, value, ['single', 'apps', 'libraries']);
			next = recommendFor(detection, shape);
			next.kept = structuredClone(answers.kept);
			next = replay(detection, answers, next);
			break;
		}

		case 'units': {
			const paths = ticks(id, value);
			for (const gone of next.units.filter(
				each => !paths.includes(each.path),
			)) {
				if (next.shape === 'apps') next.exclude.push(gone.path);
				for (const key of Object.keys(next.why)) {
					if (key.endsWith(`:${gone.name}`)) delete next.why[key];
				}
			}

			next.exclude = unique(
				next.exclude.filter(path => !paths.includes(path)),
			).sort();
			const stay = next.units.filter(each => paths.includes(each.path));
			for (const path of paths) {
				if (stay.some(each => each.path === path)) continue;
				const facts = detection.layout.candidates.find(
					each => each.path === path,
				);
				const name = lastSegment(path);
				// A pattern that would hide the new unit's own tags goes.
				const last = facts && factsOf(detection, facts).formats?.last;
				if (last) {
					next.ignore = next.ignore.filter(
						pattern => !matchesTagPattern(last.tag, pattern),
					);
				}

				stay.push(
					facts
						? unitFor(detection, facts, next.shape)
						: {
								name,
								path,
								tag: defaultTag(next.shape).replaceAll('{unit}', name),
								read: [],
								versionFiles: [],
								buildNumber: 'untouched',
								versioning: 'semver',
							},
				);
			}

			next.units = stay.sort(byPath);
			const names = next.units.map(each => each.name);
			if (new Set(names).size !== names.length) {
				throw new Error(
					`${id}: two units would share a name; rename one first`,
				);
			}

			next.fixed = next.fixed
				.map(group => group.filter(name => names.includes(name)))
				.filter(group => group.length > 1);
			break;
		}

		case 'name': {
			const renamed = needUnit();
			const name = text(id, value);
			if (
				!NAME.test(name) ||
				next.units.some(each => each !== renamed && each.name === name)
			) {
				throw new Error(
					`A unit name must match ^[a-z0-9][a-z0-9._-]*$ and be unique; "${name}" doesn't`,
				);
			}

			rename(next, renamed.name, name);
			renamed.name = name;
			chosen = `name:${name}`;
			break;
		}

		case 'tag': {
			const changed = needUnit();
			const tag = text(id, value);
			// The unit's old tags keep counting after the format changes.
			if (tag !== changed.tag && factsOf(detection, changed).formats?.last) {
				changed.read = unique([...changed.read, changed.tag]);
			}

			changed.read = changed.read.filter(each => each !== tag);
			changed.tag = tag;
			break;
		}

		case 'firstVersion': {
			const changed = needUnit();
			const version = text(id, value);
			if (version === '') {
				delete changed.firstVersion;
			} else if (semver.valid(version)) {
				changed.firstVersion = version;
			} else {
				throw new Error(`${id} must be a version such as 1.0.0`);
			}

			break;
		}

		case 'versionFiles':
			needUnit().versionFiles = ticks(id, value);
			break;
		case 'buildNumber':
			needUnit().buildNumber = oneOf(id, value, ['untouched', 'increment']);
			break;
		case 'versioning':
			needUnit().versioning = oneOf(id, value, ['semver', 'calver']);
			break;
		case 'ignore':
			next.ignore = ticks(id, value);
			break;
		case 'upstream.name': {
			const name = text(id, value);
			if (!name) throw new Error(`${id} needs a name, such as Makerkit`);
			next.upstream = {...next.upstream, name};
			break;
		}

		case 'upstream.authors': {
			const authors = sortedEmails(ticks(id, value)).filter(Boolean);
			const upstream = {
				...(next.upstream ?? {name: baseName(detection).name}),
			};
			delete upstream.authors;
			next.upstream = authors.length > 0 ? {...upstream, authors} : upstream;
			break;
		}

		case 'sharedChanges':
			next.sharedChanges = oneOf(id, value, [
				'ride-along',
				'release-dependents',
			]);
			break;
		case 'rootFiles':
			next.rootFiles = oneOf(id, value, ['none', 'all', 'note']);
			break;
		case 'zeroMajor':
			if (oneOf(id, value, ['minor', 'major']) === 'minor') {
				next.zeroMajor = 'minor';
			} else {
				delete next.zeroMajor;
			}

			break;
		case 'fixed': {
			const group = ticks(id, value);
			const names = next.units.map(each => each.name);
			const unknown = group.find(name => !names.includes(name));
			if (unknown) throw new Error(`${id}: there's no unit named ${unknown}`);
			next.fixed = group.length > 1 ? [group] : [];
			break;
		}

		case 'rootChangelog':
			next.rootChangelog = oneOf(id, value, ['true', 'false']) === 'true';
			break;
		case 'alias':
			setAlias(detection, next, target, text(id, value));
			break;
		default:
			throw new Error(`There's no setup question ${id}`);
	}

	next.why[chosen] = 'chosen';
	parseReleaseSettings(releaseSection(next), CONFIG_FILE);
	return next;
}

/** The current answer to a question, in the form applyAnswer takes. */
function answerOf(
	answers: SetupAnswers,
	kind: string,
	unit: Unit | undefined,
): string | string[] | undefined {
	switch (kind) {
		case 'units':
			return answers.units.map(each => each.path);
		case 'name':
			return unit?.name;
		case 'tag':
			return unit?.tag;
		case 'firstVersion':
			return unit && (unit.firstVersion ?? '');
		case 'versionFiles':
			return unit?.versionFiles;
		case 'buildNumber':
			return unit?.buildNumber;
		case 'versioning':
			return unit?.versioning;
		case 'ignore':
			return answers.ignore;
		case 'upstream.name':
			return answers.upstream?.name;
		case 'upstream.authors':
			return answers.upstream?.authors ?? [];
		case 'sharedChanges':
			return answers.sharedChanges;
		case 'rootFiles':
			return answers.rootFiles;
		case 'zeroMajor':
			return answers.zeroMajor ?? 'major';
		case 'fixed':
			return answers.fixed[0] ?? [];
		case 'rootChangelog':
			return String(answers.rootChangelog);
		default:
			// Aliases live in `kept`, which is carried over whole.
			return undefined;
	}
}

/** The current answer to question `id`, in the form applyAnswer takes. */
export function currentAnswer(
	answers: SetupAnswers,
	id: string,
): string | string[] {
	const colon = id.indexOf(':');
	const kind = colon === -1 ? id : id.slice(0, colon);
	const target = colon === -1 ? '' : id.slice(colon + 1);
	if (kind === 'shape') return answers.shape;
	if (kind === 'alias') {
		const {tags} = answers.kept;
		const alias =
			isObject(tags) && isObject(tags.aliases) ? tags.aliases[target] : null;
		return isObject(alias) && typeof alias.version === 'string'
			? alias.version
			: '';
	}

	const unit = answers.units.find(each => each.name === target);
	return answerOf(answers, kind, unit) ?? '';
}

/**
 * `to` with the chosen and kept answers of `from` that still apply: units
 * first (when every one can be a unit under the new shape), then names,
 * then the rest. Unit answers follow the unit by path.
 */
function replay(
	detection: Detection,
	from: SetupAnswers,
	to: SetupAnswers,
): SetupAnswers {
	const rank = (id: string) =>
		id === 'units' ? 0 : id.startsWith('name:') ? 1 : 2;
	const ids = Object.entries(from.why)
		.filter(
			([id, source]) =>
				id !== 'shape' && (source === 'chosen' || source === 'kept'),
		)
		.sort(([a], [b]) => rank(a) - rank(b));
	const candidates = candidatePaths(detection.layout, to.shape);
	let next = to;
	for (const [id, source] of ids) {
		const colon = id.indexOf(':');
		const kind = colon === -1 ? id : id.slice(0, colon);
		const old = UNIT_KINDS.has(kind)
			? from.units.find(each => each.name === id.slice(colon + 1))
			: undefined;
		let target = id;
		if (UNIT_KINDS.has(kind)) {
			const now = old && next.units.find(each => each.path === old.path);
			if (!now) continue;
			target = `${kind}:${now.name}`;
		}

		const value = answerOf(from, kind, old);
		if (value === undefined) continue;
		if (
			kind === 'units' &&
			(value as string[]).some(path => !candidates.includes(path))
		) {
			continue;
		}

		try {
			next = applyAnswer(detection, next, target, value);
			next.why[kind === 'name' ? `name:${value as string}` : target] = source;
		} catch {
			// The answer no longer applies under the new shape.
		}
	}

	return next;
}

/** Moves what hangs off a unit's name: why keys, fixed groups and kept settings. */
function rename(answers: SetupAnswers, from: string, to: string): void {
	for (const [key, source] of Object.entries(answers.why)) {
		if (key.endsWith(`:${from}`)) {
			delete answers.why[key];
			answers.why[`${key.slice(0, -from.length)}${to}`] = source;
		}
	}

	answers.fixed = answers.fixed.map(group =>
		group.map(name => (name === from ? to : name)),
	);
	const {units, tags} = answers.kept;
	if (isObject(units) && Object.hasOwn(units, from)) {
		units[to] = units[from];
		delete units[from];
	}

	if (isObject(tags) && isObject(tags.aliases)) {
		for (const alias of Object.values(tags.aliases)) {
			if (isObject(alias) && alias.unit === from) alias.unit = to;
		}
	}
}

/** Records (or with '' drops) an alias for the unit whose tags detection couldn't read. */
function setAlias(
	detection: Detection,
	answers: SetupAnswers,
	tag: string,
	version: string,
): void {
	const tags = isObject(answers.kept.tags) ? answers.kept.tags : {};
	const aliases = isObject(tags.aliases) ? tags.aliases : {};
	if (version === '') {
		delete aliases[tag];
	} else {
		if (!semver.valid(version)) {
			throw new Error(`alias:${tag} must be a version such as 1.0.0`);
		}

		const unit = answers.units.find(each =>
			factsOf(detection, each).formats?.unparseable.includes(tag),
		);
		if (!unit) {
			throw new Error(
				`alias:${tag}: no unit has ${tag} as a tag without a version`,
			);
		}

		aliases[tag] = {unit: unit.name, version};
	}

	answers.kept.tags = {...tags, aliases};
}
