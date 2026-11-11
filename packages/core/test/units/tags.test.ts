import {expect, test} from 'vitest';
import {
	isIgnoredTag,
	renderTag,
	unitTagHistory,
	versionFromTag,
	type ReleaseSettings,
	type ReleaseTag,
	type ResolvedUnit,
} from '../../src/index.js';

const acme = {unit: 'ui', name: '@acme/ui'};

function unit(over: Partial<ResolvedUnit> = {}): ResolvedUnit {
	return {
		name: 'web',
		path: 'apps/web',
		tag: '{unit}/v{version}',
		read: ['{unit}-v{version}'],
		versioning: 'semver',
		versionFiles: [],
		buildNumber: 'untouched',
		changelog: 'apps/web/CHANGELOG.md',
		pkg: null,
		uses: [],
		...over,
	};
}

function settings(
	tags: Partial<ReleaseSettings['tags']> = {},
): ReleaseSettings {
	return {
		schema: 1,
		shape: 'apps',
		units: [],
		exclude: [],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		fixed: [],
		tags: {ignore: [], aliases: {}, ...tags},
		rootChangelog: false,
		githubReleases: 'per-unit',
		trigger: 'manual',
		majors: 'auto',
		publish: null,
	};
}

const at = (name: string, day: number): ReleaseTag => ({
	name,
	date: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`,
});

test('renderTag fills unit, name and version', () => {
	expect(
		renderTag('{name}@{version}', {
			unit: 'ui',
			name: '@acme/ui',
			version: '1.2.0',
		}),
	).toBe('@acme/ui@1.2.0');
	expect(
		renderTag('{unit}/v{version}', {unit: 'web', name: '', version: '1.0.0'}),
	).toBe('web/v1.0.0');
});

test('renderTag names the placeholder it cannot fill', () => {
	expect(() =>
		renderTag('{name}@{version}', {unit: 'web', name: '', version: '1.0.0'}),
	).toThrow('{name}');
});

test('versionFromTag escapes the template', () => {
	expect(versionFromTag('@acme/ui@1.2.0', '{name}@{version}', acme)).toBe(
		'1.2.0',
	);
	expect(versionFromTag('@acme/uix1.2.0', '{name}@{version}', acme)).toBeNull();
	const values = {unit: 'x', name: 'x'};
	expect(versionFromTag('release+2.0.0', 'release+{version}', values)).toBe(
		'2.0.0',
	);
	expect(
		versionFromTag('releaseee2.0.0', 'release+{version}', values),
	).toBeNull();
	expect(versionFromTag('x1.0.0', '{version}', values)).toBeNull();
});

test('versionFromTag returns null when the template needs an empty value', () => {
	expect(
		versionFromTag('@acme/ui@1.0.0', '{name}@{version}', {
			unit: 'ui',
			name: '',
		}),
	).toBeNull();
});

test('loose versions are read', () => {
	const values = {unit: 'web', name: 'web'};
	expect(versionFromTag('web-v1.2', 'web-v{version}', values)).toBe('1.2.0');
	expect(versionFromTag('1.2.3.4', '{version}', values)).toBe('1.2.3');
	expect(versionFromTag('web/v2.0.0-beta.3', '{unit}/v{version}', values)).toBe(
		'2.0.0-beta.3',
	);
	expect(versionFromTag('web/vnext', '{unit}/v{version}', values)).toBeNull();
});

test('history mixes formats, aliases and ignores', () => {
	const result = unitTagHistory(
		[
			at('web-v1.2', 2),
			at('web/v1.3.0', 3),
			at('final-release', 1),
			at('5.0.0', 5),
			at('4.0.2', 4),
			at('wip/x', 6),
		],
		unit(),
		settings({
			ignore: ['^\\d+\\.\\d+\\.\\d+$'],
			aliases: {'final-release': {unit: 'web', version: '1.0.0'}},
		}),
	);
	expect(result.map(entry => [entry.tag, entry.version])).toEqual([
		['web/v1.3.0', '1.3.0'],
		['web-v1.2', '1.2.0'],
		['final-release', '1.0.0'],
	]);
	expect(result[0]!.date).toBe('2026-01-03T00:00:00.000Z');
});

test('two tags with one version keep the one matching the unit template', () => {
	const tags = [at('web-v1.2', 1), at('web/v1.2.0', 2)];
	expect(unitTagHistory(tags, unit(), settings()).map(t => t.tag)).toEqual([
		'web/v1.2.0',
	]);
	expect(
		unitTagHistory([...tags].reverse(), unit(), settings()).map(t => t.tag),
	).toEqual(['web/v1.2.0']);
});

test('an alias for another unit keeps the tag out of this history', () => {
	const result = unitTagHistory(
		[at('web/v1.0.0', 1)],
		unit(),
		settings({aliases: {'web/v1.0.0': {unit: 'api', version: '1.0.0'}}}),
	);
	expect(result).toEqual([]);
});

test('{name} templates need a package; without one only aliases match', () => {
	const lib = unit({name: 'ui', tag: '{name}@{version}', read: []});
	const tags = [at('@acme/ui@1.0.0', 1), at('old-ui', 2)];
	const aliases = {'old-ui': {unit: 'ui', version: '0.9.0'}};
	expect(
		unitTagHistory(tags, lib, settings({aliases})).map(t => t.version),
	).toEqual(['0.9.0']);
	const withPkg = {...lib, pkg: {name: '@acme/ui'} as ResolvedUnit['pkg']};
	expect(
		unitTagHistory(tags, withPkg, settings({aliases})).map(t => t.version),
	).toEqual(['1.0.0', '0.9.0']);
});

test('isIgnoredTag tests the whole tag name', () => {
	const s = settings({ignore: ['^wip/']});
	expect(isIgnoredTag('wip/x', s)).toBe(true);
	expect(isIgnoredTag('web/v1.0.0', s)).toBe(false);
});
