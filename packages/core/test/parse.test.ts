import {expect, test} from 'vitest';
import {parseCommit} from '../src/parse.js';
import type {RawCommit} from '../src/types.js';

const raw = (subject: string, extra: Partial<RawCommit> = {}): RawCommit => ({
	hash: 'a'.repeat(40),
	shortHash: 'aaaaaaa',
	authorName: 'Dev',
	authorEmail: 'dev@example.com',
	date: '2026-01-01T00:00:00Z',
	subject,
	body: '',
	trailers: '',
	...extra,
});

test('plain gitmoji', () => {
	expect(parseCommit(raw('✨ Add login'))).toMatchObject({
		gitmoji: 'sparkles',
		description: 'Add login',
		type: null,
		scope: null,
		breaking: false,
	});
});

test('shortcode', () => {
	expect(parseCommit(raw(':bug: Fix crash'))).toMatchObject({
		gitmoji: 'bug',
		description: 'Fix crash',
	});
});

test('gitmoji-cli scope', () => {
	expect(parseCommit(raw('✨ (auth): Add login'))).toMatchObject({
		gitmoji: 'sparkles',
		scope: 'auth',
		description: 'Add login',
	});
});

test('conventional + gitmoji', () => {
	expect(parseCommit(raw('feat(auth): ✨ Add login'))).toMatchObject({
		type: 'feat',
		scope: 'auth',
		gitmoji: 'sparkles',
		description: 'Add login',
	});
});

test('conventional only maps type to gitmoji', () => {
	expect(parseCommit(raw('fix: Handle null'))).toMatchObject({
		type: 'fix',
		gitmoji: 'bug',
		description: 'Handle null',
	});
});

test('breaking via bang', () => {
	expect(parseCommit(raw('feat!: ✨ New API')).breaking).toBe(true);
});

test('breaking via footer', () => {
	const commit = parseCommit(
		raw('✨ New API', {body: 'Details.\n\nBREAKING CHANGE: removed x'}),
	);
	expect(commit.breaking).toBe(true);
});

test('breaking via boom', () => {
	expect(parseCommit(raw('💥 Drop node 18')).breaking).toBe(true);
});

test('no gitmoji', () => {
	expect(parseCommit(raw('Misc stuff'))).toMatchObject({
		gitmoji: null,
		description: 'Misc stuff',
		breaking: false,
	});
});

test('trailers parsed', () => {
	const commit = parseCommit(
		raw('✨ Add login', {trailers: 'Workstream: auth\nRefs: #4\n'}),
	);
	expect(commit.trailers).toEqual([
		{key: 'Workstream', value: 'auth'},
		{key: 'Refs', value: '#4'},
	]);
});

test('emoji later in subject is still found', () => {
	expect(parseCommit(raw('Fix :bug: in parser'))).toMatchObject({
		gitmoji: 'bug',
		description: 'Fix in parser',
	});
});

test('FE0F variants leave no stray selector in the description', () => {
	// The gitmojis package stores 🚑 with U+FE0F; commits often omit it.
	expect(parseCommit(raw('🚑️ Fix outage'))).toMatchObject({
		gitmoji: 'ambulance',
		description: 'Fix outage',
	});
	expect(parseCommit(raw('🚑 Fix outage')).gitmoji).toBe('ambulance');
	expect(parseCommit(raw('⚡️ Speed up parser')).description).toBe(
		'Speed up parser',
	);
});

test('git revert subjects are reverts, not the quoted gitmoji', () => {
	expect(parseCommit(raw('Revert "✨ Add login"'))).toMatchObject({
		gitmoji: 'rewind',
		description: 'Revert "Add login"',
		breaking: false,
	});
	expect(parseCommit(raw('Revert "💥 Drop node 18"')).breaking).toBe(false);
});

test('bang marks breaking for any conventional type', () => {
	expect(parseCommit(raw('deps!: Drop node 18'))).toMatchObject({
		type: 'deps',
		description: 'Drop node 18',
		breaking: true,
	});
	expect(parseCommit(raw('Note: keep this text'))).toMatchObject({
		type: null,
		description: 'Note: keep this text',
	});
});

test('a Component: prefix becomes the scope, and the rest picks the section', () => {
	expect(
		parseCommit(raw('Core: Refactor loops to avoid going behind array bounds')),
	).toMatchObject({
		gitmoji: 'recycle',
		gitmojiSource: 'rule',
		scope: 'Core',
		description: 'Refactor loops to avoid going behind array bounds',
		type: null,
	});
	expect(parseCommit(raw('CSS:Tests: Fix tests under CSS Zoom'))).toMatchObject(
		{
			gitmoji: 'white_check_mark',
			scope: 'CSS:Tests',
			description: 'Fix tests under CSS Zoom',
		},
	);
	expect(parseCommit(raw('No ticket: Fix a crash in .ready()'))).toMatchObject({
		gitmoji: 'bug',
		scope: 'No ticket',
	});
});

test('a Component: prefix is left alone when the rest says nothing', () => {
	expect(parseCommit(raw('Note: this is how it works'))).toMatchObject({
		gitmoji: null,
		scope: null,
		description: 'Note: this is how it works',
	});
});

test('a kind [tag] picks the section on its own', () => {
	expect(
		parseCommit(raw('[bugfix] Validate timezone offset range (#6446)')),
	).toMatchObject({
		gitmoji: 'bug',
		scope: null,
		description: 'Validate timezone offset range (#6446)',
	});
	expect(
		parseCommit(raw('[feature] Add internal date-default hook')),
	).toMatchObject({gitmoji: 'sparkles'});
	expect(parseCommit(raw('[tests] Fix format test date input'))).toMatchObject({
		gitmoji: 'white_check_mark',
	});
	expect(parseCommit(raw('[new locale] ps: Pashto (#6000)'))).toMatchObject({
		gitmoji: 'sparkles',
		scope: 'new locale',
		description: 'ps: Pashto (#6000)',
	});
});

test('an area [tag] becomes the scope, and the rest picks the section', () => {
	expect(
		parseCommit(raw('[locale] Fix Uzbek past relative time')),
	).toMatchObject({
		gitmoji: 'bug',
		scope: 'locale',
		description: 'Fix Uzbek past relative time',
	});
	expect(parseCommit(raw('[locale] fil: Fix metadata comment'))).toMatchObject({
		gitmoji: 'bug',
		scope: 'locale',
		description: 'fil: Fix metadata comment',
	});
	expect(parseCommit(raw('[locale] Uzbek month names'))).toMatchObject({
		gitmoji: 'globe_with_meridians',
		scope: 'locale',
	});
});

test('another [tag] is read through to the subject behind it', () => {
	expect(
		parseCommit(raw('[misc] Clarify locale and format identifiers')),
	).toMatchObject({
		gitmoji: null,
		description: '[misc] Clarify locale and format identifiers',
	});
	expect(parseCommit(raw('[pkg] Build 2.31.0 (#6452)'))).toMatchObject({
		gitmoji: 'bookmark',
		scope: 'pkg',
	});
	expect(parseCommit(raw('[breaking] Drop IE support'))).toMatchObject({
		gitmoji: 'boom',
		breaking: true,
	});
});

test('Conventional types and gitmojis still win over the new prefixes', () => {
	expect(parseCommit(raw('fix(core): Refactor loops'))).toMatchObject({
		gitmoji: 'bug',
		gitmojiSource: 'type',
		scope: 'core',
	});
	expect(parseCommit(raw('✨ [bugfix] Add a thing'))).toMatchObject({
		gitmoji: 'sparkles',
		gitmojiSource: 'gitmoji',
	});
});
