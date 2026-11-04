import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {DEFAULT_GROUP_CONFIG} from '../../src/config.js';
import {
	applyAnswer,
	previewReleases,
	recommend,
	replayReleases,
	replayText,
	type Detection,
	type SetupAnswers,
} from '../../src/index.js';
import type {RepoStep} from '../helpers/fixture-repo.js';
import {useDetection} from '../helpers/setup-detection.js';
import {gearzLayout} from '../helpers/setup-fixtures.js';

const execFileAsync = promisify(execFile);
const {detected, repo} = useDetection();

const config = {groups: DEFAULT_GROUP_CONFIG};
const TODAY = '2026-11-04';

const WEB: RepoStep = {
	commit: '✨ Add the dashboard',
	files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
};
const SHARED: RepoStep = {
	commit: '🐛 Fix the session refresh',
	files: {'packages/supabase/src/session.ts': 'refresh\n'},
};

const MOBILE_USES_SUPABASE: RepoStep = {
	commit: '📝 Note that mobile uses the shared supabase package',
	files: {
		'apps/mobile/package.json': `${JSON.stringify({name: 'mobile', version: '1.0.0', dependencies: {'@gearz/supabase': 'workspace:*'}}, null, 2)}\n`,
	},
};

async function previewed(
	steps: RepoStep[],
	change: (detection: Detection, answers: SetupAnswers) => SetupAnswers = (
		_,
		answers,
	) => answers,
) {
	const detection = await detected(gearzLayout({extraSteps: steps}));
	const answers = change(detection, recommend(detection));
	return {
		detection,
		answers,
		preview: await previewReleases(repo().dir, config, answers, TODAY),
	};
}

test('gearz: web releases 0.1.0 first, mobile waits on shared changes, e2e never appears', async () => {
	const {preview} = await previewed([MOBILE_USES_SUPABASE, WEB, SHARED]);
	expect(preview.heading).toBe('The next release from here would be:');
	expect(preview.warnings).toEqual([]);
	const byUnit = Object.fromEntries(preview.units.map(u => [u.unit, u]));
	expect(byUnit['web']).toMatchObject({
		status: 'releases',
		// No tag yet, so the version before is the manifest's.
		from: '0.1.0',
		version: '0.1.0',
		tag: 'web/v0.1.0',
	});
	expect(byUnit['web']!.status === 'releases' && byUnit['web']!.notes).toEqual(
		expect.arrayContaining([expect.stringContaining('Add the dashboard')]),
	);
	expect(byUnit['mobile']).toEqual({
		status: 'waits',
		unit: 'mobile',
		own: 2,
		shared: 1,
	});
	expect(Object.keys(byUnit)).not.toContain('e2e');
});

test('the preview works on a dirty tree, another branch and a detached HEAD', async () => {
	const {preview: clean, answers} = await previewed([WEB]);
	const dir = repo().dir;
	await writeFile(path.join(dir, 'apps/web/src/wip.ts'), 'wip\n');
	await execFileAsync('git', ['checkout', '-q', '-b', 'feature/x'], {cwd: dir});
	const onBranch = await previewReleases(dir, config, answers, TODAY);
	await execFileAsync('git', ['checkout', '-q', '--detach'], {cwd: dir});
	const detached = await previewReleases(dir, config, answers, TODAY);
	expect(clean.units.map(u => u.status)).toContain('releases');
	for (const preview of [onBranch, detached]) {
		expect(preview.warnings).toEqual([]);
		expect(preview).toEqual(clean);
	}
});

test('changing sharedChanges to release-dependents makes mobile release in the preview', async () => {
	const {preview} = await previewed(
		[MOBILE_USES_SUPABASE, WEB, SHARED],
		(detection, answers) =>
			applyAnswer(detection, answers, 'sharedChanges', 'release-dependents'),
	);
	const mobile = preview.units.find(u => u.unit === 'mobile');
	expect(mobile).toMatchObject({status: 'releases', from: '1.0.0'});
});

const section = (version: string, date: string, lines: string[]) =>
	`## [${version}] - ${date}\n\n### Added\n\n${lines.map(line => `- ${line}`).join('\n')}\n`;

test('replay lines up the last releases with what was shipped', async () => {
	const steps: RepoStep[] = [
		WEB,
		{
			commit: '👷 Cache the pnpm store',
			files: {'packages/supabase/src/ci.ts': 'cache\n'},
		},
		{
			commit: '🔖 Release web 1.0.0',
			files: {
				'apps/web/CHANGELOG.md': `# Changelog\n\n${section('1.0.0', '2026-02-01', ['✨ Start the gearz monorepo', '✨ Add the dashboard'])}`,
			},
		},
		{tag: 'web/v1.0.0'},
		{
			commit: '✨ Add the reports page',
			files: {'apps/web/src/reports.ts': 'reports\n'},
		},
		{
			commit: '🔖 Release web 1.1.0',
			files: {
				'apps/web/CHANGELOG.md': `# Changelog\n\n${section('1.1.0', '2026-03-01', ['✨ Add the reports page'])}\n${section('1.0.0', '2026-02-01', ['x'])}`,
			},
		},
		{tag: 'web/v1.1.0'},
	];
	const detection = await detected(gearzLayout({extraSteps: steps}));
	const lines = await replayReleases(repo().dir, config, recommend(detection));
	const text = lines.map(replayText);
	expect(text).toEqual([
		'web v1.1.0: same 1 entry',
		'web v1.0.0: you shipped 2 entries; chamoji would write 3, and the extra one is "👷 Cache the pnpm store"',
	]);
	expect(lines.map(line => line.unit)).toEqual(['web', 'web']);
});

test('no past releases: no replay', async () => {
	const detection = await detected(gearzLayout({extraSteps: [WEB]}));
	expect(
		await replayReleases(repo().dir, config, recommend(detection)),
	).toEqual([]);
});

test('replayText reads the three ways a release can compare', () => {
	const line = {unit: 'web', tag: 'web/v2.3.0', extra: [], missing: []};
	expect(
		replayText({
			...line,
			shipped: 14,
			chamoji: 15,
			extra: ['👷 Cache the pnpm store'],
		}),
	).toBe(
		'web v2.3.0: you shipped 14 entries; chamoji would write 15, and the extra one is "👷 Cache the pnpm store"',
	);
	expect(replayText({...line, tag: 'web/v2.2.0', shipped: 9, chamoji: 9})).toBe(
		'web v2.2.0: same 9 entries',
	);
	expect(
		replayText({...line, tag: 'web/v2.1.0', shipped: null, chamoji: 7}),
	).toBe('web v2.1.0: no changelog then; chamoji would write 7 entries');
});
