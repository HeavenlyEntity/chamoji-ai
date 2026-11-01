import {expect, test} from 'vitest';
import {groupCommits} from '../src/group.js';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import {
	render,
	renderHtml,
	renderJson,
	renderMarkdown,
} from '../src/render/index.js';
import type {Changelog, Highlight, ParsedCommit} from '../src/types.js';
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

test('json has no workstream key for a commit without one', () => {
	const changelog = sample();
	const commits = changelog.releases[0]!.groups[0]!.commits;
	commits.push(
		commit('✨ Add login (#12)', {trailers: 'Workstream: auth-revamp\n'}),
	);
	const json = JSON.parse(renderJson(changelog)) as {
		releases: Array<{groups: Array<{commits: Array<Record<string, unknown>>}>}>;
	};
	const rendered = json.releases[0]!.groups[0]!.commits;
	expect(rendered[0]).not.toHaveProperty('workstream');
	expect(rendered.at(-1)).toHaveProperty('workstream', 'auth-revamp');
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

const summary = (subjects: string[]) =>
	renderMarkdown({
		releases: [
			{
				version: 'v1.0.0',
				tag: 'v1.0.0',
				previousTag: null,
				date: null,
				bump: null,
				nextVersion: null,
				groups: groupCommits(
					subjects.map(s => commit(s)),
					DEFAULT_GROUP_CONFIG,
				),
			},
		],
	})
		.split('\n')
		.find(line => line.startsWith('- ⬆️'));

test('dependency summary keeps names that start with dev', () => {
	expect(
		summary([
			'Bump devalue from 5.1.0 to 5.1.1',
			'Bump devtools-protocol from 0.0.1 to 0.0.2',
			'Update dev dependency eslint to v9',
		]),
	).toBe('- ⬆️ 3 dependency updates: devalue, devtools-protocol, eslint');
});

test('dependency summary counts Dependabot group updates, not group names', () => {
	expect(
		summary([
			'Bump the minor-and-patch group with 5 updates',
			'Bump the npm_and_yarn group across 2 directories with 3 updates',
			'Bump jest from 30.3.0 to 30.5.0',
		]),
	).toBe('- ⬆️ 9 dependency updates: jest');
});

test('dependency summary escapes markdown in names', () => {
	expect(summary(['Bump [x](y) from 1.0.0 to 2.0.0'])).not.toContain('[x](');
});

test('AI-picked gitmojis are not shown as emojis either', () => {
	const changelog = sample();
	const picked = {
		...commit('Accept camelCase flags'),
		gitmoji: 'sparkles',
		gitmojiSource: 'ai' as const,
	};
	changelog.releases[0]!.groups = groupCommits([picked], DEFAULT_GROUP_CONFIG);
	expect(renderMarkdown(changelog)).toContain(
		'### Added\n\n- Accept camelCase flags (',
	);
});

// --- Highlights ---

const highlightChangelog = (
	highlight: Partial<Highlight> = {},
	loose: ParsedCommit[] = [withHash(commit('🐛 Fix crash'), 'eeeeeee')],
): Changelog => ({
	releases: [
		{
			version: 'v3.0.0',
			tag: 'v3.0.0',
			previousTag: null,
			date: '2026-03-01',
			bump: 'minor',
			nextVersion: null,
			highlights: [
				{
					slug: 'auth-revamp',
					title: 'Auth revamp',
					emoji: '🔐',
					description: 'Sign in with passkeys.',
					groups: groupCommits(
						[
							withHash(commit('✨ Add login'), 'abc1234'),
							withHash(commit('🐛 Fix logout'), 'def5678'),
						],
						DEFAULT_GROUP_CONFIG,
					),
					...highlight,
				},
			],
			groups: groupCommits(loose, DEFAULT_GROUP_CONFIG),
		},
	],
});

test('markdown puts Highlights first, with each commit under its workstream', () => {
	expect(renderMarkdown(highlightChangelog())).toBe(
		`# Changelog

## v3.0.0 - 2026-03-01

### Highlights

- 🔐 **Auth revamp:** Sign in with passkeys.
  - ✨ Add login (abc1234)
  - 🐛 Fix logout (def5678)

### Fixed

- 🐛 Fix crash (eeeeeee)
`,
	);
});

test('markdown links highlight commits like any other commit', () => {
	const changelog = {
		...highlightChangelog(),
		repositoryUrl: 'https://github.com/acme/widgets',
	};
	expect(renderMarkdown(changelog)).toContain(
		'  - ✨ Add login ([abc1234](https://github.com/acme/widgets/commit/abc1234000000000000000000000000000000000))\n',
	);
});

test('markdown leaves out the colon without a description and the space without an emoji', () => {
	const bare = renderMarkdown(
		highlightChangelog({description: undefined, emoji: undefined}),
	);
	expect(bare).toContain('\n- **Auth revamp**\n  - ✨ Add login');
	const noDescription = renderMarkdown(
		highlightChangelog({description: undefined}),
	);
	expect(noDescription).toContain('\n- 🔐 **Auth revamp**\n');
	const noEmoji = renderMarkdown(highlightChangelog({emoji: undefined}));
	expect(noEmoji).toContain('\n- **Auth revamp:** Sign in with passkeys.\n');
});

test('markdown shows a release with only highlights and no groups', () => {
	const markdown = renderMarkdown(highlightChangelog({}, []));
	expect(markdown).toContain('### Highlights');
	expect(markdown).not.toContain('### Fixed');
	expect(markdown.endsWith('(def5678)\n')).toBe(true);
});

test('markdown keeps a dependency group inside a highlight to one line', () => {
	const markdown = renderMarkdown(
		highlightChangelog({groups: dependencyChangelog().releases[0]!.groups}),
	);
	expect(markdown).toContain(
		'  - ⬆️ 9 dependency updates: jest, vite, @babel/core, fast-uri, prettier and 2 more\n',
	);
	expect(markdown.match(/dependency updates/g)).toHaveLength(1);
});

test('markdown makes workstream text from the file inert', () => {
	const markdown = renderMarkdown(
		highlightChangelog({
			title: '[x](https://evil) <script>alert(1)</script>',
			emoji: '<b>',
			description: '[y](https://evil) <img src=x onerror=alert(1)>',
		}),
	);
	expect(markdown).not.toMatch(/(?<!\\)\]\(/);
	expect(markdown).not.toContain('<script>');
	expect(markdown).not.toContain('<img');
	expect(markdown).not.toContain('<b>');
	expect(markdown).toContain(
		'- &lt;b&gt; **\\[x\\](https://evil) &lt;script&gt;alert(1)&lt;/script&gt;:** \\[y\\](https://evil) &lt;img src=x onerror=alert(1)&gt;\n',
	);
});

test('markdown keeps a multi-line description from starting new blocks', () => {
	const markdown = renderMarkdown(
		highlightChangelog({
			title: 'Auth\n## [v9.9.9] - fake',
			description: 'First line.\n\n## [v9.9.9] - fake\n- sneaky',
		}),
	);
	expect(markdown).not.toMatch(/^## \[v9\.9\.9\]/m);
	expect(markdown).toContain(
		'- 🔐 **Auth ## \\[v9.9.9\\] - fake:** First line. ## \\[v9.9.9\\] - fake - sneaky\n',
	);
});

test('html shows Highlights first, a details per workstream', () => {
	const html = renderHtml(highlightChangelog());
	expect(html).toContain(
		`<h2>v3.0.0 <time datetime="2026-03-01">2026-03-01</time></h2>
<h3>Highlights</h3>
<details>
<summary>🔐 <strong>Auth revamp</strong></summary>
<p>Sign in with passkeys.</p>
<ul>
<li>✨ Add login (<code>abc1234</code>)</li>
<li>🐛 Fix logout (<code>def5678</code>)</li>
</ul>
</details>
<h3>Fixed</h3>`,
	);
});

test('html leaves out the paragraph without a description and the space without an emoji', () => {
	const html = renderHtml(
		highlightChangelog({description: undefined, emoji: undefined}),
	);
	expect(html).toContain(
		'<summary><strong>Auth revamp</strong></summary>\n<ul>',
	);
});

test('html keeps a dependency group inside a highlight to one line', () => {
	const html = renderHtml(
		highlightChangelog({groups: dependencyChangelog().releases[0]!.groups}),
	);
	expect(html).toContain(
		'<li>⬆️ 9 dependency updates: jest, vite, @babel/core, fast-uri, prettier and 2 more</li>',
	);
	expect(html.match(/dependency updates/g)).toHaveLength(1);
});

test('html makes workstream text from the file inert', () => {
	const html = renderHtml(
		highlightChangelog({
			title: '[x](https://evil) <script>alert(1)</script>',
			emoji: '<b>',
			description: '<img src=x onerror=alert(1)> "quoted"',
		}),
	);
	expect(html).not.toContain('<script>');
	expect(html).not.toContain('<img');
	expect(html).not.toContain('<b>');
	expect(html).toContain(
		'<summary>&lt;b&gt; <strong>[x](https://evil) &lt;script&gt;alert(1)&lt;/script&gt;</strong></summary>',
	);
	expect(html).toContain(
		'<p>&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;</p>',
	);
});

test('a release without highlights renders as before', () => {
	const changelog = sample();
	expect(renderMarkdown(changelog)).not.toContain('Highlights');
	expect(renderHtml(changelog)).not.toContain('Highlights');
	expect(renderHtml(changelog)).not.toContain('<details>');
});

test('json carries highlights as they are', () => {
	const json = JSON.parse(renderJson(highlightChangelog()));
	expect(json.releases[0].highlights[0]).toMatchObject({
		slug: 'auth-revamp',
		title: 'Auth revamp',
	});
	expect(json.releases[0].highlights[0].groups).toHaveLength(2);
});
