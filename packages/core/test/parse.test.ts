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
	expect(parseCommit(raw('Update stuff'))).toMatchObject({
		gitmoji: null,
		description: 'Update stuff',
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
