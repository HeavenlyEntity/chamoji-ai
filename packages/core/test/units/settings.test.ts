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

test('schema 3 asks for a newer chamoji', () => {
	const call = () => parseReleaseSettings({...gearz, schema: 3}, FILE);
	expect(call).toThrow(ConfigVersionError);
	expect(call).toThrow(
		"this repo's release settings need chamoji 0.15.0 or newer",
	);
});

test('parses trigger, majors and publish under schema 2', () => {
	const settings = parseReleaseSettings(
		{
			schema: 2,
			shape: 'single',
			trigger: 'merge',
			majors: 'manual',
			publish: {check: 'pnpm test'},
		},
		FILE,
	);
	expect(settings.schema).toBe(2);
	expect(settings.trigger).toBe('merge');
	expect(settings.majors).toBe('manual');
	expect(settings.publish).toEqual({
		check: 'pnpm test',
		prereleaseTag: 'next',
		packages: [],
		registries: [],
	});
});

test('defaults when the keys are absent', () => {
	const settings = parseReleaseSettings({schema: 1, shape: 'single'}, FILE);
	expect(settings.trigger).toBe('manual');
	expect(settings.majors).toBe('auto');
	expect(settings.publish).toBeNull();
	expect(
		parseReleaseSettings({schema: 2, shape: 'single', publish: false}, FILE)
			.publish,
	).toBeNull();
});

test('publish true means the defaults', () => {
	expect(
		parseReleaseSettings({schema: 2, shape: 'single', publish: true}, FILE)
			.publish,
	).toEqual({check: null, prereleaseTag: 'next', packages: [], registries: []});
});

test('publish.registries is normalised and must be https URLs', () => {
	const parse = (registries: unknown) => () =>
		parseReleaseSettings(
			{schema: 2, shape: 'single', publish: {registries}},
			FILE,
		);
	expect(
		parse(['https://npm.acme.dev', 'https://npm.acme.dev/x/'])(),
	).toMatchObject({
		publish: {registries: ['https://npm.acme.dev/', 'https://npm.acme.dev/x/']},
	});
	expect(parse(['http://npm.acme.dev/'])).toThrow(
		'release.publish.registries "http://npm.acme.dev/" must be an https URL',
	);
	expect(parse(['not a url'])).toThrow('must be an https URL');
	expect(parse('x')).toThrow(
		'release.publish.registries must be a list of strings',
	);
});

test('new keys need schema 2', () => {
	expect(() =>
		parseReleaseSettings({schema: 1, shape: 'single', trigger: 'merge'}, FILE),
	).toThrow(`Invalid config ${FILE}: release.trigger needs "schema": 2`);
});

test('rejects bad values', () => {
	const bad = (extra: Record<string, unknown>) => () =>
		parseReleaseSettings({schema: 2, shape: 'single', ...extra}, FILE);
	expect(bad({trigger: 'push'})).toThrow(
		'release.trigger must be "merge" or "manual"',
	);
	expect(bad({majors: 'never'})).toThrow(
		'release.majors must be "auto" or "manual"',
	);
	expect(bad({publish: {packages: 'x'}})).toThrow(
		'release.publish.packages must be a list of strings',
	);
	expect(bad({publish: {tag: 'x'}})).toThrow(
		"release.publish.tag isn't a setting",
	);
});

