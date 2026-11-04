import path from 'node:path';
import {ConfigVersionError} from '../config.js';

export type Shape = 'single' | 'apps' | 'libraries';

export type UnitSettings = {
	/** The key in `units`. */
	name: string;
	/** '/'-separated, no trailing slash. */
	path: string;
	/** Tag template. */
	tag: string;
	/** Extra templates to read old tags with. */
	read: string[];
	versioning: 'semver' | 'calver';
	firstVersion?: string;
	versionFiles: string[];
	buildNumber: 'untouched' | 'increment';
	/** Path of this unit's CHANGELOG.md. */
	changelog: string;
};

export type ReleaseSettings = {
	schema: 1;
	shape: Shape;
	/** In config order. */
	units: UnitSettings[];
	/** Path globs, '/'-separated. */
	exclude: string[];
	sharedChanges: 'ride-along' | 'release-dependents';
	rootFiles: 'none' | 'all' | 'note';
	zeroMajor?: 'minor';
	fixed: string[][];
	upstream?: {remote?: string; name: string; since?: string};
	tags: {
		ignore: string[];
		aliases: Record<string, {unit: string; version: string}>;
	};
	rootChangelog: boolean;
	githubReleases: 'per-unit' | 'combined';
};

type Obj = Record<string, unknown>;

const SUPPORTED_SHAPES = ['single', 'apps', 'libraries'];
const UNSUPPORTED_SHAPES = ['train', 'mixed'];

/**
 * Validates the `release` section of chamoji.config.json and fills in the
 * defaults. Throws `ConfigVersionError` for a `schema` newer than this version
 * knows, and a plain `Error` starting `Invalid config <file>: release.` for
 * anything else.
 */
export function parseReleaseSettings(
	value: unknown,
	file: string,
): ReleaseSettings {
	const fail = (key: string, problem: string): never => {
		throw new Error(`Invalid config ${file}: release.${key} ${problem}`);
	};

	if (!isObject(value)) {
		throw new Error(`Invalid config ${file}: release must be an object`);
	}

	const {schema} = value;
	if (typeof schema === 'number' && Number.isInteger(schema) && schema > 1) {
		throw new ConfigVersionError(
			"this repo's release settings need chamoji 0.13.0 or newer",
		);
	}

	if (schema !== 1) {
		fail('schema', 'must be 1');
	}

	const {shape} = value;
	if (typeof shape === 'string' && UNSUPPORTED_SHAPES.includes(shape)) {
		fail(`shape "${shape}"`, "isn't supported yet; use apps or libraries");
	}

	if (typeof shape !== 'string' || !SUPPORTED_SHAPES.includes(shape)) {
		fail('shape', 'must be "single", "apps" or "libraries"');
	}

	const kind = shape as Shape;
	const units = parseUnits(value.units, kind, fail);
	const names = new Set(units.map(unit => unit.name));

	const exclude = stringList(value.exclude, 'exclude', fail).map(pattern =>
		pattern.replaceAll('\\', '/').replace(/\/+$/, ''),
	);

	const sharedChanges = oneOf(
		value.sharedChanges,
		['ride-along', 'release-dependents'] as const,
		kind === 'libraries' ? 'release-dependents' : 'ride-along',
		'sharedChanges',
		fail,
	);
	const rootFiles = oneOf(
		value.rootFiles,
		['none', 'all', 'note'] as const,
		'none',
		'rootFiles',
		fail,
	);
	const zeroMajor = oneOf(
		value.zeroMajor,
		['minor'] as const,
		undefined,
		'zeroMajor',
		fail,
	);

	const fixed = parseFixed(value.fixed, names, fail);
	const upstream = parseUpstream(value.upstream, fail);
	const tags = parseTags(value.tags, units, fail);

	const {rootChangelog} = value;
	if (rootChangelog !== undefined && typeof rootChangelog !== 'boolean') {
		fail('rootChangelog', 'must be true or false');
	}

	const githubReleases = oneOf(
		value.githubReleases,
		['per-unit', 'combined'] as const,
		'per-unit',
		'githubReleases',
		fail,
	);

	return {
		schema: 1,
		shape: kind,
		units,
		exclude,
		sharedChanges,
		rootFiles,
		...(zeroMajor ? {zeroMajor} : {}),
		fixed,
		...(upstream ? {upstream} : {}),
		tags,
		rootChangelog: rootChangelog === true,
		githubReleases,
	};
}

