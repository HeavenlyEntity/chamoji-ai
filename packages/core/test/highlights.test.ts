import {afterEach, expect, test} from 'vitest';
import {buildChangelog} from '../src/changelog.js';
import {repoStats} from '../src/card.js';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import {splitHighlights} from '../src/highlights.js';
import type {Release} from '../src/types.js';
import {WORKSTREAMS_FILE, type Workstream} from '../src/workstreams.js';
import {commit} from './helpers/commit.js';
import {createRepo, type FixtureRepo} from './helpers/fixture-repo.js';

const config = {groups: DEFAULT_GROUP_CONFIG};
let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

/** A workstreams file: `slug: status` pairs, titled after the slug. */
const file = (entries: Record<string, string>) =>
	`workstreams:\n${Object.entries(entries)
		.map(
			([slug, status]) =>
				`  ${slug}:\n    title: Title of ${slug}\n    status: ${status}\n`,
		)
		.join('')}`;

const files = (entries: Record<string, string>) => ({
	[WORKSTREAMS_FILE]: file(entries),
});

const stream = (slug: string) => ({body: `Workstream: ${slug}`});

const descriptions = (release: Release | undefined) =>
	release?.groups.flatMap(group => group.commits.map(item => item.description));

const workstream = (
	slug: string,
	status: Workstream['status'] = 'shipped',
): Workstream => ({slug, title: slug, status});

test('a shipped workstream folds into a highlight; loose commits stay put', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: files({auth: 'shipped'})},
		{commit: '✨ Add login', ...stream('auth')},
		{commit: '🐛 Fix session', ...stream('auth')},
		{commit: '🐛 Fix typo'},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect(release?.highlights).toMatchObject([
		{
			slug: 'auth',
			title: 'Title of auth',
			groups: [
				{group: 'added', commits: [{description: 'Add login'}]},
				{group: 'fixed', commits: [{description: 'Fix session'}]},
			],
		},
	]);
	expect(descriptions(release)).toEqual(['Init', 'Fix typo']);
});

test('active, dropped and unknown workstreams stay loose', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: files({a: 'active', d: 'dropped', s: 'shipped'}),
		},
		{commit: '✨ Add active', ...stream('a')},
		{commit: '✨ Add dropped', ...stream('d')},
		{commit: '✨ Add ghost', ...stream('ghost')},
		{commit: '✨ Add shipped', ...stream('s')},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect(release?.highlights?.map(item => item.slug)).toEqual(['s']);
	expect(descriptions(release)).toEqual([
		'Add ghost',
		'Add dropped',
		'Add active',
		'Init',
	]);
});

test('a breaking commit stays under Breaking changes', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: files({auth: 'shipped'})},
		{commit: '✨ Add login', ...stream('auth')},
		{commit: '💥 Drop the old tokens', ...stream('auth')},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect(release?.bump).toBe('major');
	expect(
		release?.groups.find(group => group.group === 'breaking_changes')
			?.commits[0]?.description,
	).toBe('Drop the old tokens');
	expect(
		release?.highlights?.[0]?.groups.flatMap(group => group.commits),
	).toMatchObject([{description: 'Add login'}]);
});

test('hidden-group commits stay hidden, and a workstream of only those has no entry', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: files({auth: 'shipped', quiet: 'shipped'})},
		{commit: '✨ Add login', ...stream('auth')},
		{commit: '🔖 Release notes', ...stream('auth')},
		{commit: '🔖 Bump', ...stream('quiet')},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect(release?.highlights?.map(item => item.slug)).toEqual(['auth']);
	const shown = [
		...(release?.highlights ?? []).flatMap(item => item.groups),
		...(release?.groups ?? []),
	].flatMap(group => group.commits.map(item => item.description));
	expect(shown).toEqual(['Add login', 'Init']);
});

