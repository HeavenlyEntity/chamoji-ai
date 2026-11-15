import {expect, test} from 'vitest';
import {cardLineId, linesOf} from '../src/card-lines.js';

test('an id is a kind letter, a dash and 8 hex characters', () => {
	expect(cardLineId('constraint', 'The ref layout is fixed.')).toMatch(
		/^c-[0-9a-f]{8}$/,
	);
	expect(cardLineId('gotcha', 'x')).toMatch(/^g-[0-9a-f]{8}$/);
	expect(cardLineId('followUp', 'x')).toMatch(/^f-[0-9a-f]{8}$/);
});

test('case, spacing and trailing punctuation do not change the id', () => {
	const id = cardLineId('constraint', 'The ref layout is fixed.');
	expect(cardLineId('constraint', '  the REF   layout\tis fixed ')).toBe(id);
	expect(cardLineId('constraint', 'The ref layout is fixed!?')).toBe(id);
});

test('the kind is part of the hash', () => {
	expect(cardLineId('gotcha', 'same').slice(2)).not.toBe(
		cardLineId('constraint', 'same').slice(2),
	);
});

test('linesOf lists constraint, gotcha and follow-up lines, never why, with repeats joined', () => {
	const lines = linesOf({
		why: ['a'],
		constraint: ['B', 'b.'],
		gotcha: [],
		followUp: ['c'],
	});
	expect(lines.map(line => line.kind)).toEqual(['constraint', 'followUp']);
	expect(lines[0]!.text).toBe('B');
	expect(linesOf(undefined)).toEqual([]);
});
