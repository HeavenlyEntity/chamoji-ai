import {expect, test} from 'vitest';
import {
	alignFixed,
	nextUnitVersion,
	type NextVersion,
	type VersionInput,
} from '../../src/units/versions.js';
import type {ResolvedUnit} from '../../src/units/workspace.js';
import {commit} from '../helpers/commit.js';

function unit(over: Partial<ResolvedUnit> = {}): ResolvedUnit {
	return {
		name: 'web',
		path: 'apps/web',
		tag: '{unit}/v{version}',
		read: [],
		versioning: 'semver',
		versionFiles: [],
		buildNumber: 'untouched',
		changelog: 'apps/web/CHANGELOG.md',
		pkg: null,
		uses: [],
		...over,
	};
}

function input(over: Partial<VersionInput> = {}): VersionInput {
	return {
		unit: unit(),
		last: null,
		manifestVersion: null,
		commits: [commit('🐛 Fix x')],
		today: '2026-11-03',
		releasesThisMonth: 0,
		...over,
	};
}

const tag = (version: string) => ({
	tag: `web/v${version}`,
	version,
	date: '2026-10-01',
});

test('first release uses the manifest version as is', () => {
	expect(nextUnitVersion(input({manifestVersion: '0.1.0'}))).toEqual({
		version: '0.1.0',
		bump: 'first',
	});
});

test('first release falls back to 0.1.0 and ignores the commits', () => {
	expect(nextUnitVersion(input({commits: []}))).toEqual({
		version: '0.1.0',
		bump: 'first',
	});
});

test('firstVersion wins over the manifest', () => {
	expect(
		nextUnitVersion(
			input({
				unit: unit({firstVersion: '1.0.0'}),
				manifestVersion: '0.3.0',
			}),
		),
	).toEqual({version: '1.0.0', bump: 'first'});
});

test('the last tag wins over the manifest', () => {
	expect(
		nextUnitVersion(input({last: tag('1.2.0'), manifestVersion: '0.1.0'})),
	).toEqual({version: '1.2.1', bump: 'patch'});
});

test('zeroMajor turns breaking into minor below 1.0', () => {
	const commits = [commit('💥 Break z')];
	expect(
		nextUnitVersion(input({last: tag('0.4.2'), commits, zeroMajor: 'minor'})),
	).toEqual({version: '0.5.0', bump: 'minor'});
	expect(
		nextUnitVersion(input({last: tag('1.4.2'), commits, zeroMajor: 'minor'})),
	).toEqual({version: '2.0.0', bump: 'major'});
	expect(nextUnitVersion(input({last: tag('0.4.2'), commits}))).toEqual({
		version: '1.0.0',
		bump: 'major',
	});
});

test('calver counts this month’s releases', () => {
	const calver = unit({versioning: 'calver'});
	expect(
		nextUnitVersion(
			input({
				unit: calver,
				last: tag('2026.11.1'),
				releasesThisMonth: 2,
			}),
		),
	).toEqual({version: '2026.11.2', bump: 'calver'});
});

test('calver first release comes from today, not the manifest', () => {
	const calver = unit({versioning: 'calver'});
	expect(
		nextUnitVersion(
			input({unit: calver, manifestVersion: '3.0.0', commits: []}),
		),
	).toEqual({version: '2026.11.0', bump: 'first'});
	expect(
		nextUnitVersion(
			input({
				unit: unit({versioning: 'calver', firstVersion: '2026.1.0'}),
			}),
		),
	).toEqual({version: '2026.1.0', bump: 'first'});
});

test('no bump means null', () => {
	expect(nextUnitVersion(input({last: tag('1.2.0'), commits: []}))).toBeNull();
	expect(
		nextUnitVersion(
			input({
				unit: unit({versioning: 'calver'}),
				last: tag('2026.11.0'),
				commits: [],
			}),
		),
	).toBeNull();
});

const patch = {version: '1.2.1', bump: 'patch'} as const;
const minor = {version: '1.3.0', bump: 'minor'} as const;

function align(next: Record<string, NextVersion>) {
	const current = new Map([
		['core', '1.2.0'],
		['types', '1.2.0'],
		['other', '5.0.0'],
	]);
	return alignFixed(
		new Map(Object.entries(next)),
		[['core', 'types']],
		current,
	);
}

test('fixed groups share the larger version', () => {
	const result = align({core: patch, types: null, other: null});
	expect(result.get('core')).toEqual(patch);
	expect(result.get('types')).toEqual({version: '1.2.1', bump: 'fixed'});
	expect(result.get('other')).toBeNull();
});

test('a minor in either member makes both minor', () => {
	const result = align({core: patch, types: minor, other: null});
	expect(result.get('core')).toEqual({version: '1.3.0', bump: 'fixed'});
	expect(result.get('types')).toEqual(minor);
});

test('fixed groups with nothing releasing are left alone', () => {
	const result = align({core: null, types: null, other: patch});
	expect(result.get('core')).toBeNull();
	expect(result.get('types')).toBeNull();
	expect(result.get('other')).toEqual(patch);
});

test('alignFixed does not mutate its input', () => {
	const next = new Map<string, NextVersion>([
		['core', patch],
		['types', null],
	]);
	alignFixed(next, [['core', 'types']], new Map());
	expect(next.get('types')).toBeNull();
});
