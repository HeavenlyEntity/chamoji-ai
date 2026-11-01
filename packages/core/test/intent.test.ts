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

test('ignores empty values and prose', () => {
	expect(readIntent([trailer('Why', '')], 'Why:\nWhy this works: x\n')).toBe(
		undefined,
	);
});
