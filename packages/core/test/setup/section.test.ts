import {expect, test} from 'vitest';
import {
	answersFromSection,
	releaseSection,
	writeReleaseSection,
} from '../../src/index.js';
import {useDetection} from '../helpers/setup-detection.js';
import {gearzLayout} from '../helpers/setup-fixtures.js';

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
