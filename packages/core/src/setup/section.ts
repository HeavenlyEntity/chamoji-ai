import {isDeepStrictEqual} from 'node:util';
import {CONFIG_FILE} from '../config.js';
import {renderJson} from '../json-text.js';
import {
	parseReleaseSettings,
	UNIT_ONLY,
	type ReleaseSettings,
} from '../units/settings.js';
import type {SetupAnswers} from './answers.js';

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const keys = (...names: string[]): Obj =>
	Object.fromEntries(names.map(name => [name, true]));

/** Keys setup asks about; the rest of a section is kept as written. */
const ASKED: Obj = {
	...keys('schema', 'shape', 'exclude', 'sharedChanges', 'rootFiles'),
	...keys('zeroMajor', 'fixed', 'upstream', 'rootChangelog'),
	units: {
		'*': keys(
			'path',
			'tag',
			'read',
			'versionFiles',
			'buildNumber',
			'firstVersion',
			'versioning',
		),
	},
	tags: {ignore: true},
};

/** What's left of a `release` section once the keys setup asks about are taken out. */
export function unasked(value: Obj, asked: Obj = ASKED): Obj {
	const rest: Obj = {};
	for (const [key, item] of Object.entries(value)) {
		const rule = Object.hasOwn(asked, key) ? asked[key] : asked['*'];
		if (rule === true) continue;
		if (isObject(rule) && isObject(item)) {
			const inner = unasked(item, rule);
			if (Object.keys(inner).length > 0) rest[key] = inner;
		} else {
			rest[key] = item;
		}
	}

	return rest;
}

/** The `release` section for chamoji.config.json, defaults left out. */
export function releaseSection(answers: SetupAnswers): Record<string, unknown> {
	const section: Obj = {schema: 1, shape: answers.shape};
	if (answers.shape !== 'single') {
		const units: Obj = {};
		for (const unit of answers.units) {
			units[unit.name] = {
				path: unit.path,
				// {unit} resolved, {name} and {version} kept (R9).
				tag: unit.tag.replaceAll('{unit}', unit.name),
				...(unit.read.length > 0 ? {read: unit.read} : {}),
				...(unit.versionFiles.length > 0
					? {versionFiles: unit.versionFiles}
					: {}),
				// An EAS app always says what happens to its build numbers (R2).
				...(unit.buildNumber !== 'untouched' || unit.eas
					? {buildNumber: unit.buildNumber}
					: {}),
				...(unit.firstVersion ? {firstVersion: unit.firstVersion} : {}),
				...(unit.versioning === 'semver' ? {} : {versioning: unit.versioning}),
			};
		}

		Object.assign(section, {
			units,
			exclude: answers.exclude,
			sharedChanges: answers.sharedChanges,
			rootFiles: answers.rootFiles,
			...(answers.zeroMajor ? {zeroMajor: answers.zeroMajor} : {}),
			...(answers.fixed.length > 0 ? {fixed: answers.fixed} : {}),
			...(answers.upstream ? {upstream: answers.upstream} : {}),
			...(answers.ignore.length > 0 ? {tags: {ignore: answers.ignore}} : {}),
			...(answers.rootChangelog ? {rootChangelog: true} : {}),
		});
	}

	return merge(section, keptFor(answers));
}

/**
 * Kept settings, less any for a unit that is no longer one, and less every
 * unit-only setting when the shape is single.
 */
function keptFor(answers: SetupAnswers): Obj {
	const copy = structuredClone(answers.kept);
	const names = new Set(answers.units.map(unit => unit.name));
	if (answers.shape === 'single') {
		for (const key of [...UNIT_ONLY, 'units']) delete copy[key];
		return copy;
	}

	if (isObject(copy.units)) {
		for (const name of Object.keys(copy.units)) {
			if (!names.has(name)) delete copy.units[name];
		}

		if (Object.keys(copy.units).length === 0) delete copy.units;
	}

	const {tags} = copy;
	if (isObject(tags) && isObject(tags.aliases)) {
		for (const [tag, alias] of Object.entries(tags.aliases)) {
			if (isObject(alias) && !names.has(alias.unit as string)) {
				delete tags.aliases[tag];
			}
		}

		if (Object.keys(tags.aliases).length === 0) delete tags.aliases;
		if (Object.keys(tags).length === 0) delete copy.tags;
	}

	return copy;
}

/** `extra` folded into `base`: objects merge, and `base` wins on a clash. */
function merge(base: Obj, extra: Obj): Obj {
	for (const [key, value] of Object.entries(extra)) {
		if (isObject(base[key]) && isObject(value)) {
			base[key] = merge({...base[key]}, value);
		} else if (!Object.hasOwn(base, key)) {
			base[key] = value;
		}
	}

	return base;
}

/** `next` with its object keys in `previous`'s order where both have them. */
function orderLike(next: unknown, previous: unknown): unknown {
	if (!isObject(next) || !isObject(previous)) return next;
	const order = [
		...Object.keys(previous).filter(key => Object.hasOwn(next, key)),
		...Object.keys(next).filter(key => !Object.hasOwn(previous, key)),
	];
	return Object.fromEntries(
		order.map(key => [key, orderLike(next[key], previous[key])]),
	);
}

/** Parsed settings with `{unit}` resolved, as the engine reads them. */
function canonical(value: unknown): ReleaseSettings {
	const settings = parseReleaseSettings(value, CONFIG_FILE);
	return {
		...settings,
		units: settings.units.map(unit => ({
			...unit,
			tag: unit.tag.replaceAll('{unit}', unit.name),
			read: unit.read.map(template => template.replaceAll('{unit}', unit.name)),
		})),
	};
}

/**
 * Whether two sections mean the same: the same settings once the engine has
 * filled in its defaults, and the same hand-written keys setup doesn't ask
 * about. An invalid section means nothing the same as anything.
 */
function sameMeaning(next: Obj, previous: unknown): boolean {
	try {
		return (
			isObject(previous) &&
			isDeepStrictEqual(canonical(next), canonical(previous)) &&
			isDeepStrictEqual(unasked(next), unasked(previous))
		);
	} catch {
		return false;
	}
}

/**
 * chamoji.config.json's text parsed, as setup reads and writes it: `data` is
 * the whole object (empty for a missing or blank file), `release` its
 * section, undefined when there's none. Throws for invalid JSON and for
 * anything but an object.
 */
export function readReleaseSection(original: string | null): {
	data: Obj;
	release: unknown;
} {
	const body = (original ?? '').replace(/^\uFEFF/, '');
	if (body.trim() === '') return {data: {}, release: undefined};
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new Error(
			`${CONFIG_FILE} isn't valid JSON: ${(error as Error).message}`,
		);
	}

	if (!isObject(parsed)) {
		throw new Error(`${CONFIG_FILE} isn't a JSON object`);
	}

	return {
		data: parsed,
		release: Object.hasOwn(parsed, 'release') ? parsed.release : undefined,
	};
}

/**
 * chamoji.config.json's text with `release` set and every other key kept, in
 * the file's own indent, number spelling and final newline. A file whose
 * section already means the same is left exactly as it is.
 */
export function writeReleaseSection(
	original: string | null,
	section: Record<string, unknown>,
): {text: string; changed: boolean} {
	const {data} = readReleaseSection(original);
	if (
		original !== null &&
		Object.hasOwn(data, 'release') &&
		sameMeaning(section, data.release)
	) {
		return {text: original, changed: false};
	}

	data.release = orderLike(section, data.release);
	const text = renderJson(data, original ?? '');
	return {text, changed: text !== original};
}
