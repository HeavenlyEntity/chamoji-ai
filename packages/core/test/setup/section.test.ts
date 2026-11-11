import {expect, test} from 'vitest';
import {
	answersFromSection,
	releaseSection,
	writeReleaseSection,
} from '../../src/index.js';
import {recommend} from '../../src/index.js';
import {useDetection, valid} from '../helpers/setup-detection.js';
import {gearzLayout, singlePackage} from '../helpers/setup-fixtures.js';

const {detected} = useDetection();

test('a no-op re-run leaves a section alone, even one not written in canonical form', async () => {
	const detection = await detected(gearzLayout({template: true}));
	// No tag (the default), no sharedChanges, and defaults spelled out.
	for (const original of [
		`{
	"release": {
		"schema": 1,
		"shape": "apps",
		"units": {
			"web": {"path": "apps/web", "versioning": "semver", "buildNumber": "untouched", "read": []}
		},
		"exclude": ["apps/mobile"],
		"rootChangelog": false,
		"tags": {"ignore": ["^wip/"], "aliases": {"final-release": {"unit": "web", "version": "1.0.0"}}},
		"githubReleases": "combined"
	}
}
`,
		'{"groups": [], "release": {"schema": 1.0, "shape": "apps", "units": {"web": {"path": "apps/web/", "tag": "{unit}/v{version}"}}}}',
		// Authors in another case and order mean the same.
		'{"release": {"schema": 1, "shape": "apps", "units": {"web": {"path": "apps/web"}}, "upstream": {"name": "Makerkit", "authors": ["CI@makerkit.dev", "Bot@Makerkit.dev"]}}}',
	]) {
		const answers = answersFromSection(
			(JSON.parse(original) as {release: unknown}).release,
			detection,
		);
		expect(writeReleaseSection(original, releaseSection(answers))).toEqual({
			text: original,
			changed: false,
		});
	}
});

test('a change rewrites the section and still carries the kept keys', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const original = `{
	"release": {
		"schema": 1,
		"shape": "apps",
		"units": {"web": {"path": "apps/web", "changelog": "docs/CHANGELOG.md"}},
		"githubReleases": "combined"
	}
}
`;
	const answers = answersFromSection(
		(JSON.parse(original) as {release: unknown}).release,
		detection,
	);
	const {text, changed} = writeReleaseSection(
		original,
		releaseSection({...answers, rootFiles: 'note'}),
	);
	expect(changed).toBe(true);
	expect(JSON.parse(text)).toMatchObject({
		release: {
			rootFiles: 'note',
			units: {web: {changelog: 'docs/CHANGELOG.md'}},
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

test('schema is 2 when trigger, majors, publish or mentions is set, 1 otherwise', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const base = answersFromSection(
		{schema: 1, shape: 'apps', units: {web: {path: 'apps/web'}}},
		detection,
	);
	// A section from before triggers existed stays as it is.
	expect(releaseSection(base)).toMatchObject({schema: 1});
	const keys = Object.keys(releaseSection(base));
	for (const key of ['trigger', 'majors', 'publish', 'mentions']) {
		expect(keys).not.toContain(key);
	}

	const set = (patch: Partial<typeof base>) =>
		releaseSection({...base, ...patch}).schema;
	expect(set({triggerUnset: undefined})).toBe(2);
	expect(set({majors: 'manual'})).toBe(2);
	expect(set({majors: 'auto'})).toBe(1);
	expect(set({publish: {check: null, packages: []}})).toBe(2);
	expect(
		set({
			mentions: [{pattern: 'a/b@v{version}', files: ['a.md'], unit: 'web'}],
		}),
	).toBe(2);
	expect(releaseSection({...base, majors: 'manual'})).toMatchObject({
		majors: 'manual',
	});
});

test('publish true when only the check is default, object when check or packages are set', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const base = recommend(detection);
	const publish = (value: (typeof base)['publish']) =>
		releaseSection({...base, publish: value}).publish;
	expect(publish({check: null, packages: []})).toBe(true);
	expect(publish({check: 'pnpm check', packages: []})).toEqual({
		check: 'pnpm check',
	});
	expect(publish({check: null, packages: ['@acme/ui']})).toEqual({
		packages: ['@acme/ui'],
	});
	expect(publish({check: 'make', packages: ['@acme/ui']})).toEqual({
		check: 'make',
		packages: ['@acme/ui'],
	});
	expect(publish(null)).toBeUndefined();
});

test('privatize and ciAuth never reach the section', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = {
		...recommend(detection),
		privatize: ['apps/mobile'],
		ciAuth: 'token' as const,
	};
	const text = JSON.stringify(releaseSection(answers));
	expect(text).not.toContain('privatize');
	expect(text).not.toContain('ciAuth');
	expect(text).not.toContain('apps/mobile"]');
});

test('mentions are written when ticked and left out when empty', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const answers = recommend(detection);
	expect(releaseSection(answers)).not.toHaveProperty('mentions');
	const mention = {
		pattern: 'acme/gearz@v{version}',
		files: ['README.md'],
		unit: 'web',
	};
	const section = releaseSection({...answers, mentions: [mention]});
	expect(section.mentions).toEqual([mention]);
	expect(valid(section).mentions).toEqual([mention]);
});

test('a no-op re-run of a schema 2 section never lowers it, and what is written always parses', async () => {
	const detection = await detected(singlePackage());
	for (const original of [
		'{"release": {"schema": 2, "shape": "single", "publish": false}}',
		'{"release": {"schema": 2, "shape": "single"}}',
		'{"release": {"schema": 2, "shape": "single", "majors": "auto"}}',
	]) {
		const release = (JSON.parse(original) as {release: unknown}).release;
		const answers = answersFromSection(release, detection);
		const section = releaseSection(answers);
		expect(section.schema).toBe(2);
		expect(() => valid(section)).not.toThrow();
		expect(writeReleaseSection(original, section)).toEqual({
			text: original,
			changed: false,
		});
	}

	// A kept publish:false needs schema 2 even from an answers value with none.
	const answers = answersFromSection(
		{schema: 2, shape: 'single', publish: false},
		detection,
	);
	const lowered = {...answers, schema: undefined, triggerUnset: true as const};
	const section = releaseSection(lowered);
	expect(section).toMatchObject({schema: 2, publish: false});
	expect(() => valid(section)).not.toThrow();
});
