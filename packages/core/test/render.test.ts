import {expect, test} from 'vitest';
import {groupCommits} from '../src/group.js';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import {
	render,
	renderHtml,
	renderJson,
	renderMarkdown,
} from '../src/render/index.js';
import type {Changelog, ParsedCommit} from '../src/types.js';
import {commit} from './helpers/commit.js';

const withHash = (c: ParsedCommit, hash: string): ParsedCommit => ({
	...c,
	hash: hash.padEnd(40, '0'),
	shortHash: hash,
});

const sample = (repositoryUrl?: string): Changelog => ({
	...(repositoryUrl ? {repositoryUrl} : {}),
	releases: [
		{
			version: 'Unreleased',
			tag: null,
			previousTag: 'v1.1.0',
			date: null,
			bump: 'patch',
			nextVersion: '1.1.1',
			groups: groupCommits(
				[withHash(commit('🐛 Fix crash on empty input (#12)'), 'aaaaaaa')],
				DEFAULT_GROUP_CONFIG,
			),
		},
		{
			version: 'v1.1.0',
			tag: 'v1.1.0',
			previousTag: 'v1.0.0',
			date: '2026-01-03',
			bump: 'minor',
			nextVersion: null,
			groups: groupCommits(
				[
					withHash(commit('feat(auth): ✨ Add login'), 'bbbbbbb'),
					withHash(commit('Tidy things'), 'ccccccc'),
				],
				DEFAULT_GROUP_CONFIG,
			),
		},
		{
			version: 'v1.0.0',
			tag: 'v1.0.0',
			previousTag: null,
			date: '2026-01-01',
			bump: null,
			nextVersion: null,
			groups: groupCommits(
				[withHash(commit('🎉 Initial release'), 'ddddddd')],
				DEFAULT_GROUP_CONFIG,
			),
		},
	],
});

test('markdown with a repository url', () => {
	expect(renderMarkdown(sample('https://github.com/acme/widgets'))).toBe(
		`# Changelog

## [Unreleased](https://github.com/acme/widgets/compare/v1.1.0...HEAD)

### Fixed

- 🐛 Fix crash on empty input ([#12](https://github.com/acme/widgets/issues/12)) ([aaaaaaa](https://github.com/acme/widgets/commit/aaaaaaa000000000000000000000000000000000))

## [v1.1.0](https://github.com/acme/widgets/compare/v1.0.0...v1.1.0) - 2026-01-03

### Added

- ✨ **auth:** Add login ([bbbbbbb](https://github.com/acme/widgets/commit/bbbbbbb000000000000000000000000000000000))

### Miscellaneous

- Tidy things ([ccccccc](https://github.com/acme/widgets/commit/ccccccc000000000000000000000000000000000))

## v1.0.0 - 2026-01-01

### Added

- 🎉 Initial release ([ddddddd](https://github.com/acme/widgets/commit/ddddddd000000000000000000000000000000000))
`,
	);
});

test('markdown without a url has no links', () => {
	const markdown = renderMarkdown(sample());
	expect(markdown).not.toContain('](');
	expect(markdown).toContain('## Unreleased\n');
	expect(markdown).toContain('- 🐛 Fix crash on empty input (#12) (aaaaaaa)');
});

test('markdown ignores non-http repository urls', () => {
	const markdown = renderMarkdown(sample('javascript:alert(1)'));
	expect(markdown).not.toContain('javascript:');
});

test('markdown escapes angle brackets', () => {
	const changelog = sample();
	changelog.releases[0]!.groups = groupCommits(
		[commit('🐛 Fix <script>alert(1)</script> in title')],
		DEFAULT_GROUP_CONFIG,
	);
	const markdown = renderMarkdown(changelog);
	expect(markdown).not.toContain('<script>');
	expect(markdown).toContain('&lt;script&gt;');
});

test('html escapes commit text and attributes', () => {
	const changelog = sample('https://github.com/acme/widgets');
	changelog.releases[0]!.groups = groupCommits(
		[commit('🐛 Fix <script>alert("x")</script> & more')],
		DEFAULT_GROUP_CONFIG,
	);
	const html = renderHtml(changelog);
	expect(html).toMatch(/^<!doctype html>/);
	expect(html).toContain('<meta charset="utf-8">');
	expect(html).not.toContain('<script>');
	expect(html).toContain(
		'&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more',
	);
	expect(html).toContain(
		'<a href="https://github.com/acme/widgets/compare/v1.0.0...v1.1.0">v1.1.0</a>',
	);
});

