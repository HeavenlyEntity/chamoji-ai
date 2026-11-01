import {afterEach, expect, test} from 'vitest';
import {buildChangelog} from '../src/changelog.js';
import {
	CARD_ENDPOINT,
	cardUrl,
	repoStats,
	type RepoStats,
} from '../src/card.js';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import type {Changelog, ParsedCommit} from '../src/types.js';
import {createRepo, type FixtureRepo} from './helpers/fixture-repo.js';

const config = {groups: DEFAULT_GROUP_CONFIG};
let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const stats: RepoStats = {
	version: 'v1.1.0',
	date: '2026-01-04',
	releases: 2,
	commits: 5,
	sorted: 100,
	added: 1,
	fixed: 0,
	changed: 1,
};

test('counts the latest release and the whole history', async () => {
	repo = await createRepo([
		{commit: '✨ Add one'},
		{commit: '🐛 Fix two'},
		{tag: 'v1.0.0'},
		{commit: '✨ Add three'},
		{commit: '♻️ Change four'},
		{tag: 'v1.1.0'},
		{commit: '✨ Add five'},
	]);

	const changelog = await buildChangelog({cwd: repo.dir, config});
	expect(repoStats(changelog)).toMatchObject({
		version: 'v1.1.0',
		releases: 2,
		commits: 5,
		sorted: 100,
		added: 1,
		changed: 1,
		fixed: 0,
	});
});

test('sorted matches the benchmark and never rounds up to 100', () => {
	const commit = (index: number) => ({hash: String(index)}) as ParsedCommit;
	const changelog: Changelog = {
		releases: [
			{
				version: 'Unreleased',
				tag: null,
				previousTag: null,
				date: null,
				bump: null,
				nextVersion: null,
				groups: [
					{
						group: 'added',
						label: 'Added',
						commits: Array.from({length: 199}, (_, index) => commit(index)),
					},
					{group: 'misc', label: 'Miscellaneous', commits: [commit(199)]},
				],
			},
		],
	};

	expect(repoStats(changelog)).toMatchObject({commits: 200, sorted: 99});
});

test('commits folded into highlights still count', () => {
	const commit = (index: number) => ({hash: String(index)}) as ParsedCommit;
	const changelog: Changelog = {
		releases: [
			{
				version: 'v1.0.0',
				tag: 'v1.0.0',
				previousTag: null,
				date: '2026-01-01',
				bump: null,
				nextVersion: null,
				highlights: [
					{
						slug: 'auth',
						title: 'Auth',
						groups: [
							{group: 'added', label: 'Added', commits: [commit(1), commit(2)]},
							{group: 'misc', label: 'Miscellaneous', commits: [commit(3)]},
						],
					},
				],
				groups: [
					{group: 'added', label: 'Added', commits: [commit(4)]},
					{group: 'fixed', label: 'Fixed', commits: [commit(5)]},
				],
			},
		],
	};

	expect(repoStats(changelog)).toMatchObject({
		commits: 5,
		sorted: 80,
		added: 3,
		fixed: 1,
		changed: 0,
	});
});

test('a repo with no tags has no version', async () => {
	repo = await createRepo([{commit: '✨ Add one'}, {commit: '🐛 Fix two'}]);

	const changelog = await buildChangelog({cwd: repo.dir, config});
	expect(repoStats(changelog)).toMatchObject({
		version: null,
		date: null,
		releases: 0,
	});
});

test('an empty history is 0% sorted', () => {
	expect(repoStats({releases: []})).toMatchObject({commits: 0, sorted: 0});
});

test('cardUrl sends only the card fields', () => {
	const url = new URL(cardUrl(CARD_ENDPOINT, 'acme/widgets', stats));
	expect([...url.searchParams.keys()].sort()).toEqual([
		'added',
		'changed',
		'commits',
		'date',
		'fixed',
		'releases',
		'repo',
		'sorted',
		'version',
	]);
	expect(url.origin + url.pathname).toBe(CARD_ENDPOINT);
	expect(url.searchParams.get('repo')).toBe('acme/widgets');
	expect(url.searchParams.get('version')).toBe('v1.1.0');
});

test('cardUrl leaves out version and date when there is no release', () => {
	const url = new URL(
		cardUrl(CARD_ENDPOINT, 'acme/widgets', {
			...stats,
			version: null,
			date: null,
			releases: 0,
		}),
	);
	expect(url.searchParams.has('version')).toBe(false);
	expect(url.searchParams.has('date')).toBe(false);
	expect(url.searchParams.get('releases')).toBe('0');
});

test('cardUrl never contains commit text', async () => {
	repo = await createRepo([
		{commit: '✨ Add SECRET-CODENAME'},
		{tag: 'v1.0.0'},
	]);

	const changelog = await buildChangelog({cwd: repo.dir, config});
	const url = cardUrl(CARD_ENDPOINT, 'acme/widgets', repoStats(changelog));
	expect(url).not.toContain('SECRET');
});

// The tags the renderer accepts. Each must travel from git to the card's
// address unchanged, build metadata included.
const TAGS = [
	'v1.2.0',
	'1.2.3',
	'v1.29.1+k3s2',
	'v1.28.5+rke2r1',
	'1.2.3+build.5',
	'v1.2.3-rc.1+exp.sha.5114f85',
	'v1.0.20261031',
	'v1.0.1700000000',
	'2026.1.1234567',
	'v2.1.0-alpha.20240315.abcdef1',
	'v1.0.0-SNAPSHOT.20261031.123456',
];

test.each(TAGS)('carries the tag %s through unchanged', async tag => {
	repo = await createRepo([
		{commit: '✨ Add one'},
		{tag, annotated: true},
		{commit: '🐛 Fix two'},
	]);

	const changelog = await buildChangelog({cwd: repo.dir, config});
	const found = repoStats(changelog);
	expect(found).toMatchObject({version: tag, releases: 1});

	const url = new URL(cardUrl(CARD_ENDPOINT, 'acme/widgets', found));
	expect(url.searchParams.get('version')).toBe(tag);
});

test.each(TAGS)('cardUrl keeps the tag %s as given', tag => {
	const url = new URL(
		cardUrl(CARD_ENDPOINT, 'acme/widgets', {...stats, version: tag}),
	);
	expect(url.searchParams.get('version')).toBe(tag);
});