type Fail = (key: string, problem: string) => never;

function parseUnits(value: unknown, shape: Shape, fail: Fail): UnitSettings[] {
	if (value === undefined) {
		return [];
	}

	if (!isObject(value)) {
		return fail('units', 'must be an object of unit name to settings');
	}

	const entries = Object.entries(value);
	if (shape === 'single' && entries.length > 0) {
		fail('units', 'is not used with shape "single"');
	}

	return entries.map(([name, raw]) => {
		const key = `units.${name}`;
		if (!name || /[\s/]/.test(name)) {
			fail(
				'units',
				`name ${JSON.stringify(name)} must be non-empty, with no "/" or spaces`,
			);
		}

		if (!isObject(raw)) {
			fail(key, 'must be an object');
		}

		const unit = raw as Obj;
		if (typeof unit.path !== 'string') {
			fail(`${key}.path`, 'must be a string');
		}

		const unitPath = normalisePath(unit.path as string);
		if (unitPath === undefined) {
			fail(
				`${key}.path`,
				`${JSON.stringify(unit.path)} must be a folder inside the repo`,
			);
		}

		const tag =
			unit.tag ??
			(shape === 'libraries' ? '{name}@{version}' : '{unit}/v{version}');
		if (typeof tag !== 'string' || !tag.includes('{version}')) {
			fail(`${key}.tag`, 'must be a template containing {version}');
		}

		const read = stringList(unit.read, `${key}.read`, fail);
		for (const template of read) {
			if (!template.includes('{version}')) {
				fail(
					`${key}.read`,
					`template ${JSON.stringify(template)} must contain {version}`,
				);
			}
		}

		const versioning = oneOf(
			unit.versioning,
			['semver', 'calver'] as const,
			'semver',
			`${key}.versioning`,
			fail,
		);
		const {firstVersion} = unit;
		if (
			firstVersion !== undefined &&
			(typeof firstVersion !== 'string' || !firstVersion)
		) {
			fail(`${key}.firstVersion`, 'must be a non-empty string');
		}

		const versionFiles = stringList(
			unit.versionFiles,
			`${key}.versionFiles`,
			fail,
		).map(file => file.replaceAll('\\', '/'));
		const buildNumber = oneOf(
			unit.buildNumber,
			['untouched', 'increment'] as const,
			'untouched',
			`${key}.buildNumber`,
			fail,
		);

		let changelog = `${unitPath}/CHANGELOG.md`;
		if (unit.changelog !== undefined) {
			const given =
				typeof unit.changelog === 'string'
					? normalisePath(unit.changelog)
					: undefined;
			if (given === undefined) {
				fail(`${key}.changelog`, 'must be a file path inside the repo');
			}

			changelog = given as string;
		}

		return {
			name,
			path: unitPath as string,
			tag: tag as string,
			read,
			versioning,
			...(firstVersion ? {firstVersion: firstVersion as string} : {}),
			versionFiles,
			buildNumber,
			changelog,
		};
	});
}

function parseFixed(
	value: unknown,
	names: Set<string>,
	fail: Fail,
): string[][] {
	if (value === undefined) {
		return [];
	}

	if (
		!Array.isArray(value) ||
		!value.every(
			group =>
				Array.isArray(group) && group.every(item => typeof item === 'string'),
		)
	) {
		return fail('fixed', 'must be a list of lists of unit names');
	}

	const seen = new Set<string>();
	for (const group of value as string[][]) {
		for (const name of group) {
			if (!names.has(name)) {
				fail('fixed', `names unknown unit "${name}"`);
			}

			if (seen.has(name)) {
				fail('fixed', `names unit "${name}" more than once`);
			}

			seen.add(name);
		}
	}

	return value as string[][];
}

