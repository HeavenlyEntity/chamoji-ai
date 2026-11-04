import {afterEach, expect, test} from 'vitest';
import {buildRelease} from '../../src/changelog.js';
import {DEFAULT_GROUP_CONFIG} from '../../src/config.js';
import {groupCommits} from '../../src/group.js';
import {renderHtml, renderMarkdown} from '../../src/render/index.js';
import type {ParsedCommit, Release} from '../../src/types.js';
import {
	readStyle,
	renderUnitSection,
	writeUnitChangelog,
} from '../../src/units/notes.js';
import {WORKSTREAMS_FILE} from '../../src/workstreams.js';
import {commit} from '../helpers/commit.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';

const config = {groups: DEFAULT_GROUP_CONFIG};
const URL = 'https://github.com/acme/mono';
let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const withHash = (c: ParsedCommit, hash: string): ParsedCommit => ({
	...c,
	hash: hash.padEnd(40, '0'),
	shortHash: hash,
});

function release(
	commits: ParsedCommit[],
	over: Partial<Release> = {},
): Release {
	return {
		version: '1.3.0',
		tag: 'web/v1.3.0',
		previousTag: 'web/v1.2.0',
		date: '2026-11-03',
		bump: 'minor',
		nextVersion: null,
		groups: groupCommits(commits, DEFAULT_GROUP_CONFIG),
		...over,
	};
}

const heading = {
	version: '1.3.0',
	tag: 'web/v1.3.0',
	date: '2026-11-03',
	previousTag: 'web/v1.2.0',
	repositoryUrl: URL,
};

test('shared lines carry their package', () => {
	const shared = {
		...withHash(commit('🐛 Fix session refresh'), 'abc1234'),
		via: 'packages/supabase',
	};
	const own = withHash(commit('🐛 Fix login'), 'def5678');
	const section = renderUnitSection(release([shared, own]), undefined, null);
	expect(section.split('\n')).toContain(
		'- 🐛 Fix session refresh (abc1234) (via `packages/supabase`)',
	);
	expect(section.split('\n')).toContain('- 🐛 Fix login (def5678)');

	const linked = renderUnitSection(release([shared]), URL, null);
	expect(linked).toContain(
		`([abc1234](${URL}/commit/abc1234${'0'.repeat(33)})) (via \`packages/supabase\`)`,
	);

	const html = renderHtml({releases: [release([shared, own])]});
	expect(html).toContain(
		'<li>🐛 Fix session refresh (<code>abc1234</code>) (via <code>packages/supabase</code>)</li>',
	);
	expect(html).toContain('<li>🐛 Fix login (<code>def5678</code>)</li>');
});

test('style: Keep a Changelog headings are copied', () => {
	const existing = [
		'# Changelog',
		'',
		'## [Unreleased]',
		'',
		'## [1.2.0] - 2026-01-03',
		'',
		'### Features',
		'',
		'- Add search',
		'',
		'### Bug Fixes',
		'',
		'- Fix crash',
		'',
		'## [1.1.0] - 2025-12-01',
		'',
		'### Changes',
		'',
	].join('\n');
	const style = readStyle(existing);
	expect(style).not.toBeNull();
	expect(style!.labels).toEqual({added: 'Features', fixed: 'Bug Fixes'});

	const section = renderUnitSection(
		release([
			withHash(commit('✨ Add profile page'), 'aaaaaaa'),
			withHash(commit('🐛 Fix redirect'), 'bbbbbbb'),
			withHash(commit('♻️ Tidy router'), 'ccccccc'),
		]),
		undefined,
		style,
	);
	expect(section).toBe(
		[
			'## [1.3.0] - 2026-11-03',
			'',
			'### Features',
			'',
			'- ✨ Add profile page (aaaaaaa)',
			'',
			'### Changed',
			'',
			'- ♻️ Tidy router (ccccccc)',
			'',
			'### Bug Fixes',
			'',
			'- 🐛 Fix redirect (bbbbbbb)',
		].join('\n'),
	);
});

