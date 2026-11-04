import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {
	answersFromSection,
	applyAnswer,
	questions,
	recommend,
	releaseSection,
} from '../../src/index.js';
import {useDetection, valid} from '../helpers/setup-detection.js';
import {gearzLayout, libraryLayout} from '../helpers/setup-fixtures.js';

const execFileAsync = promisify(execFile);
const {detected, repo} = useDetection();

test("gearz: the recommended section is the spec's example", async () => {
	const detection = await detected(gearzLayout({template: true}));
	const {stdout} = await execFileAsync(
		'git',
		['rev-list', '--reverse', 'HEAD', '--not', '--remotes=upstream'],
		{cwd: repo().dir},
	);
	const since = stdout.split('\n')[0];
	expect(releaseSection(recommend(detection))).toEqual({
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
		exclude: ['apps/dev-tool', 'apps/e2e', 'tooling/*'],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		zeroMajor: 'minor',
		upstream: {remote: 'upstream', name: 'Makerkit', since},
		tags: {
			ignore: [
				String.raw`^\d+\.\d+\.\d+$`,
				String.raw`^v\d+\.\d+\.\d+-\d+$`,
				'^wip/',
			],
		},
	});
});

test('the written section passes parseReleaseSettings', async () => {
	const gearz = await detected(gearzLayout({template: true}));
	const answers = recommend(gearz);
	expect(valid(releaseSection(answers)).units.map(unit => unit.name)).toEqual([
		'mobile',
		'web',
	]);

	const calver = applyAnswer(gearz, answers, 'versioning:web', 'calver');
	expect(calver.why['versioning:web']).toBe('chosen');
	const web = valid(releaseSection(calver)).units.find(
		unit => unit.name === 'web',
	);
	expect(web?.versioning).toBe('calver');

	const libraries = await detected(
		libraryLayout({
			extraSteps: [{commit: '🔖 Release 1.2.0'}, {tag: 'v1.2.0'}],
		}),
	);
	const section = releaseSection(recommend(libraries));
	expect(section).toMatchObject({
		shape: 'libraries',
		sharedChanges: 'release-dependents',
		fixed: [['cli', 'core', 'types']],
	});
	expect(valid(section).units.map(unit => unit.tag)).toEqual([
		'v{version}',
		'v{version}',
		'v{version}',
	]);
});

test('a unit can be renamed only to a unique lowercase name', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = recommend(detection);
	const renamed = applyAnswer(detection, answers, 'name:web', 'site');
	expect(renamed.units.map(unit => unit.name).sort()).toEqual([
		'mobile',
		'site',
	]);
	expect(renamed.why['name:site']).toBe('chosen');
	// The tag keeps its format (ruling R9).
	expect(releaseSection(renamed).units).toMatchObject({
		site: {path: 'apps/web', tag: 'web/v{version}'},
	});
	for (const bad of ['Site', 'mobile', '-web', '']) {
		expect(() => applyAnswer(detection, answers, 'name:web', bad)).toThrow(
			'^[a-z0-9][a-z0-9._-]*$',
		);
	}
});

test('a newly ticked unit is filled in as recommend fills one', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = recommend(detection);
	const ticked = applyAnswer(detection, answers, 'units', [
		...answers.units.map(unit => unit.path),
		'apps/e2e',
	]);
	expect(ticked.units.find(unit => unit.name === 'e2e')).toEqual({
		name: 'e2e',
		path: 'apps/e2e',
		tag: 'e2e/v{version}',
		read: [],
		versionFiles: [],
		buildNumber: 'untouched',
		versioning: 'semver',
	});
	expect(ticked.exclude).toEqual(['apps/dev-tool', 'tooling/*']);

	// Unticking mobile and ticking it again brings back its detected settings.
	const without = applyAnswer(detection, ticked, 'units', [
		'apps/e2e',
		'apps/web',
	]);
	expect(without.exclude).toContain('apps/mobile');
	const back = applyAnswer(detection, without, 'units', [
		'apps/e2e',
		'apps/mobile',
		'apps/web',
	]);
	expect(back.units.find(unit => unit.name === 'mobile')).toEqual(
		answers.units.find(unit => unit.name === 'mobile'),
	);
});