function parseUpstream(
	value: unknown,
	fail: Fail,
): ReleaseSettings['upstream'] {
	if (value === undefined) {
		return undefined;
	}

	if (!isObject(value)) {
		return fail('upstream', 'must be an object');
	}

	const {remote, name, since} = value;
	if (typeof name !== 'string' || !name) {
		fail('upstream.name', 'must be a non-empty string');
	}

	// Both reach git as arguments, so neither may read as an option.
	if (
		remote !== undefined &&
		(typeof remote !== 'string' || !remote || /^-|\s/.test(remote))
	) {
		fail(
			'upstream.remote',
			'must be a non-empty string without whitespace, not starting with "-"',
		);
	}

	if (
		since !== undefined &&
		(typeof since !== 'string' || !since || since.startsWith('-'))
	) {
		fail('upstream.since', 'must be a non-empty string not starting with "-"');
	}

	return {
		...(remote ? {remote: remote as string} : {}),
		name: name as string,
		...(since ? {since: since as string} : {}),
	};
}

function parseTags(
	value: unknown,
	units: UnitSettings[],
	fail: Fail,
): ReleaseSettings['tags'] {
	if (value !== undefined && !isObject(value)) {
		return fail('tags', 'must be an object');
	}

	const tags = (value ?? {}) as Obj;
	const ignore = stringList(tags.ignore, 'tags.ignore', fail);
	for (const pattern of ignore) {
		try {
			new RegExp(pattern);
		} catch {
			fail(
				'tags.ignore',
				`pattern ${JSON.stringify(pattern)} is not a valid regular expression`,
			);
		}
	}

	const aliases: ReleaseSettings['tags']['aliases'] = {};
	if (tags.aliases !== undefined) {
		if (!isObject(tags.aliases)) {
			fail('tags.aliases', 'must be an object of tag to version');
		}

		const names = new Set(units.map(unit => unit.name));
		for (const [tag, raw] of Object.entries(tags.aliases as Obj)) {
			if (typeof raw === 'string' && units.length === 1 && raw) {
				aliases[tag] = {unit: units[0]!.name, version: raw};
			} else if (
				isObject(raw) &&
				typeof raw.unit === 'string' &&
				typeof raw.version === 'string' &&
				raw.version
			) {
				if (!names.has(raw.unit)) {
					fail('tags.aliases', `tag "${tag}" names unknown unit "${raw.unit}"`);
				}

				aliases[tag] = {unit: raw.unit, version: raw.version};
			} else {
				fail(
					'tags.aliases',
					`tag "${tag}" must map to a version string (one unit) or {unit, version}`,
				);
			}
		}
	}

	return {ignore, aliases};
}

/** '/'-separated, relative, inside the repo, no trailing slash; else undefined. */
function normalisePath(raw: string): string | undefined {
	const slashed = raw.replaceAll('\\', '/');
	if (
		slashed.startsWith('/') ||
		/^[a-zA-Z]:/.test(slashed) ||
		path.posix.isAbsolute(slashed)
	) {
		return undefined;
	}

	const normal = path.posix.normalize(slashed).replace(/\/+$/, '');
	if (
		!normal ||
		normal === '.' ||
		normal === '..' ||
		normal.startsWith('../')
	) {
		return undefined;
	}

	return normal;
}

function stringList(value: unknown, key: string, fail: Fail): string[] {
	if (value === undefined) {
		return [];
	}

	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
		return fail(key, 'must be a list of strings');
	}

	return value as string[];
}

function oneOf<const T extends string, D extends T | undefined>(
	value: unknown,
	allowed: readonly T[],
	fallback: D,
	key: string,
	fail: Fail,
): T | D {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		return fail(
			key,
			`must be one of ${allowed.map(item => `"${item}"`).join(', ')}`,
		);
	}

	return value as T;
}

function isObject(value: unknown): value is Obj {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