test.each([
	['## [1.2.0] - 2026-01-03', '## [1.3.0] - 2026-11-03'],
	[
		'## [1.2.0](https://example.com/releases/1.2.0) - 2026-01-03',
		`## [1.3.0](${URL}/compare/web/v1.2.0...web/v1.3.0) - 2026-11-03`,
	],
	['## 1.2.0 (2026-01-03)', '## 1.3.0 (2026-11-03)'],
	['## v1.2.0 – 3 January 2026', '## v1.3.0 – 3 November 2026'],
	['## 1.2.0', '## 1.3.0'],
])('style: %s is matched', (line, expected) => {
	const style = readStyle(`# Changelog\n\n${line}\n\n### Added\n\n- x\n`);
	expect(style).not.toBeNull();
	expect(style!.heading(heading)).toBe(expected);
});

test('style: a linked heading with nothing to link to keeps its brackets', () => {
	const style = readStyle('## [1.2.0](https://example.com) - 2026-01-03\n');
	expect(style!.heading({...heading, repositoryUrl: undefined})).toBe(
		'## [1.3.0] - 2026-11-03',
	);
	expect(style!.heading({...heading, previousTag: null})).toBe(
		'## [1.3.0] - 2026-11-03',
	);
});

test.each([
	'## Release 1.2.0',
	'## 1.2.0 on 2026-01-03',
	'## [1.2.0 - 2026-01-03',
	'## 1.2.0 - 3 Smarch 2026',
	'## web@1.2.0',
	'No headings at all',
])('style: %s is not a known shape', existing => {
	expect(readStyle(existing)).toBeNull();
});

test("style: a changelog chamoji wrote keeps chamoji's own format", () => {
	const ours = (repositoryUrl?: string) =>
		renderMarkdown({
			...(repositoryUrl ? {repositoryUrl} : {}),
			releases: [
				release(
					[
						withHash(commit('✨ Add search'), 'aaaaaaa'),
						withHash(commit('🐛 Fix crash'), 'bbbbbbb'),
					],
					{version: 'web/v1.2.0', tag: 'web/v1.2.0', previousTag: 'web/v1.1.0'},
				),
				release([withHash(commit('✨ Add login'), 'ccccccc')], {
					version: 'v1.1.0',
					tag: 'v1.1.0',
					previousTag: null,
				}),
			],
		});
	expect(readStyle(ours(URL))).toBeNull();
	expect(readStyle(ours())).toBeNull();

	const section = renderUnitSection(
		release([withHash(commit('✨ Add profile page'), 'aaaaaaa')]),
		URL,
		readStyle(ours(URL)),
	);
	expect(section.split('\n')[0]).toBe(
		`## [1.3.0](${URL}/compare/web/v1.2.0...web/v1.3.0) - 2026-11-03`,
	);
});

test('style: labels are read under the newest heading only, and unknown ones are left alone', () => {
	const style = readStyle(
		[
			'## 1.2.0 (2026-01-03)',
			'',
			'### Bug Fixes',
			'### Shiny Things',
			'',
			'## 1.1.0 (2025-12-01)',
			'',
			'### Features',
		].join('\n'),
	);
	expect(style!.labels).toEqual({fixed: 'Bug Fixes'});
});

test('a new unit changelog starts with the title and this release only', () => {
	const section = renderUnitSection(
		release([withHash(commit('✨ Add profile page'), 'aaaaaaa')]),
		undefined,
		null,
	);
	expect(writeUnitChangelog(null, section)).toBe(
		[
			'# Changelog',
			'',
			'## 1.3.0 - 2026-11-03',
			'',
			'### Added',
			'',
			'- ✨ Add profile page (aaaaaaa)',
			'',
		].join('\n'),
	);
});