test('a repo without the file has no highlights key', async () => {
	repo = await createRepo([
		{commit: '✨ Add login', ...stream('auth')},
		{commit: '🐛 Fix typo'},
		{tag: 'v1.0.0'},
		{commit: '✨ Add search'},
	]);

	const {releases} = await buildChangelog({cwd: repo.dir, config});
	expect(releases).toHaveLength(2);
	for (const release of releases) {
		expect('highlights' in release).toBe(false);
	}

	expect(descriptions(releases[1])).toEqual(['Add login', 'Fix typo']);
});

test('a shipped workstream with no commits in a release has no entry', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: files({auth: 'shipped'})},
		{commit: '🐛 Fix typo'},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect('highlights' in release!).toBe(false);
});

test('a workstream shipped after v1.0.0 leaves v1.0.0 loose', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: files({auth: 'active'})},
		{commit: '✨ Add login', ...stream('auth')},
		{tag: 'v1.0.0'},
		{commit: '✨ Add logout', ...stream('auth')},
		{commit: '🚀 Ship auth', files: files({auth: 'shipped'})},
		{tag: 'v1.1.0'},
	]);

	const [latest, first] = (await buildChangelog({cwd: repo.dir, config}))
		.releases;
	expect(latest?.version).toBe('v1.1.0');
	expect(latest?.highlights?.map(item => item.slug)).toEqual(['auth']);
	expect(
		latest?.highlights?.[0]?.groups.flatMap(group =>
			group.commits.map(item => item.description),
		),
	).toEqual(['Add logout']);
	expect(first?.version).toBe('v1.0.0');
	expect('highlights' in first!).toBe(false);
	expect(descriptions(first)).toEqual(['Add login', 'Init']);
});

test('forty commits over four shipped workstreams and six loose ones', async () => {
	const slugs = ['auth', 'billing', 'search', 'export'];
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: files(Object.fromEntries(slugs.map(slug => [slug, 'shipped']))),
		},
		...Array.from({length: 40}, (_, index) => ({
			commit: `✨ Work ${index}`,
			...stream(slugs[index % 4]!),
		})),
		...Array.from({length: 5}, (_, index) => ({commit: `🐛 Loose ${index}`})),
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect(release?.highlights).toHaveLength(4);
	for (const item of release?.highlights ?? []) {
		expect(item.groups.flatMap(group => group.commits)).toHaveLength(10);
	}

	// Five loose fixes plus Init.
	expect(descriptions(release)).toHaveLength(6);
});

test('highlights come newest work first', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: files({a: 'shipped', b: 'shipped'})},
		{commit: '✨ Add a1', ...stream('a')},
		{commit: '✨ Add b1', ...stream('b')},
		{commit: '✨ Add a2', ...stream('a')},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	expect(release?.highlights?.map(item => item.slug)).toEqual(['a', 'b']);
});

test('a highlight keeps links, and leaves unset fields out', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				[WORKSTREAMS_FILE]:
					'workstreams:\n  a:\n    title: A\n    emoji: "🔐"\n    description: Sign in\n    status: shipped\n    links:\n      - https://example.com/a\n  b:\n    title: B\n    status: shipped\n',
			},
		},
		{commit: '✨ Add a', ...stream('a')},
		{commit: '✨ Add b', ...stream('b')},
	]);

	const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
	const [b, a] = release!.highlights!;
	expect(a).toMatchObject({
		slug: 'a',
		title: 'A',
		emoji: '🔐',
		description: 'Sign in',
		links: ['https://example.com/a'],
	});
	expect(Object.keys(b!).sort()).toEqual(['groups', 'slug', 'title']);
	const json = JSON.parse(JSON.stringify(release)) as Release;
	expect(json.highlights?.[1]?.links).toEqual(['https://example.com/a']);
});

test('an unparsable file at HEAD throws, naming the file', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: {[WORKSTREAMS_FILE]: 'workstreams: {\n'}},
		{commit: '✨ Add login', ...stream('auth')},
	]);

	await expect(buildChangelog({cwd: repo.dir, config})).rejects.toThrow(
		WORKSTREAMS_FILE,
	);
});

