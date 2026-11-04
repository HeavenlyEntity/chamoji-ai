import {expect, test} from 'vitest';
import {ConfigVersionError, parseReleaseSettings} from '../../src/index.js';

const FILE = '/repo/chamoji.config.json';

const gearz = {
	schema: 1,
	shape: 'apps',
	units: {
		web: {path: 'apps/web', tag: 'web/v{version}'},
		mobile: {
			path: 'apps/mobile',
			tag: 'mobile/v{version}',
			versionFiles: ['apps/mobile/app.config.ts'],
			buildNumber: 'untouched',
		},
	},
	exclude: ['apps/e2e', 'apps/dev-tool', 'tooling/*'],
	sharedChanges: 'ride-along',
	rootFiles: 'none',
	zeroMajor: 'minor',
	fixed: [['web', 'mobile']],
	upstream: {remote: 'upstream', name: 'Makerkit', since: '<commit>'},
	tags: {
		ignore: ['^\\d+\\.\\d+\\.\\d+$', '^v\\d+\\.\\d+\\.\\d+-\\d+$', '^wip/'],
	},
};

function withUnits(units: unknown, extra: Record<string, unknown> = {}) {
	return {schema: 1, shape: 'apps', units, ...extra};
}

test("parses the spec's gearz example", () => {
	const settings = parseReleaseSettings(gearz, FILE);
	expect(settings.shape).toBe('apps');
	expect(settings.units.map(unit => unit.name)).toEqual(['web', 'mobile']);
	expect(settings.units[0]).toEqual({
		name: 'web',
		path: 'apps/web',
		tag: 'web/v{version}',
		read: [],
		versioning: 'semver',
		versionFiles: [],
		buildNumber: 'untouched',
		changelog: 'apps/web/CHANGELOG.md',
	});
	expect(settings.units[1]?.versionFiles).toEqual([
		'apps/mobile/app.config.ts',
	]);
	expect(settings.fixed).toEqual([['web', 'mobile']]);
	expect(settings.zeroMajor).toBe('minor');
	expect(settings.upstream).toEqual({
		remote: 'upstream',
		name: 'Makerkit',
		since: '<commit>',
	});
	expect(settings.rootChangelog).toBe(false);
	expect(settings.githubReleases).toBe('per-unit');
	expect(settings.tags.aliases).toEqual({});
});

test('tag and changelog come from the shape defaults when absent', () => {
	const apps = parseReleaseSettings(withUnits({web: {path: 'apps/web'}}), FILE);
	expect(apps.units[0]?.tag).toBe('{unit}/v{version}');
	expect(apps.units[0]?.changelog).toBe('apps/web/CHANGELOG.md');
	expect(apps.sharedChanges).toBe('ride-along');
	expect(apps.rootFiles).toBe('none');
	expect(apps.fixed).toEqual([]);

	const libs = parseReleaseSettings(
		{schema: 1, shape: 'libraries', units: {core: {path: 'packages/core'}}},
		FILE,
	);
	expect(libs.units[0]?.tag).toBe('{name}@{version}');
	expect(libs.sharedChanges).toBe('release-dependents');
});

test('schema above 1 is refused', () => {
	const call = () => parseReleaseSettings({...gearz, schema: 2}, FILE);
	expect(call).toThrow(ConfigVersionError);
	expect(call).toThrow(
		"this repo's release settings need chamoji 0.13.0 or newer",
	);
});

test('a missing or non-integer schema is invalid', () => {
	expect(() => parseReleaseSettings({shape: 'apps'}, FILE)).toThrow(
		`Invalid config ${FILE}: release.schema`,
	);
});

test.each(['train', 'mixed'])('%s is not supported yet', shape => {
	expect(() => parseReleaseSettings({schema: 1, shape}, FILE)).toThrow(
		`release.shape "${shape}" isn't supported yet; use apps or libraries`,
	);
});

test('an unknown shape is invalid', () => {
	expect(() => parseReleaseSettings({schema: 1, shape: 'x'}, FILE)).toThrow(
		`Invalid config ${FILE}: release.shape`,
	);
});