test('changing the shape re-runs the recommendation and keeps chosen answers', async () => {
	const detection = await detected(gearzLayout({template: true}));
	let answers = recommend(detection);
	answers = applyAnswer(detection, answers, 'rootFiles', 'note');
	answers = applyAnswer(detection, answers, 'name:web', 'site');

	// Re-choosing the same shape keeps unit answers, following the unit by path.
	const same = applyAnswer(detection, answers, 'shape', 'apps');
	expect(releaseSection(same)).toEqual(releaseSection(answers));
	expect(same.why).toMatchObject({
		shape: 'chosen',
		rootFiles: 'chosen',
		'name:site': 'chosen',
	});

	// gearz has no published packages, so libraries has no units, and nothing
	// of the apps is left behind.
	const libraries = applyAnswer(detection, answers, 'shape', 'libraries');
	const section = releaseSection(libraries);
	expect(valid(section).units).toEqual([]);
	expect(section).toMatchObject({
		shape: 'libraries',
		units: {},
		exclude: [],
		sharedChanges: 'release-dependents',
		rootFiles: 'note',
	});

	// Back to apps: the recommendation again, with the answers that applied
	// under libraries. The rename didn't (web wasn't a unit), so it's gone.
	const apps = applyAnswer(detection, libraries, 'shape', 'apps');
	expect(releaseSection(apps)).toEqual(
		releaseSection(
			applyAnswer(detection, recommend(detection), 'rootFiles', 'note'),
		),
	);
});

const RERUN = `{
	"release": {
		"schema": 1,
		"shape": "apps",
		"units": {
			"web": {
				"path": "apps/web",
				"tag": "web/v{version}",
				"changelog": "docs/CHANGELOG.md"
			},
			"mobile": {"path": "apps/mobile", "tag": "mobile/v{version}"}
		},
		"exclude": [],
		"sharedChanges": "ride-along",
		"rootFiles": "none",
		"tags": {
			"ignore": ["^wip/"],
			"aliases": {"final-release": {"unit": "web", "version": "1.0.0"}}
		},
		"githubReleases": "combined"
	}
}
`;

const rerunSection = (): unknown =>
	(JSON.parse(RERUN) as {release: unknown}).release;

test("a re-run starts from the existing section and keeps keys it doesn't ask about", async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = answersFromSection(rerunSection(), detection);
	expect(answers.units.map(unit => unit.name)).toEqual(['web', 'mobile']);
	expect(answers.ignore).toEqual(['^wip/']);
	expect(answers.kept).toEqual({
		units: {web: {changelog: 'docs/CHANGELOG.md'}},
		tags: {aliases: {'final-release': {unit: 'web', version: '1.0.0'}}},
		githubReleases: 'combined',
	});
	expect(new Set(Object.values(answers.why))).toEqual(new Set(['kept']));
	// The EAS setting comes from detection, so buildNumber is written (R11).
	expect(answers.units.find(unit => unit.name === 'mobile')?.eas).toBe(
		'remote',
	);
	expect(releaseSection(answers).units).toMatchObject({
		mobile: {buildNumber: 'untouched'},
	});
	expect(JSON.stringify(releaseSection(answers))).not.toContain('"eas"');
});

test('switching a configured repo to single drops unit-only kept keys', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = answersFromSection(rerunSection(), detection);
	const single = applyAnswer(detection, answers, 'shape', 'single');
	expect(releaseSection(single)).toEqual({schema: 1, shape: 'single'});
	expect(valid(releaseSection(single)).shape).toBe('single');
});

test('a new tag format keeps reading the old one only for a unit with tags', async () => {
	const detection = await detected(
		gearzLayout({extraSteps: [{tag: 'web/v0.1.0'}]}),
	);
	const answers = recommend(detection);
	const web = applyAnswer(detection, answers, 'tag:web', 'web@{version}');
	expect(web.units.find(unit => unit.name === 'web')?.read).toEqual([
		'web/v{version}',
	]);
	const mobile = applyAnswer(
		detection,
		answers,
		'tag:mobile',
		'mobile@{version}',
	);
	expect(mobile.units.find(unit => unit.name === 'mobile')?.read).toEqual([]);
});

test('an unparseable tag needs an alias, which lands in tags.aliases', async () => {
	const detection = await detected(
		gearzLayout({extraSteps: [{tag: 'web-final-release'}]}),
	);
	const answers = recommend(detection);
	const alias = questions(detection, answers).find(
		question => question.id === 'alias:web-final-release',
	);
	expect(alias?.needsAnswer).toBe(true);

	const aliased = applyAnswer(
		detection,
		answers,
		'alias:web-final-release',
		'1.0.0',
	);
	expect(valid(releaseSection(aliased)).tags.aliases).toEqual({
		'web-final-release': {unit: 'web', version: '1.0.0'},
	});
	expect(
		questions(detection, aliased).find(
			question => question.id === 'alias:web-final-release',
		)?.needsAnswer,
	).toBe(false);
	// Only a tag detection couldn't read takes an alias.
	expect(() =>
		applyAnswer(detection, answers, 'alias:web-nightly', '1.0.0'),
	).toThrow('no unit has web-nightly');
});

test('an answer the engine would refuse throws and changes nothing', async () => {
	const detection = await detected(gearzLayout());
	const answers = recommend(detection);
	expect(() =>
		applyAnswer(detection, answers, 'tag:web', 'web-latest'),
	).toThrow('{version}');
	expect(() => applyAnswer(detection, answers, 'rootFiles', 'some')).toThrow(
		'rootFiles must be one of none, all, note',
	);
	expect(answers).toEqual(recommend(detection));
});
