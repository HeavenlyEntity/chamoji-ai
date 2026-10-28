import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {buildChangelog} from '../src/changelog.js';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import type {Release} from '../src/types.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

const config = {groups: DEFAULT_GROUP_CONFIG};
let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const count = (release: Release) =>
	release.groups.reduce((sum, group) => sum + group.commits.length, 0);

test('releases newest first with correct ranges', async () => {
	repo = await createRepo([
		{commit: '🎉 Init'},
		{commit: '✨ Add login'},
		{tag: 'v1.0.0'},
		{commit: '🐛 Fix crash'},
		{tag: 'v1.1.0'},
		{commit: '✨ Add search'},
	]);

	const {releases} = await buildChangelog({cwd: repo.dir, config});
	expect(releases.map(r => r.version)).toEqual([
		'Unreleased',
		'v1.1.0',
		'v1.0.0',
	]);
	expect(releases.map(count)).toEqual([1, 1, 2]);
	expect(releases[0]).toMatchObject({
		tag: null,
		previousTag: 'v1.1.0',
		date: null,
		bump: 'minor',
		nextVersion: '1.2.0',
	});
	expect(releases[1]).toMatchObject({
		tag: 'v1.1.0',
		previousTag: 'v1.0.0',
		date: '2026-01-03',
		bump: 'patch',
	});
	expect(releases[2]!.previousTag).toBeNull();
});

test('no tags gives a single Unreleased release', async () => {
	repo = await createRepo([{commit: '🎉 Init'}, {commit: '✨ Add login'}]);

	const {releases} = await buildChangelog({cwd: repo.dir, config});
	expect(releases.map(r => r.version)).toEqual(['Unreleased']);
	expect(releases[0]!.nextVersion).toBe('0.1.0');
});

test('no commits after the latest tag gives no Unreleased section', async () => {
	repo = await createRepo([{commit: '✨ Add'}, {tag: 'v1.0.0'}]);

	const {releases} = await buildChangelog({cwd: repo.dir, config});
	expect(releases.map(r => r.version)).toEqual(['v1.0.0']);
});

test('release option names and dates the unreleased section', async () => {
	repo = await createRepo([
		{commit: '✨ Add'},
		{tag: 'v1.0.0'},
		{commit: '🐛 Fix'},
	]);

	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		release: '1.0.1',
		today: '2026-10-27',
	});
	expect(releases[0]).toMatchObject({version: '1.0.1', date: '2026-10-27'});
});

test('a tag keeps the date --release gave it in a negative-offset zone', async () => {
	// 21:01 in UTC-7 is already the next day in UTC.
	const releasedAt = '2026-10-27T21:01:00-07:00';
	repo = await createRepo([{commit: '✨ Add', date: releasedAt}]);

	vi.useFakeTimers({toFake: ['Date']});
	vi.setSystemTime(new Date(releasedAt));
	try {
		const before = await buildChangelog({
			cwd: repo.dir,
			config,
			release: '1.0.0',
		});
		expect(before.releases[0]!.date).toBe('2026-10-28');
	} finally {
		vi.useRealTimers();
	}

	await gitOutput(repo.dir, ['tag', 'v1.0.0']);
	const after = await buildChangelog({cwd: repo.dir, config});
	expect(after.releases[0]).toMatchObject({
		version: 'v1.0.0',
		date: '2026-10-28',
	});
});

test('from option stops before that tag', async () => {
	repo = await createRepo([
		{commit: '✨ One'},
		{tag: 'v1.0.0'},
		{commit: '✨ Two'},
		{tag: 'v1.1.0'},
		{commit: '✨ Three'},
		{tag: 'v1.2.0'},
	]);

	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		from: 'v1.1.0',
	});
	expect(releases.map(r => r.version)).toEqual(['v1.2.0']);
});

test('to option treats an older ref as the head', async () => {
	repo = await createRepo([
		{commit: '✨ One'},
		{tag: 'v1.0.0'},
		{commit: '✨ Two'},
		{tag: 'v1.1.0'},
	]);

	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		to: 'v1.0.0',
	});
	expect(releases.map(r => r.version)).toEqual(['v1.0.0']);
});

test('repository url comes from origin remote', async () => {
	repo = await createRepo([{commit: '✨ One'}]);
	await gitOutput(repo.dir, [
		'remote',
		'add',
		'origin',
		'git@github.com:acme/widgets.git',
	]);

	const changelog = await buildChangelog({cwd: repo.dir, config});
	expect(changelog.repositoryUrl).toBe('https://github.com/acme/widgets');
});