test('zeroMajor is allowed with shape single', () => {
	expect(
		parseReleaseSettings({schema: 1, shape: 'single', zeroMajor: 'minor'}, FILE)
			.zeroMajor,
	).toBe('minor');
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

test.each([
	['exclude', ['apps/e2e']],
	['sharedChanges', 'ride-along'],
	['rootFiles', 'none'],
	['fixed', []],
	['upstream', {name: 'Makerkit'}],
	['tags', {ignore: ['^\\d+\\.\\d+\\.\\d+$']}],
	['rootChangelog', false],
	['githubReleases', 'per-unit'],
])('shape "single" refuses the unit-only setting %s', (key, value) => {
	expect(() =>
		parseReleaseSettings({schema: 1, shape: 'single', [key]: value}, FILE),
	).toThrow(
		`Invalid config ${FILE}: release.${key} is only used with apps or libraries`,
	);
});

test('two units outside one fixed group may not share a tag template', () => {
	const units = {
		core: {path: 'packages/core', tag: 'v{version}'},
		types: {path: 'packages/types', tag: 'v{version}'},
	};
	expect(() =>
		parseReleaseSettings({schema: 1, shape: 'libraries', units}, FILE),
	).toThrow(
		`Invalid config ${FILE}: release.units.types.tag "v{version}" is the same as units.core's; units share a tag template only in one fixed group`,
	);
	const fixed = parseReleaseSettings(
		{schema: 1, shape: 'libraries', units, fixed: [['core', 'types']]},
		FILE,
	);
	expect(fixed.units.map(unit => unit.tag)).toEqual([
		'v{version}',
		'v{version}',
	]);
	// A template that names the unit or package renders apart.
	const named = parseReleaseSettings(
		withUnits({web: {path: 'apps/web'}, mobile: {path: 'apps/mobile'}}),
		FILE,
	);
	expect(named.units.map(unit => unit.tag)).toEqual([
		'{unit}/v{version}',
		'{unit}/v{version}',
	]);
});

test('versionFiles are normalised and must stay inside the repo', () => {
	const settings = parseReleaseSettings(
		withUnits({
			mobile: {
				path: 'apps/mobile',
				versionFiles: [
					'./apps/mobile/app.json',
					'apps\\mobile\\app.json',
					'apps/mobile//ios/Info.plist',
				],
			},
		}),
		FILE,
	);
	expect(settings.units[0]?.versionFiles).toEqual([
		'apps/mobile/app.json',
		'apps/mobile/ios/Info.plist',
	]);
	for (const bad of ['../../etc/hosts', '/etc/hosts', 'C:\\x', '.', '']) {
		expect(() =>
			parseReleaseSettings(
				withUnits({mobile: {path: 'apps/mobile', versionFiles: [bad]}}),
				FILE,
			),
		).toThrow(
			`Invalid config ${FILE}: release.units.mobile.versionFiles ${JSON.stringify(bad)} must be a file inside the repo`,
		);
	}
});

test('exclude patterns are normalised and must stay inside the repo', () => {
	const settings = parseReleaseSettings(
		withUnits({}, {exclude: ['./apps/e2e/', 'apps\\e2e', 'tooling/*']}),
		FILE,
	);
	expect(settings.exclude).toEqual(['apps/e2e', 'tooling/*']);
	for (const bad of ['../outside', '/abs', '.']) {
		expect(() =>
			parseReleaseSettings(withUnits({}, {exclude: [bad]}), FILE),
		).toThrow(
			`Invalid config ${FILE}: release.exclude ${JSON.stringify(bad)} must be a path inside the repo`,
		);
	}
});

test('upstream.authors is an optional list of emails', () => {
	const settings = parseReleaseSettings(
		withUnits(
			{},
			{
				upstream: {
					name: 'Makerkit',
					authors: ['Giancarlo@Makerkit.dev', 'bot@makerkit.dev'],
				},
			},
		),
		FILE,
	);
	expect(settings.upstream).toEqual({
		name: 'Makerkit',
		authors: ['Giancarlo@Makerkit.dev', 'bot@makerkit.dev'],
	});
	expect(
		parseReleaseSettings(withUnits({}, {upstream: {name: 'Makerkit'}}), FILE)
			.upstream,
	).toEqual({name: 'Makerkit'});
	for (const authors of ['a@b.dev', [''], ['  '], [1], [null]]) {
		expect(() =>
			parseReleaseSettings(
				withUnits({}, {upstream: {name: 'Makerkit', authors}}),
				FILE,
			),
		).toThrow(
			`Invalid config ${FILE}: release.upstream.authors must be a list of non-empty strings`,
		);
	}
});
