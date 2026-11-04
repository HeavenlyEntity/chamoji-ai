import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {
	answersFromSection,
	applyAnswer,
	detect,
	parseReleaseSettings,
	questions,
	recommend,
	releaseSection,
	summary,
	writeReleaseSection,
	type Detection,
} from '../../src/index.js';
import type {FixtureRepo, RepoStep} from '../helpers/fixture-repo.js';
import {gearzLayout, libraryLayout} from '../helpers/setup-fixtures.js';

const execFileAsync = promisify(execFile);

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

async function detected(made: Promise<FixtureRepo>): Promise<Detection> {
	repo = await made;
	return detect(repo.dir);
}

const valid = (section: Record<string, unknown>) =>
	parseReleaseSettings(section, 'chamoji.config.json');

test("gearz: the recommended section is the spec's example", async () => {
	const detection = await detected(gearzLayout({template: true}));
	const {stdout} = await execFileAsync(
		'git',
		['rev-list', '--reverse', 'HEAD', '--not', '--remotes=upstream'],
		{cwd: repo!.dir},
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

	const calver = applyAnswer(answers, 'versioning:web', 'calver');
	expect(calver.why['versioning:web']).toBe('chosen');
	const web = valid(releaseSection(calver)).units.find(
		unit => unit.name === 'web',
	);
	expect(web?.versioning).toBe('calver');

	await repo!.cleanup();
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
	const settings = valid(section);
	expect(settings.units.map(unit => unit.tag)).toEqual([
		'v{version}',
		'v{version}',
		'v{version}',
	]);
});

test("summary reads like the spec's example", async () => {
	const detection = await detected(gearzLayout({template: true}));
	expect(summary(detection, recommend(detection))).toBe(
		"Found 4 apps (mobile, web, dev-tool, e2e) and 2 internal packages. mobile and web get their own versions; dev-tool, e2e and tooling are left out. 3 tags look like they came from Makerkit and will be ignored. Shared changes ride along with each app's own releases.",
	);
});

test('summary ends with a tag that disagrees with its manifest, then squashed syncs', async () => {
	const syncs: RepoStep[] = [1, 2].map(n => ({
		commit: `Merge upstream Makerkit changes (${n})`,
		files: {'packages/ui/index.ts': `export const n = ${n};\n`},
	}));
	const detection = await detected(
		gearzLayout({
			template: true,
			extraSteps: [{tag: 'web/v1.3.0'}, ...syncs],
		}),
	);
	const text = summary(detection, recommend(detection));
	expect(text).toMatch(
		/ releases\. web's last tag says 1\.3\.0 but apps\/web\/package\.json says 0\.1\.0; the tag wins, and the release sets the file to the new version\. 2 commits look like squash-merged Makerkit syncs; they count as ordinary commits\.$/,
	);
});

test('only undetectable questions need an answer', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const asked = questions(detection, recommend(detection));
	expect(
		asked
			.filter(question => question.needsAnswer)
			.map(question => question.id)
			.sort(),
	).toEqual([
		'firstVersion:mobile',
		'firstVersion:web',
		'upstream.name',
		'zeroMajor',
	]);
	// Everything else is still there to change.
	expect(asked.map(question => question.id)).toEqual(
		expect.arrayContaining([
			'shape',
			'units',
			'name:web',
			'tag:web',
			'versionFiles:mobile',
			'buildNumber:mobile',
			'ignore',
			'sharedChanges',
			'rootFiles',
			'rootChangelog',
		]),
	);
	const upstream = asked.find(question => question.id === 'upstream.name')!;
	expect(upstream.options).toEqual([
		{value: 'Makerkit', label: 'Makerkit', recommended: true},
	]);
});

test("found copy uses the repo's own examples", async () => {
	const detection = await detected(
		gearzLayout({
			extraSteps: [
				{tag: 'web/v0.1.0'},
				{
					commit: '⬆️ Bump deps',
					files: {'pnpm-lock.yaml': 'lockfileVersion: 9\n'},
				},
				{
					commit: '👷 Cache pnpm',
					files: {'.github/workflows/ci.yml': 'name: ci\n'},
				},
			],
		}),
	);
	const asked = questions(detection, recommend(detection));
	expect(asked.find(question => question.id === 'rootFiles')!.found).toBe(
		'2 commits since your last release touched only pnpm-lock.yaml or .github/',
	);
	const files = asked.find(question => question.id === 'versionFiles:mobile')!;
	expect(files.kind).toBe('ticks');
	expect(files.options).toEqual([
		{
			value: 'apps/mobile/app.config.ts',
			label: 'apps/mobile/app.config.ts',
			recommended: true,
		},
	]);
});