test('outside a git repo throws a clear error', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-nogit-'));
	try {
		await expect(buildChangelog({cwd: dir, config})).rejects.toThrow(
			`Not a git repository: ${dir}`,
		);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test('release option links to the tag the release will get', async () => {
	repo = await createRepo([
		{commit: '✨ Add'},
		{tag: 'v1.0.0'},
		{commit: '🐛 Fix'},
	]);

	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		release: '1.0.1',
	});
	expect(releases[0]).toMatchObject({tag: 'v1.0.1', previousTag: 'v1.0.0'});
});

test('release option must be a semver version', async () => {
	repo = await createRepo([{commit: '✨ Add'}]);
	await expect(
		buildChangelog({cwd: repo.dir, config, release: 'none'}),
	).rejects.toThrow('Invalid release version: none');
});

test('classifier only sees unsorted commits and its picks are applied', async () => {
	repo = await createRepo([
		{commit: '✨ Add search'},
		{commit: 'Add filters'},
		{commit: 'Accept camelCase flags in strict mode'},
		{commit: 'Tidelift tasks'},
	]);

	const seen: string[] = [];
	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		async classify(commits) {
			seen.push(...commits.map(c => c.subject));
			const accept = commits.find(c => c.subject.startsWith('Accept'))!;
			return new Map([[accept.hash, 'sparkles']]);
		},
	});

	expect(seen.sort()).toEqual([
		'Accept camelCase flags in strict mode',
		'Tidelift tasks',
	]);
	const added = releases[0]!.groups.find(g => g.group === 'added')!;
	expect(added.commits.map(c => [c.subject, c.gitmojiSource])).toEqual([
		['Accept camelCase flags in strict mode', 'ai'],
		['Add filters', 'rule'],
		['✨ Add search', 'gitmoji'],
	]);
	const misc = releases[0]!.groups.find(g => g.group === 'misc')!;
	expect(misc.commits.map(c => c.subject)).toEqual(['Tidelift tasks']);
	expect(releases[0]!.bump).toBe('minor');
});

test('classifier is not called when every commit is sorted', async () => {
	repo = await createRepo([{commit: '✨ Add search'}]);
	let calls = 0;
	await buildChangelog({
		cwd: repo.dir,
		config,
		async classify() {
			calls++;
			return new Map();
		},
	});
	expect(calls).toBe(0);
});

test('classifier picks of unknown codes or boom are ignored', async () => {
	repo = await createRepo([{commit: 'Tidelift tasks'}, {commit: 'Odd one'}]);
	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		async classify(commits) {
			return new Map([
				[commits[0]!.hash, 'boom'],
				[commits[1]!.hash, 'not_a_gitmoji'],
			]);
		},
	});
	expect(releases[0]!.groups.map(g => g.group)).toEqual(['misc']);
	expect(releases[0]!.bump).toBeNull();
});

test('classifyReleases unreleased only sends the unreleased commits', async () => {
	repo = await createRepo([
		{commit: 'Tidelift tasks'},
		{tag: 'v1.0.0'},
		{commit: 'Odd one'},
	]);
	const seen: string[] = [];
	await buildChangelog({
		cwd: repo.dir,
		config,
		classifyReleases: 'unreleased',
		async classify(commits) {
			seen.push(...commits.map(c => c.subject));
			return new Map();
		},
	});
	expect(seen).toEqual(['Odd one']);
});

test('since lists only the commits after a ref, as one section', async () => {
	repo = await createRepo([
		{commit: '🎉 Init'},
		{tag: 'v1.0.0'},
		{commit: '✨ Add A'},
		{commit: '🐛 Fix B'},
		{commit: '✨ Add C'},
	]);
	const {releases} = await buildChangelog({
		cwd: repo.dir,
		config,
		since: 'HEAD~2',
	});
	expect(releases).toHaveLength(1);
	expect(releases[0]).toMatchObject({version: 'Unreleased', tag: null});
	const descriptions = releases[0]!.groups.flatMap(group =>
		group.commits.map(commit => commit.description),
	);
	expect(descriptions.sort()).toEqual(['Add C', 'Fix B']);
	expect(releases[0]!.nextVersion).toBe('1.1.0');
});

test('since rejects an unknown ref and the flags it cannot combine with', async () => {
	repo = await createRepo([{commit: '🎉 Init'}, {commit: '✨ Add A'}]);
	await expect(
		buildChangelog({cwd: repo.dir, config, since: 'nope'}),
	).rejects.toThrow('Unknown revision: nope');
	await expect(
		buildChangelog({cwd: repo.dir, config, since: 'HEAD~1', release: '1.0.0'}),
	).rejects.toThrow(/--since.*--from or --release/);
});