test('an existing unit changelog gets the section above its last release', () => {
	const existing = '# Changelog\n\n## 1.2.0 - 2026-01-03\n\n### Added\n\n- x\n';
	expect(writeUnitChangelog(existing, '## 1.3.0 - 2026-11-03')).toBe(
		'# Changelog\n\n## 1.3.0 - 2026-11-03\n\n## 1.2.0 - 2026-01-03\n\n### Added\n\n- x\n',
	);
});

test('the root note is the last line of Changed', () => {
	const section = renderUnitSection(
		release([
			withHash(commit('♻️ Tidy router'), 'aaaaaaa'),
			withHash(commit('🐛 Fix redirect'), 'bbbbbbb'),
		]),
		undefined,
		null,
		{rootChanges: 3},
	);
	expect(section).toBe(
		[
			'## 1.3.0 - 2026-11-03',
			'',
			'### Changed',
			'',
			'- ♻️ Tidy router (aaaaaaa)',
			'- Tooling and CI: 3 changes',
			'',
			'### Fixed',
			'',
			'- 🐛 Fix redirect (bbbbbbb)',
		].join('\n'),
	);
});

test('one root change is singular', () => {
	const section = renderUnitSection(
		release([withHash(commit('♻️ Tidy router'), 'aaaaaaa')]),
		undefined,
		null,
		{rootChanges: 1},
	);
	expect(section.split('\n').at(-1)).toBe('- Tooling and CI: 1 change');
});

test('a release with no Changed group gets one for the root note, in its place', () => {
	const commits = [
		withHash(commit('✨ Add profile page'), 'aaaaaaa'),
		withHash(commit('🐛 Fix redirect'), 'bbbbbbb'),
	];
	expect(
		renderUnitSection(release(commits), undefined, null, {rootChanges: 2}),
	).toBe(
		[
			'## 1.3.0 - 2026-11-03',
			'',
			'### Added',
			'',
			'- ✨ Add profile page (aaaaaaa)',
			'',
			'### Changed',
			'',
			'- Tooling and CI: 2 changes',
			'',
			'### Fixed',
			'',
			'- 🐛 Fix redirect (bbbbbbb)',
		].join('\n'),
	);

	const style = readStyle('## 1.2.0 (2026-01-03)\n\n### Changes\n');
	const styled = renderUnitSection(release(commits), undefined, style, {
		rootChanges: 2,
	});
	expect(styled).toContain('### Changes\n\n- Tooling and CI: 2 changes\n');
});

test('no root changes means no root note', () => {
	const commits = [withHash(commit('✨ Add profile page'), 'aaaaaaa')];
	const plain = renderUnitSection(release(commits), undefined, null);
	expect(
		renderUnitSection(release(commits), undefined, null, {rootChanges: 0}),
	).toBe(plain);
	expect(plain).not.toContain('Changed');
});

test('a workstream reaching a unit is a Highlight there', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				[WORKSTREAMS_FILE]:
					'workstreams:\n  auth:\n    title: Sign in with passkeys\n    status: shipped\n',
			},
		},
	]);
	const own = [
		withHash(
			commit('✨ Add passkey login', {trailers: 'Workstream: auth'}),
			'aaaaaaa',
		),
		withHash(commit('🐛 Fix footer'), 'bbbbbbb'),
	];
	const built = await buildRelease(
		repo.dir,
		config,
		{
			version: '1.3.0',
			tag: 'web/v1.3.0',
			previousTag: 'web/v1.2.0',
			date: '2026-11-03',
		},
		own,
		'HEAD',
		false,
	);
	expect(renderUnitSection(built, undefined, null)).toBe(
		[
			'## 1.3.0 - 2026-11-03',
			'',
			'### Highlights',
			'',
			'- **Sign in with passkeys**',
			'  - ✨ Add passkey login (aaaaaaa)',
			'',
			'### Fixed',
			'',
			'- 🐛 Fix footer (bbbbbbb)',
		].join('\n'),
	);
});
