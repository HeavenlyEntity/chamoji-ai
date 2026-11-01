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

test('the Workstream trailer names the workstream, whatever its case', () => {
	expect(
		parseCommit(raw('✨ Add login', {trailers: 'Workstream: auth-revamp\n'}))
			.workstream,
	).toBe('auth-revamp');
	expect(
		parseCommit(raw('✨ Add login', {trailers: 'workstream: auth-revamp\n'}))
			.workstream,
	).toBe('auth-revamp');
	expect(
		parseCommit(raw('✨ Add login', {trailers: 'WORKSTREAM: auth-revamp\n'}))
			.workstream,
	).toBe('auth-revamp');
});

test('a squash body with the trailer mid-body still gives the workstream', () => {
	// The shape of a real GitHub squash with the default message setting.
	// Git's own trailer parsing only reads the last paragraph, so it misses
	// the line.
	const body = [
		'* Add login',
		'',
		'Workstream: auth-revamp',
		'',
		'* Fix the redirect',
		'',
		'Workstream: auth-revamp',
		'',
		'---------',
		'',
		'Co-authored-by: Dev <dev@example.com>',
	].join('\n');
	expect(
		parseCommit(raw('✨ Add login (#12)', {body, trailers: ''})).workstream,
	).toBe('auth-revamp');
});

test('a squash that mixes workstreams gets the first one found', () => {
	const body = 'Workstream: auth-revamp\n\nWorkstream: billing\n';
	expect(parseCommit(raw('✨ Add login (#12)', {body})).workstream).toBe(
		'auth-revamp',
	);
});

test('the trailer wins over the body', () => {
	expect(
		parseCommit(
			raw('✨ Add login', {
				trailers: 'Workstream: billing\n',
				body: 'Workstream: auth-revamp\n',
			}),
		).workstream,
	).toBe('billing');
});

test('a Workstream line that is not a slug is skipped', () => {
	expect(
		parseCommit(raw('✨ Add login', {trailers: 'Workstream: Not A Slug\n'}))
			.workstream,
	).toBeUndefined();
	expect(
		parseCommit(raw('✨ Add login', {trailers: 'Workstream: \n'})).workstream,
	).toBeUndefined();
	expect(
		parseCommit(
			raw('✨ Add login', {
				trailers: 'Workstream: Not A Slug\n',
				body: 'Workstream: auth-revamp\n',
			}),
		).workstream,
	).toBe('auth-revamp');
	expect(
		parseCommit(
			raw('✨ Add login', {
				body: 'Workstream: Not A Slug\nWorkstream: billing\n',
			}),
		).workstream,
	).toBe('billing');
	expect(
		parseCommit(
			raw('✨ Add login', {trailers: `Workstream: ${'a'.repeat(65)}\n`}),
		).workstream,
	).toBeUndefined();
});

test('a commit without the trailer has no workstream', () => {
	expect(parseCommit(raw('✨ Add login')).workstream).toBeUndefined();
	expect(parseCommit(raw('✨ Add login'))).not.toHaveProperty('workstream');
	expect(parseCommit(raw('Revert "✨ Add login"'))).not.toHaveProperty(
		'workstream',
	);
	expect(
		parseCommit(
			raw('✨ Add login', {
				body: 'Mentions Workstream: in prose\nNot a Workstream: line.',
				trailers: 'Refs: #4\n',
			}),
		).workstream,
	).toBeUndefined();
});

test('a revert keeps the workstream of its own body', () => {
	expect(
		parseCommit(
			raw('Revert "✨ Add login"', {
				body: 'This reverts commit abc.\n\nWorkstream: auth-revamp\n',
			}),
		).workstream,
	).toBe('auth-revamp');
});

test('a commit with no card has no card key', () => {
	expect('card' in parseCommit(raw('✨ Add login'))).toBe(false);
	expect(
		'card' in
			parseCommit(
				raw('✨ Add login', {
					body: 'Why this works: prose\n',
					trailers: 'Refs: #4\n',
				}),
			),
	).toBe(false);
});

test('a commit with intent lines gets a card', () => {
	expect(
		parseCommit(
			raw('✨ Add login', {
				trailers: 'Why: users asked\nGotcha: needs a restart\n',
			}),
		).card,
	).toEqual({
		why: ['users asked'],
		constraint: [],
		gotcha: ['needs a restart'],
		followUp: [],
	});
	expect(
		parseCommit(raw('✨ Add login (#12)', {body: 'Constraint: no new deps\n'}))
			.card?.constraint,
	).toEqual(['no new deps']);
});

test('a revert keeps no card from the commit it reverts', () => {
	expect('card' in parseCommit(raw('Revert "✨ Add login"'))).toBe(false);
	expect(
		'card' in
			parseCommit(
				raw('Revert "✨ Add login"', {body: 'This reverts commit abc.\n'}),
			),
	).toBe(false);
});

test('a revert keeps the card of its own body', () => {
	expect(
		parseCommit(
			raw('Revert "✨ Add login"', {
				body: 'This reverts commit abc.\n\nWhy: it broke sign-in\n',
			}),
		).card?.why,
	).toEqual(['it broke sign-in']);
});

test('trailers named like inherited properties do not break parsing', () => {
	const commit = parseCommit(
		raw('✨ Add login', {trailers: 'constructor: x\n__proto__: x\n'}),
	);
	expect('card' in commit).toBe(false);
});