test('json round-trips', () => {
	const changelog = sample('https://github.com/acme/widgets');
	const json = renderJson(changelog);
	expect(json.endsWith('\n')).toBe(true);
	expect(JSON.parse(json)).toEqual(changelog);
});

test('render dispatches by format', () => {
	const changelog = sample();
	expect(render(changelog, 'markdown')).toBe(renderMarkdown(changelog));
	expect(render(changelog, 'html')).toBe(renderHtml(changelog));
	expect(render(changelog, 'json')).toBe(renderJson(changelog));
});

test('markdown leaves code spans untouched', () => {
	const changelog = sample();
	changelog.releases[0]!.groups = groupCommits(
		[commit('🐛 Handle `Array<string>` input')],
		DEFAULT_GROUP_CONFIG,
	);
	expect(renderMarkdown(changelog)).toContain('Handle `Array<string>` input');
});

test('markdown neutralizes links and images in commit text', () => {
	const changelog = sample();
	changelog.releases[0]!.groups = groupCommits(
		[commit('🐛 See [x](https://evil.example) ![](https://t.example/p.gif)')],
		DEFAULT_GROUP_CONFIG,
	);
	const markdown = renderMarkdown(changelog);
	expect(markdown).not.toContain('[x](');
	expect(markdown).not.toContain('![](');
	expect(markdown).toContain('\\[x\\](https://evil.example)');
});

test('markdown escapes stray backticks so they cannot open a code span', () => {
	const changelog = sample();
	changelog.releases[0]!.groups = groupCommits(
		[commit('🐛 Fix ``<img src=x onerror=alert(1)>`x` here')],
		DEFAULT_GROUP_CONFIG,
	);
	const markdown = renderMarkdown(changelog);
	// The lone backtick is escaped; only the balanced `…` pair stays a span.
	expect(markdown).toContain('Fix \\``<img src=x onerror=alert(1)>`x\\` here');
	expect(markdown).not.toMatch(/(^|[^`\\])``<img/);
});

const dependencyChangelog = (): Changelog => ({
	releases: [
		{
			version: 'v2.0.0',
			tag: 'v2.0.0',
			previousTag: null,
			date: '2026-02-01',
			bump: 'patch',
			nextVersion: null,
			groups: groupCommits(
				[
					commit('⬆️ Bump jest from 30.3.0 to 30.5.0 (#1569)'),
					commit('⬆️ Bump jest from 30.5.0 to 30.5.2 (#1574)'),
					commit('chore(deps): update dependency vite to v7.1.0'),
					commit('Bump @babel/core from 7.29.0 to 7.29.6'),
					commit('Bump fast-uri from 3.1.7 to 3.1.8'),
					commit('Bump prettier from 3.8.1 to 3.8.3'),
					commit('Bump turbo from 2.9.3 to 2.9.14'),
					commit('Bump semver from 7.7.2 to 7.7.3'),
					commit('Update dependencies'),
				],
				DEFAULT_GROUP_CONFIG,
			),
		},
	],
});

test('markdown collapses dependency updates into one line', () => {
	expect(renderMarkdown(dependencyChangelog())).toContain(
		'### Dependencies\n\n- ⬆️ 9 dependency updates: jest, vite, @babel/core, fast-uri, prettier and 2 more\n',
	);
});

test('html collapses dependency updates into one line', () => {
	expect(renderHtml(dependencyChangelog())).toContain(
		'<li>⬆️ 9 dependency updates: jest, vite, @babel/core, fast-uri, prettier and 2 more</li>',
	);
});

test('json keeps every dependency commit', () => {
	const json = JSON.parse(renderJson(dependencyChangelog()));
	expect(json.releases[0].groups[0].commits).toHaveLength(9);
});

test('guessed gitmojis are not shown as emojis', () => {
	const changelog = sample();
	changelog.releases[0]!.groups = groupCommits(
		[commit('Add search'), commit('feat: Add filters'), commit('✨ Add sort')],
		DEFAULT_GROUP_CONFIG,
	);
	const markdown = renderMarkdown(changelog);
	expect(markdown).toContain('- Add search (');
	expect(markdown).toContain('- ✨ Add filters (');
	expect(markdown).toContain('- ✨ Add sort (');
});
