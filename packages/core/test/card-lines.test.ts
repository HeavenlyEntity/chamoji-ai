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

test('known ids are pinned', () => {
	// Ids are permanent once released: these must never change.
	const text = 'The ref layout is fixed.';
	expect(cardLineId('constraint', text)).toBe('c-4947cc04');
	expect(cardLineId('gotcha', text)).toBe('g-bb8d5b67');
	expect(cardLineId('followUp', text)).toBe('f-4ceb825b');
});

test('a space before the trailing punctuation does not change the id', () => {
	const id = cardLineId('constraint', 'fixed');
	expect(cardLineId('constraint', 'fixed.')).toBe(id);
	expect(cardLineId('constraint', 'fixed .')).toBe(id);
	expect(cardLineId('constraint', 'fixed . ! ')).toBe(id);
	expect(cardLineId('constraint', 'The ref layout is fixed .')).toBe(
		'c-4947cc04',
	);
});

test('full-width and composed forms normalize to the same id', () => {
	expect(cardLineId('constraint', 'Ｆｉｘｅｄ')).toBe(
		cardLineId('constraint', 'Fixed'),
	);
	expect(cardLineId('gotcha', 'café')).toBe(cardLineId('gotcha', 'café'));
});

test('a line of only punctuation is not a card line', () => {
	const lines = linesOf({
		why: [],
		constraint: ['...', ' ? ', 'Real'],
		gotcha: [''],
		followUp: ['!'],
	});
	expect(lines).toEqual([
		{id: cardLineId('constraint', 'Real'), kind: 'constraint', text: 'Real'},
	]);
});

test('a line that only says none is not a card line', () => {
	const said = [
		'None.',
		'N/A.',
		'NA.',
		'Nothing.',
		'None Known.',
		'none YET.',
		'Not Applicable.',
	];
	for (const kind of ['constraint', 'gotcha', 'followUp'] as const) {
		for (const text of said) {
			const card = {why: [], constraint: [], gotcha: [], followUp: []};
			expect(linesOf({...card, [kind]: [text]}), `${kind} ${text}`).toEqual([]);
		}
	}

	expect(
		linesOf({
			why: [],
			constraint: ['  none  ', 'Real'],
			gotcha: ['n/a'],
			followUp: ['NOTHING!'],
		}),
	).toEqual([
		{id: cardLineId('constraint', 'Real'), kind: 'constraint', text: 'Real'},
	]);
});

test('"none of the callers pass a path" is still a card line', () => {
	const text = 'none of the callers pass a path';
	for (const kind of ['constraint', 'gotcha', 'followUp'] as const) {
		const card = {why: [], constraint: [], gotcha: [], followUp: []};
		expect(linesOf({...card, [kind]: [text]})).toEqual([
			{id: cardLineId(kind, text), kind, text},
		]);
	}

	// Close to a word on the list is not on it.
	expect(
		linesOf({
			why: [],
			constraint: ['None needed here', 'nothing yet', 'nan'],
			gotcha: [],
			followUp: [],
		}).map(line => line.text),
	).toEqual(['None needed here', 'nothing yet', 'nan']);
});