test('a tag template must contain {version}', () => {
	expect(() =>
		parseReleaseSettings(
			withUnits({web: {path: 'apps/web', tag: 'web'}}),
			FILE,
		),
	).toThrow(/release\.units\.web\.tag.*\{version\}/);
	expect(() =>
		parseReleaseSettings(
			withUnits({web: {path: 'apps/web', read: ['web-v']}}),
			FILE,
		),
	).toThrow(/release\.units\.web\.read/);
});

test('unit paths are normalised', () => {
	const settings = parseReleaseSettings(
		withUnits({web: {path: 'apps\\web/'}, ui: {path: './packages//ui'}}),
		FILE,
	);
	expect(settings.units.map(unit => unit.path)).toEqual([
		'apps/web',
		'packages/ui',
	]);
	expect(settings.units[0]?.changelog).toBe('apps/web/CHANGELOG.md');
});

test.each(['../x', 'a/../../x', '/abs', 'C:\\abs', '.', ''])(
	'unit path %j that leaves the repo is refused',
	bad => {
		expect(() =>
			parseReleaseSettings(withUnits({web: {path: bad}}), FILE),
		).toThrow(/release\.units\.web\.path/);
	},
);

test('fixed groups must name known units', () => {
	expect(() =>
		parseReleaseSettings(
			{
				schema: 1,
				shape: 'libraries',
				units: {core: {path: 'packages/core'}},
				fixed: [['core', 'nope']],
			},
			FILE,
		),
	).toThrow(/release\.fixed.*nope/);
});

test('single shape needs no units', () => {
	const settings = parseReleaseSettings({schema: 1, shape: 'single'}, FILE);
	expect(settings.shape).toBe('single');
	expect(settings.units).toEqual([]);
});

test('unit names must be usable in tags and on the command line', () => {
	for (const name of ['', 'a/b', 'a b']) {
		expect(() =>
			parseReleaseSettings(withUnits({[name]: {path: 'apps/x'}}), FILE),
		).toThrow(/release\.units/);
	}
});

test('upstream.since accepts any non-empty string, name is required', () => {
	expect(() =>
		parseReleaseSettings(
			withUnits({}, {upstream: {name: 'Makerkit', since: ''}}),
			FILE,
		),
	).toThrow(/release\.upstream\.since/);
	expect(() =>
		parseReleaseSettings(withUnits({}, {upstream: {remote: 'upstream'}}), FILE),
	).toThrow(/release\.upstream\.name/);
});

test('aliases normalise from the one-unit string form', () => {
	const one = parseReleaseSettings(
		withUnits({web: {path: 'apps/web'}}, {tags: {aliases: {old: '1.0.0'}}}),
		FILE,
	);
	expect(one.tags.aliases).toEqual({old: {unit: 'web', version: '1.0.0'}});

	const many = parseReleaseSettings(
		withUnits(
			{web: {path: 'apps/web'}, mobile: {path: 'apps/mobile'}},
			{tags: {aliases: {old: {unit: 'web', version: '1.0.0'}}}},
		),
		FILE,
	);
	expect(many.tags.aliases).toEqual({old: {unit: 'web', version: '1.0.0'}});

	expect(() =>
		parseReleaseSettings(
			withUnits(
				{web: {path: 'apps/web'}, mobile: {path: 'apps/mobile'}},
				{tags: {aliases: {old: '1.0.0'}}},
			),
			FILE,
		),
	).toThrow(/release\.tags\.aliases/);
	expect(() =>
		parseReleaseSettings(
			withUnits(
				{web: {path: 'apps/web'}},
				{tags: {aliases: {old: {unit: 'nope', version: '1.0.0'}}}},
			),
			FILE,
		),
	).toThrow(/release\.tags\.aliases.*nope/);
});

test('upstream.since and upstream.remote reject option-like values', () => {
	for (const upstream of [
		{name: 'Makerkit', since: '--output=x'},
		{name: 'Makerkit', remote: '-u'},
		{name: 'Makerkit', remote: 'my remote'},
	]) {
		expect(() => parseReleaseSettings(withUnits({}, {upstream}), FILE)).toThrow(
			/release\.upstream\.(since|remote)/,
		);
	}
});