test('an unparsable file at a tag that is `to` throws', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: {[WORKSTREAMS_FILE]: 'workstreams: {\n'}},
		{commit: '✨ Add login'},
		{tag: 'v1.0.0'},
		{commit: '✨ Add search'},
	]);

	await expect(
		buildChangelog({cwd: repo.dir, config, to: 'v1.0.0'}),
	).rejects.toThrow(WORKSTREAMS_FILE);
});

test('an unparsable file at an older tag is ignored', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: {[WORKSTREAMS_FILE]: 'workstreams: {\n'}},
		{commit: '✨ Add login', ...stream('auth')},
		{tag: 'v1.0.0'},
		{commit: '🔧 Repair file', files: files({auth: 'shipped'})},
		{commit: '✨ Add search', ...stream('auth')},
		{tag: 'v1.1.0'},
	]);

	const [latest, first] = (await buildChangelog({cwd: repo.dir, config}))
		.releases;
	expect(latest?.highlights?.map(item => item.slug)).toEqual(['auth']);
	expect('highlights' in first!).toBe(false);
	expect(descriptions(first)).toEqual(['Add login', 'Init']);
});

test('next-version is the same with and without highlights', async () => {
	const steps = (withFile: boolean) => [
		{commit: '🎉 Init', ...(withFile ? {files: files({a: 'shipped'})} : {})},
		{tag: 'v1.0.0'},
		{commit: '🐛 Fix typo', ...stream('a')},
		{commit: '✨ Add login', ...stream('a')},
	];
	const versions: Array<string | null> = [];
	const bumps: Array<string | null> = [];
	for (const withFile of [false, true]) {
		repo = await createRepo(steps(withFile));
		const [release] = (await buildChangelog({cwd: repo.dir, config})).releases;
		expect('highlights' in release!).toBe(withFile);
		versions.push(release!.nextVersion);
		bumps.push(release!.bump);
		await repo.cleanup();
	}

	repo = undefined;
	expect(versions).toEqual(['1.1.0', '1.1.0']);
	expect(bumps).toEqual(['minor', 'minor']);
});

test('repoStats totals are the same with and without highlights', async () => {
	const steps = (withFile: boolean) => [
		{commit: '🎉 Init', ...(withFile ? {files: files({a: 'shipped'})} : {})},
		{commit: '✨ Add one', ...stream('a')},
		{commit: '🐛 Fix two', ...stream('a')},
		{commit: '♻️ Change three', ...stream('a')},
		{commit: 'Odd one', ...stream('a')},
		{commit: '✨ Add four'},
		{tag: 'v1.0.0'},
	];
	const stats = [];
	for (const withFile of [false, true]) {
		repo = await createRepo(steps(withFile));
		const changelog = await buildChangelog({cwd: repo.dir, config});
		expect('highlights' in changelog.releases[0]!).toBe(withFile);
		stats.push(repoStats(changelog));
		await repo.cleanup();
	}

	repo = undefined;
	expect(stats[1]).toEqual(stats[0]);
	expect(stats[1]).toMatchObject({commits: 6, added: 3, fixed: 1, changed: 1});
});

test('splitHighlights keeps the order of loose commits and drops nothing', () => {
	const a1 = commit('✨ Add a1', {body: 'Workstream: a'});
	const loose1 = commit('🐛 Fix one');
	const a2 = commit('🐛 Fix a2', {body: 'Workstream: a'});
	const loose2 = commit('✨ Add two');
	const result = splitHighlights(
		[a1, loose1, a2, loose2],
		[workstream('a')],
		DEFAULT_GROUP_CONFIG,
	);
	expect(result.loose).toEqual([loose1, loose2]);
	expect(result.highlights[0]?.groups.flatMap(group => group.commits)).toEqual([
		a1,
		a2,
	]);
});

test('splitHighlights ignores everything but shipped workstreams', () => {
	const commits = [commit('✨ Add a', {body: 'Workstream: a'})];
	for (const status of ['active', 'dropped'] as const) {
		const result = splitHighlights(
			commits,
			[workstream('a', status)],
			DEFAULT_GROUP_CONFIG,
		);
		expect(result).toEqual({highlights: [], loose: commits});
	}
});
