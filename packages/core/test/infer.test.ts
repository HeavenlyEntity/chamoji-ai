import {expect, test} from 'vitest';
import {inferGitmoji} from '../src/infer.js';
import {parseCommit} from '../src/parse.js';
import type {RawCommit} from '../src/types.js';

const raw = (subject: string): RawCommit => ({
	hash: 'a'.repeat(40),
	shortHash: 'aaaaaaa',
	authorName: 'Dev',
	authorEmail: 'dev@example.com',
	date: '2026-01-01T00:00:00Z',
	subject,
	body: '',
	trailers: '',
});

test.each([
	['Add `choices` option (#228)', 'sparkles'],
	['Implement subcommand parsing', 'sparkles'],
	['Support ESM config files', 'sparkles'],
	['Export `AnyFlag` and `AnyFlags` types', 'sparkles'],
	['Fix `engines` field (#203)', 'bug'],
	['Fixes crash when input is empty', 'bug'],
	['Resolve race in watcher', 'bug'],
	['Fix readme typo', 'memo'],
	['Fix typo in error message', 'pencil2'],
	['Remove `hardRejection` option', 'fire'],
	['Drop support for Windows 7', 'fire'],
	['Deprecate `alias` in favor of `shortFlag`', 'wastebasket'],
	['Rename `alias` to `shortFlag` (#225)', 'truck'],
	['Improve startup performance', 'zap'],
	['Clean up `description` parsing (#256)', 'recycle'],
	['Refactor the resolver', 'recycle'],
	['Improve TypeScript types (#218)', 'wrench'],
	['Update readme', 'memo'],
	['Readme tweak', 'memo'],
	['Improve tests (#255)', 'white_check_mark'],
	['Add test for `unnormalizedFlags`', 'white_check_mark'],
	['Fix CI', 'green_heart'],
	['Meta tweaks', 'wrench'],
	['Bump dev dependencies (#207)', 'arrow_up'],
	['Update dependencies', 'arrow_up'],
	['Bump fast-uri from 3.1.8 to 3.1.9 (#1585)', 'arrow_up'],
	['Require Node.js 20', 'boom'],
	['1.2.1', 'bookmark'],
	['v12.0.0', 'bookmark'],
	['Release 3.0.0', 'bookmark'],
	['Initial commit', 'tada'],
	['Fix security issue in token parsing', 'lock'],
	['Document ES Modules usage (#147)', 'memo'],
	['bump `camelcase-keys`', 'arrow_up'],
	['bump AVA', 'arrow_up'],
	['[BREAKING] ES2015ify - Now requires Node.js >=4', 'boom'],
	['Minor code tweaks', 'art'],
	['Code style tweaks', 'art'],
	['init', 'tada'],
	['Close #14 PR: Add description option. Fixes #12', 'sparkles'],
	['Switch from `loud-rejection` to `hard-rejection`', 'wrench'],
])('%s → %s', (subject, expected) => {
	expect(inferGitmoji(subject)).toBe(expected);
});

test('returns null when no rule applies', () => {
	expect(inferGitmoji('Separate `index.js` and `test.js` (#234)')).toBeNull();
	expect(inferGitmoji('Misc stuff')).toBeNull();
});

test('parseCommit uses rules only when there is no gitmoji or type', () => {
	expect(parseCommit(raw('Add `choices` option'))).toMatchObject({
		gitmoji: 'sparkles',
		gitmojiSource: 'rule',
		description: 'Add `choices` option',
	});
	expect(parseCommit(raw('🐛 Add guard')).gitmojiSource).toBe('gitmoji');
	expect(parseCommit(raw('fix: Add guard'))).toMatchObject({
		gitmoji: 'bug',
		gitmojiSource: 'type',
	});
	expect(parseCommit(raw('Separate files')).gitmojiSource).toBeNull();
});

test('rule-inferred breaking changes count as breaking', () => {
	expect(parseCommit(raw('Require Node.js 20')).breaking).toBe(true);
});

test('more conventional types and dependency scopes', () => {
	expect(parseCommit(raw('release: v5.0.0')).gitmoji).toBe('bookmark');
	expect(parseCommit(raw('wip: try new resolver')).gitmoji).toBe(
		'construction',
	);
	expect(parseCommit(raw('deps: bump esbuild')).gitmoji).toBe('arrow_up');
	expect(parseCommit(raw('chore(deps): update rollup')).gitmoji).toBe(
		'arrow_up',
	);
	expect(parseCommit(raw('fix(deps): update esbuild')).gitmoji).toBe(
		'arrow_up',
	);
	expect(parseCommit(raw('fix(css): handle urls')).gitmoji).toBe('bug');
});