test('a unit can be renamed only to a unique lowercase name', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = recommend(detection);
	const renamed = applyAnswer(answers, 'name:web', 'site');
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
		expect(() => applyAnswer(answers, 'name:web', bad)).toThrow(
			'^[a-z0-9][a-z0-9._-]*$',
		);
	}
});

test("a re-run starts from the existing section and keeps keys it doesn't ask about", async () => {
	const detection = await detected(gearzLayout({template: true}));
	const original = `{
	"release": {
		"schema": 1,
		"shape": "apps",
		"units": {
			"web": {
				"path": "apps/web",
				"tag": "web/v{version}",
				"changelog": "docs/CHANGELOG.md"
			}
		},
		"exclude": ["apps/mobile"],
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
	const answers = answersFromSection(
		(JSON.parse(original) as {release: unknown}).release,
		detection,
	);
	expect(answers.units.map(unit => unit.name)).toEqual(['web']);
	expect(answers.ignore).toEqual(['^wip/']);
	expect(answers.kept).toEqual({
		units: {web: {changelog: 'docs/CHANGELOG.md'}},
		tags: {aliases: {'final-release': {unit: 'web', version: '1.0.0'}}},
		githubReleases: 'combined',
	});
	expect(new Set(Object.values(answers.why))).toEqual(new Set(['kept']));
	expect(writeReleaseSection(original, releaseSection(answers))).toEqual({
		text: original,
		changed: false,
	});

	// A change rewrites the section and still carries the kept keys.
	const changed = writeReleaseSection(
		original,
		releaseSection(applyAnswer(answers, 'rootFiles', 'note')),
	);
	expect(changed.changed).toBe(true);
	expect(JSON.parse(changed.text)).toMatchObject({
		release: {
			rootFiles: 'note',
			units: {web: {changelog: 'docs/CHANGELOG.md'}},
			tags: {aliases: {'final-release': {unit: 'web', version: '1.0.0'}}},
			githubReleases: 'combined',
		},
	});
});

test('writing keeps other keys, the indent and the missing trailing newline', () => {
	const section = {schema: 1, shape: 'single'};
	const groups = [{group: 'added', label: 'Added', emojis: ['sparkles']}];
	for (const indent of ['\t', '    ']) {
		const original = `{\n${indent}"version": 1.0,\n${indent}"groups": ${JSON.stringify(groups)}\n}`;
		const {text, changed} = writeReleaseSection(original, section);
		expect(changed).toBe(true);
		expect(text).toBe(
			`{\n${indent}"version": 1.0,\n${indent}"groups": ${JSON.stringify(groups, null, indent).replaceAll('\n', `\n${indent}`)},\n${indent}"release": ${JSON.stringify(section, null, indent).replaceAll('\n', `\n${indent}`)}\n}`,
		);
		expect(writeReleaseSection(text, section)).toEqual({text, changed: false});
	}

	expect(writeReleaseSection(null, section)).toEqual({
		text: '{\n  "release": {\n    "schema": 1,\n    "shape": "single"\n  }\n}\n',
		changed: true,
	});
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

	const aliased = applyAnswer(answers, 'alias:web-final-release', '1.0.0');
	expect(valid(releaseSection(aliased)).tags.aliases).toEqual({
		'web-final-release': {unit: 'web', version: '1.0.0'},
	});
	expect(
		questions(detection, aliased).find(
			question => question.id === 'alias:web-final-release',
		)?.needsAnswer,
	).toBe(false);
});

test('an answer the engine would refuse throws and changes nothing', async () => {
	const detection = await detected(gearzLayout());
	const answers = recommend(detection);
	expect(() => applyAnswer(answers, 'tag:web', 'web-latest')).toThrow(
		'{version}',
	);
	expect(() => applyAnswer(answers, 'rootFiles', 'some')).toThrow(
		'rootFiles must be one of none, all, note',
	);
	expect(answers).toEqual(recommend(detection));
});
