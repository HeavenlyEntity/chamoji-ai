import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
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
