import {expect, test} from 'vitest';
import {readIntent} from '../src/intent.js';
import type {Trailer} from '../src/types.js';

const trailer = (key: string, value: string): Trailer => ({key, value});

test('reads all four keys', () => {
	expect(
		readIntent(
			[
				trailer('Why', 'a'),
				trailer('Constraint', 'b'),
				trailer('Gotcha', 'c'),
				trailer('Follow-up', 'd'),
			],
			'',
		),
	).toEqual({why: ['a'], constraint: ['b'], gotcha: ['c'], followUp: ['d']});
});

test('matches keys in any case', () => {
	expect(
		readIntent([trailer('WHY', 'a'), trailer('follow-up', 'd')], ''),
	).toEqual({why: ['a'], constraint: [], gotcha: [], followUp: ['d']});
	expect(readIntent([], 'WHY: a\nfollow-Up: d\n')).toEqual({
		why: ['a'],
		constraint: [],
		gotcha: [],
		followUp: ['d'],
	});
});

test('keeps several values in order', () => {
	expect(
		readIntent([trailer('Gotcha', 'x'), trailer('Gotcha', 'y')], '')?.gotcha,
	).toEqual(['x', 'y']);
});

test('reads lines from a GitHub squash body', () => {
	const body = [
		'* Add login',
		'',
		'Why: a',
		'',
		'* Fix it',
		'',
		'Why: b',
		'',
		'---------',
		'',
		'Co-authored-by: Dev <d@e.f>',
	].join('\n');
	expect(readIntent([], body)?.why).toEqual(['a', 'b']);
});

test('drops repeats between trailers and body', () => {
	expect(readIntent([trailer('Why', 'a')], 'Why: a\n')?.why).toEqual(['a']);
});

test('reads a value wrapped onto the next line', () => {
	expect(
		readIntent([], 'Why: the roadmap says so, and\nit is a plan.\n'),
	).toEqual({
		why: ['the roadmap says so, and it is a plan.'],
		constraint: [],
		gotcha: [],
		followUp: [],
	});
});

test('an indented continuation in the trailer block gives one entry', () => {
	expect(
		readIntent(
			[trailer('Why', 'the roadmap says so, and')],
			'Why: the roadmap says so, and\n  it is a plan.\n',
		)?.why,
	).toEqual(['the roadmap says so, and it is a plan.']);
});

test('a blank line ends a value', () => {
	expect(readIntent([], 'Why: a\n\nmore prose\n')?.why).toEqual(['a']);
});

test('the next key ends a value', () => {
	const card = readIntent([], 'Why: a\nGotcha: b\nCo-authored-by: Dev\nc\n');
	expect(card?.why).toEqual(['a']);
	expect(card?.gotcha).toEqual(['b']);
});

test('a longer value does not swallow one that only shares letters', () => {
	expect(readIntent([], 'Why: a\nWhy: ab\n')?.why).toEqual(['a', 'ab']);
});

test('keys that name inherited properties are not intent', () => {
	expect(
		readIntent(
			[trailer('constructor', 'x'), trailer('__proto__', 'x')],
			'toString: x\n__proto__: x\n',
		),
	).toBeUndefined();
});

test('the plan commit message gives one why', () => {
	const body = [
		'Why: the roadmap makes this milestone the dogfooding for workstreams, so',
		'the plan is the first stamped commit.',
		'',
		'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
		'Workstream: project-memory',
	].join('\n');
	const why = readIntent([], body)?.why;
	expect(why).toHaveLength(1);
	expect(why?.[0]).toMatch(/first stamped commit\.$/);
});

test('ignores empty values and prose', () => {
	expect(readIntent([trailer('Why', '')], 'Why:\nWhy this works: x\n')).toBe(
		undefined,
	);
});
