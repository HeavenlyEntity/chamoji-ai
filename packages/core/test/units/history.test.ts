import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {loadConfig} from '../../src/config.js';
import type {Release} from '../../src/types.js';
import {unitChangelog} from '../../src/units/history.js';
import {createRepo, type RepoStep} from '../helpers/fixture-repo.js';

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

const CONFIG = {
	release: {
		schema: 1,
		shape: 'apps',
		units: {
			web: {path: 'apps/web', tag: 'web/v{version}'},
			mobile: {path: 'apps/mobile', tag: 'mobile/v{version}'},
		},
	},
};

const uses = {'@gearz/supabase': 'workspace:*'};
const FILES: Record<string, string> = {
	'package.json': json({name: 'gearz', private: true}),
	'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
	'chamoji.config.json': json(CONFIG),
	'apps/web/package.json': json({
		name: '@gearz/web',
		version: '0.1.0',
		private: true,
		dependencies: uses,
	}),
	'apps/mobile/package.json': json({
		name: '@gearz/mobile',
		version: '1.0.0',
		private: true,
		dependencies: uses,
	}),
	'packages/supabase/package.json': json({
		name: '@gearz/supabase',
		version: '0.0.0',
		private: true,
	}),
};

const START: RepoStep = {commit: '🎉 Start the gearz monorepo', files: FILES};
const WEB_FEATURE: RepoStep = {
	commit: '✨ Add the dashboard',
	files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
};
const SHARED_FIX: RepoStep = {
	commit: '🐛 Fix the session refresh',
	files: {'packages/supabase/src/session.ts': 'refresh\n'},
};
const MOBILE_FIX: RepoStep = {
	commit: '🐛 Fix the camera crash',
	files: {'apps/mobile/src/camera.ts': 'camera\n'},
};
const WEB_FIX: RepoStep = {
	commit: '🐛 Fix the dashboard total',
	files: {'apps/web/src/dashboard.ts': 'total\n'},
};

async function repoFrom(steps: RepoStep[]): Promise<string> {
	const repo = await createRepo(steps);
	cleanups.push(repo.cleanup);
	return repo.dir;
}

const subjects = (release: Release) =>
	release.groups.flatMap(group => group.commits.map(commit => commit.subject));

test("a unit's changelog has a section per tag, and its unreleased window", async () => {
	const dir = await repoFrom([
		START,
		{tag: 'web/v0.1.0', annotated: true},
		{tag: 'mobile/v1.0.0', annotated: true},
		WEB_FEATURE,
		SHARED_FIX,
		{tag: 'web/v0.2.0', annotated: true},
		MOBILE_FIX,
		WEB_FIX,
	]);
	const changelog = await unitChangelog({
		cwd: dir,
		config: await loadConfig(dir),
		unit: 'web',
	});

	expect(
		changelog.releases.map(release => [
			release.version,
			release.tag,
			release.previousTag,
		]),
	).toEqual([
		['Unreleased', null, 'web/v0.2.0'],
		['0.2.0', 'web/v0.2.0', 'web/v0.1.0'],
		['0.1.0', 'web/v0.1.0', null],
	]);
	const [unreleased, second, first] = changelog.releases;
	expect(unreleased!.date).toBeNull();
	expect(subjects(unreleased!)).toEqual(['🐛 Fix the dashboard total']);
	expect(second!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	expect(subjects(second!).sort()).toEqual([
		'✨ Add the dashboard',
		'🐛 Fix the session refresh',
	]);
	const shared = second!.groups
		.flatMap(group => group.commits)
		.find(commit => commit.subject === '🐛 Fix the session refresh');
	expect(shared?.via).toBe('packages/supabase');
	expect(subjects(first!)).toEqual(['🎉 Start the gearz monorepo']);
	// Another unit's commits never show.
	expect(changelog.releases.flatMap(subjects)).not.toContain(
		'🐛 Fix the camera crash',
	);
});

test('a unit with nothing unreleased has no Unreleased section', async () => {
	const dir = await repoFrom([
		START,
		{tag: 'web/v0.1.0', annotated: true},
		MOBILE_FIX,
	]);
	const changelog = await unitChangelog({
		cwd: dir,
		config: await loadConfig(dir),
		unit: 'web',
	});
	expect(changelog.releases.map(release => release.version)).toEqual(['0.1.0']);
});

test("the oldest release starts at the repo's starting point", async () => {
	const dir = await repoFrom([
		{...START, commit: '🎉 Start from the template'},
		{
			commit: '✨ Add the template home page',
			files: {'apps/web/src/home.ts': 'home\n'},
		},
		WEB_FEATURE,
		{tag: 'web/v0.1.0', annotated: true},
	]);
	const {stdout} = await execFileAsync('git', ['rev-parse', 'HEAD'], {
		cwd: dir,
	});
	await writeFile(
		path.join(dir, 'chamoji.config.json'),
		json({
			release: {
				...CONFIG.release,
				upstream: {name: 'Template', since: stdout.trim()},
			},
		}),
	);
	const changelog = await unitChangelog({
		cwd: dir,
		config: await loadConfig(dir),
		unit: 'web',
	});
	expect(changelog.releases.map(subjects)).toEqual([['✨ Add the dashboard']]);
});

test('an unknown unit fails with the planner error', async () => {
	const dir = await repoFrom([START]);
	await expect(
		unitChangelog({cwd: dir, config: await loadConfig(dir), unit: 'admin'}),
	).rejects.toThrow('unknown unit "admin"; the units are web, mobile');
});
