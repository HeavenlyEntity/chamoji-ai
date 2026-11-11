import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {
	answersFromSection,
	applyAnswer,
	currentAnswer,
	questions,
	recommend,
	releaseSection,
} from '../../src/index.js';
import {useDetection, valid} from '../helpers/setup-detection.js';
import {
	gearzLayout,
	libraryLayout,
	publicApps,
	publishableLibraries,
	singlePackage,
} from '../helpers/setup-fixtures.js';

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
		schema: 2,
		shape: 'apps',
		trigger: 'merge',
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
		upstream: {
			remote: 'upstream',
			name: 'Makerkit',
			since,
		},
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

test('a ticked app with tags of its own takes their format', async () => {
	const detection = await detected(
		gearzLayout({
			extraSteps: [
				{commit: '✅ Add a smoke test', files: {'apps/e2e/smoke.ts': '1\n'}},
				{tag: 'e2e-v1.0.0'},
			],
		}),
	);
	// perUnit stays the detected units'; the candidate's formats sit apart.
	expect(Object.keys(detection.tags.perUnit).sort()).toEqual(['mobile', 'web']);
	expect(detection.tags.candidates['apps/e2e']?.last).toEqual({
		tag: 'e2e-v1.0.0',
		version: '1.0.0',
	});
	const answers = recommend(detection);
	const ticked = applyAnswer(detection, answers, 'units', [
		...answers.units.map(unit => unit.path),
		'apps/e2e',
	]);
	expect(ticked.units.find(unit => unit.name === 'e2e')).toMatchObject({
		tag: 'e2e-v{version}',
		read: [],
	});
	// Its tag was a stray while e2e wasn't a unit; it isn't ignored any more.
	expect(answers.ignore.some(pattern => /e2e/.test(pattern))).toBe(true);
	expect(valid(releaseSection(ticked)).tags.ignore).toEqual(
		answers.ignore.filter(pattern => !/e2e/.test(pattern)),
	);
	expect(
		questions(detection, ticked).find(question => question.id === 'tag:e2e')
			?.found,
	).toBe("e2e's last tag is e2e-v1.0.0");
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
	// The section has no trigger, so that one is asked again, recommending merge.
	expect(answers.why.trigger).toBe('recommended');
	expect(
		new Set(
			Object.entries(answers.why)
				.filter(([id]) => id !== 'trigger')
				.map(([, source]) => source),
		),
	).toEqual(new Set(['kept']));
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

test('currentAnswer reads each question back in the form applyAnswer takes', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = recommend(detection);
	expect(currentAnswer(answers, 'shape')).toBe('apps');
	expect(currentAnswer(answers, 'units')).toEqual(['apps/mobile', 'apps/web']);
	expect(currentAnswer(answers, 'firstVersion:web')).toBe('');
	expect(currentAnswer(answers, 'zeroMajor')).toBe('minor');
	expect(currentAnswer(answers, 'rootChangelog')).toBe('false');
	expect(currentAnswer(answers, 'upstream.name')).toBe('Makerkit');
	// Answering every question with its current answer changes no setting.
	for (const question of questions(detection, answers)) {
		const again = applyAnswer(
			detection,
			answers,
			question.id,
			currentAnswer(answers, question.id),
		);
		expect(releaseSection(again)).toEqual(releaseSection(answers));
	}

	const aliased = answersFromSection(rerunSection(), detection);
	expect(currentAnswer(aliased, 'alias:final-release')).toBe('1.0.0');
	expect(currentAnswer(aliased, 'alias:web-nightly')).toBe('');
});

test('recommend: merge, auto majors, publish on with a check, oidc', async () => {
	const detection = await detected(publishableLibraries());
	const answers = recommend(detection);
	expect(detection.check).toBe('pnpm check && pnpm test');
	expect(detection.branch).toBe('main');
	expect(answers).toMatchObject({
		trigger: 'merge',
		majors: 'auto',
		publish: {check: 'pnpm check && pnpm test', packages: []},
		ciAuth: 'oidc',
		privatize: [],
		mentions: [],
	});
	expect(answers.why).toMatchObject({
		trigger: 'recommended',
		majors: 'recommended',
		publish: 'detected',
		'publish.check': 'detected',
		ciAuth: 'detected',
	});
	const section = releaseSection(answers);
	expect(section).toMatchObject({
		schema: 2,
		trigger: 'merge',
		publish: {check: 'pnpm check && pnpm test'},
	});
	expect(section).not.toHaveProperty('majors');
	expect(valid(section).publish?.check).toBe('pnpm check && pnpm test');
});

test('a single-package repo gets trigger merge and a section', async () => {
	const detection = await detected(singlePackage());
	const answers = recommend(detection);
	expect(answers.shape).toBe('single');
	expect(answers.trigger).toBe('merge');
	// solo is a public library with no scripts, so publishing is on with no check.
	expect(releaseSection(answers)).toEqual({
		schema: 2,
		shape: 'single',
		trigger: 'merge',
		publish: true,
	});
	expect(valid(releaseSection(answers)).trigger).toBe('merge');
	expect(
		questions(detection, answers)
			.map(question => question.id)
			.slice(0, 4),
	).toEqual(['shape', 'trigger', 'majors', 'publish']);
});

test('an app-only repo is never offered publishing', async () => {
	const detection = await detected(publicApps());
	const answers = recommend(detection);
	expect(answers.publish).toBeNull();
	expect(detection.publishable).toEqual([]);
	const ids = questions(detection, answers).map(question => question.id);
	expect(ids).not.toContain('publish');
	expect(ids).not.toContain('publish.check');
	expect(ids).not.toContain('ciAuth');
	expect(releaseSection(answers)).not.toHaveProperty('publish');
	expect(() => applyAnswer(detection, answers, 'publish', 'on')).toThrow(
		/no public library/,
	);
});

test('a public Next.js app is offered privatize, unticked items untouched', async () => {
	const detection = await detected(publicApps());
	expect(detection.publicApps.map(app => app.path)).toEqual(['apps/web']);
	const answers = recommend(detection);
	expect(answers.privatize).toEqual(['apps/web']);
	const asked = questions(detection, answers).find(
		question => question.id === 'privatize',
	);
	expect(asked?.options).toEqual([
		{value: 'apps/web', label: 'web (apps/web)', recommended: true},
	]);
	expect(asked?.found).toContain('web (app: ');
	const none = applyAnswer(detection, answers, 'privatize', []);
	expect(none.privatize).toEqual([]);
	expect(none.why.privatize).toBe('chosen');
	// A private app, or any other path, isn't offered.
	expect(() =>
		applyAnswer(detection, answers, 'privatize', ['apps/admin']),
	).toThrow(/isn't a public app/);
	// Privatizing is never written to the config.
	expect(JSON.stringify(releaseSection(answers))).not.toContain('privatize');
});

test('a package whose registry is not npm forces the token method', async () => {
	const detection = await detected(
		publishableLibraries({registry: 'https://npm.pkg.github.com'}),
	);
	const answers = recommend(detection);
	expect(answers.ciAuth).toBe('token');
	const asked = questions(detection, answers).find(
		question => question.id === 'ciAuth',
	);
	expect(asked?.found).toBe(
		'@acme/ui publishes to https://npm.pkg.github.com/, which needs an npm token',
	);
	expect(asked?.options.find(option => option.recommended)?.value).toBe(
		'token',
	);
	expect(() => applyAnswer(detection, answers, 'ciAuth', 'oidc')).toThrow(
		/needs an npm token/,
	);
	// The sign-in method isn't a config key (ruling 9).
	expect(JSON.stringify(releaseSection(answers))).not.toContain('ciAuth');
	const plain = await detected(publishableLibraries());
	expect(applyAnswer(plain, recommend(plain), 'ciAuth', 'token').ciAuth).toBe(
		'token',
	);
});

test('re-run: a section without trigger asks trigger again, recommending merge', async () => {
	const detection = await detected(publishableLibraries());
	const section = {
		schema: 1,
		shape: 'libraries',
		units: {core: {path: 'packages/core'}},
	};
	const answers = answersFromSection(section, detection);
	expect(answers.trigger).toBe('merge');
	const trigger = questions(detection, answers).find(
		question => question.id === 'trigger',
	);
	expect(trigger?.needsAnswer).toBe(true);
	expect(trigger?.options.find(option => option.recommended)?.value).toBe(
		'merge',
	);
	// Nothing is written until it is answered, so a no-op stays a no-op.
	expect(releaseSection(answers)).toMatchObject({schema: 1});
	expect(releaseSection(answers)).not.toHaveProperty('trigger');
	const answered = applyAnswer(detection, answers, 'trigger', 'manual');
	expect(releaseSection(answered)).toMatchObject({
		schema: 2,
		trigger: 'manual',
	});
	expect(
		questions(detection, answered).find(question => question.id === 'trigger')
			?.needsAnswer,
	).toBe(false);
	// A fresh recommendation never asks.
	expect(
		questions(detection, recommend(detection)).find(
			question => question.id === 'trigger',
		)?.needsAnswer,
	).toBe(false);
});

test('re-run keeps an existing trigger, majors and publish', async () => {
	const detection = await detected(publishableLibraries());
	const section = {
		schema: 2,
		shape: 'libraries',
		trigger: 'manual',
		majors: 'manual',
		publish: {
			check: 'pnpm build',
			packages: ['@acme/core'],
			prereleaseTag: 'beta',
			registries: ['https://npm.pkg.github.com/'],
		},
		units: {core: {path: 'packages/core'}},
	};
	const answers = answersFromSection(section, detection);
	expect(answers).toMatchObject({
		trigger: 'manual',
		majors: 'manual',
		publish: {check: 'pnpm build', packages: ['@acme/core']},
	});
	expect(answers.triggerUnset).toBeUndefined();
	expect(answers.why.trigger).toBe('kept');
	expect(releaseSection(answers)).toMatchObject(section);
	// Turning publishing off drops the rest of the object with it.
	const off = applyAnswer(detection, answers, 'publish', 'off');
	expect(releaseSection(off)).not.toHaveProperty('publish');
	// A bare true stays a bare true, and the other settings stay.
	const bare = applyAnswer(
		detection,
		applyAnswer(detection, answers, 'publish.check', ''),
		'majors',
		'auto',
	);
	expect(releaseSection(bare)).toMatchObject({
		publish: {
			packages: ['@acme/core'],
			prereleaseTag: 'beta',
			registries: ['https://npm.pkg.github.com/'],
		},
	});
	expect(releaseSection(bare)).not.toHaveProperty('majors');
});

test('version pins in the docs are offered, owned by a unit, and never in a single repo', async () => {
	const detection = await detected(
		publishableLibraries({
			extraSteps: [
				{
					commit: '📝 Pin versions in the docs',
					files: {
						'README.md': 'npm i @acme/ui@1.2.0 and use acme/libs@v1.2.0\n',
					},
				},
			],
		}),
	);
	// With no origin there's no repo pin; the package's own is offered.
	expect(detection.mentions).toEqual([
		{pattern: '@acme/ui@{version}', files: ['README.md'], unit: 'ui'},
	]);
	const answers = recommend(detection);
	expect(answers.mentions).toEqual(detection.mentions);
	expect(answers.why.mentions).toBe('detected');
	expect(valid(releaseSection(answers)).mentions).toEqual(detection.mentions);
	const ask = questions(detection, answers).find(
		question => question.id === 'mentions',
	);
	expect(ask?.options).toEqual([
		{
			value: '@acme/ui@{version}',
			label: '@acme/ui@{version}',
			recommended: true,
		},
	]);
	expect(ask?.found).toBe('@acme/ui@{version} is in README.md');

	const none = applyAnswer(detection, answers, 'mentions', []);
	expect(none.mentions).toEqual([]);
	expect(releaseSection(none)).not.toHaveProperty('mentions');
	const again = applyAnswer(detection, none, 'mentions', [
		'@acme/ui@{version}',
	]);
	expect(again.mentions).toEqual(detection.mentions);
	expect(() =>
		applyAnswer(detection, answers, 'mentions', ['nothing@{version}']),
	).toThrow(/wasn't found/);

	// A single repo holds the same pin with no unit.
	const single = applyAnswer(detection, answers, 'shape', 'single');
	expect(single.mentions).toEqual([
		{pattern: '@acme/ui@{version}', files: ['README.md']},
	]);
	expect(valid(releaseSection(single)).mentions).toHaveLength(1);
});
