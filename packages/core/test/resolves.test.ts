import {expect, test} from 'vitest';
import {
	readResolves,
	readRevertedHash,
	readRevertedMainline,
} from '../src/resolves.js';

test('a trailer gives the id and the reason after it', () => {
	expect(
		readResolves(
			[{key: 'Resolves', value: 'c-7f3a91be released in 0.11.0'}],
			'',
		),
	).toEqual([{id: 'c-7f3a91be', reason: 'released in 0.11.0'}]);
});

test('lines in the middle of a body count, as a squash message leaves them', () => {
	expect(
		readResolves(
			[],
			'text\n\nResolves: c-7f3a91be\nResolves: g-0c55e1d2 fixed upstream\n\nmore',
		),
	).toEqual([{id: 'c-7f3a91be'}, {id: 'g-0c55e1d2', reason: 'fixed upstream'}]);
});

test('a value that is not a card id is left alone', () => {
	expect(
		readResolves([{key: 'Resolves', value: '#123'}], 'Resolves: the bug'),
	).toEqual([]);
});

test('an id typed in capitals or with a full stop still counts', () => {
	expect(readResolves([], 'Resolves: C-7F3A91BE.')).toEqual([
		{id: 'c-7f3a91be'},
	]);
});

test('the same id in the trailers and the body is read once', () => {
	expect(
		readResolves(
			[{key: 'Resolves', value: 'c-7f3a91be'}],
			'Resolves: c-7f3a91be',
		),
	).toHaveLength(1);
});

test('a reason that is only spaces is no reason', () => {
	expect(readResolves([], 'Resolves: c-7f3a91be   ')).toEqual([
		{id: 'c-7f3a91be'},
	]);
});

test('other keys are ignored and the key is not case sensitive', () => {
	expect(
		readResolves(
			[{key: 'Why', value: 'c-7f3a91be'}],
			'resolves: f-00000001 done',
		),
	).toEqual([{id: 'f-00000001', reason: 'done'}]);
});

test('Resolves: with no space after the colon reads the same as a trailer and in a body', () => {
	const expected = [{id: 'c-7f3a91be', reason: 'released'}];
	expect(
		readResolves([{key: 'Resolves', value: 'c-7f3a91be released'}], ''),
	).toEqual(expected);
	expect(readResolves([], 'text\n\nResolves:c-7f3a91be released')).toEqual(
		expected,
	);
	expect(readResolves([], 'Resolves:\tc-7f3a91be released')).toEqual(expected);
});

test('only the first id on a line is resolved, and the rest is the reason', () => {
	expect(readResolves([], 'Resolves: c-7f3a91be, g-0c55e1d2')).toEqual([
		{id: 'c-7f3a91be', reason: 'g-0c55e1d2'},
	]);
	expect(
		readResolves([{key: 'Resolves', value: 'c-7f3a91be g-0c55e1d2 both'}], ''),
	).toEqual([{id: 'c-7f3a91be', reason: 'g-0c55e1d2 both'}]);
});

test('an id in backticks counts', () => {
	expect(readResolves([], 'Resolves: `c-7f3a91be` released')).toEqual([
		{id: 'c-7f3a91be', reason: 'released'},
	]);
	expect(readResolves([{key: 'Resolves', value: '`G-0C55E1D2`.'}], '')).toEqual(
		[{id: 'g-0c55e1d2'}],
	);
});

test('an id in quotes, brackets or parentheses does not count', () => {
	for (const wrapped of [
		'"c-7f3a91be"',
		"'c-7f3a91be'",
		'[c-7f3a91be]',
		'(c-7f3a91be)',
		'{c-7f3a91be}',
		'<c-7f3a91be>',
		'`c-7f3a91be',
	]) {
		expect(readResolves([], `Resolves: ${wrapped} released`)).toEqual([]);
		expect(
			readResolves([{key: 'Resolves', value: `${wrapped} released`}], ''),
		).toEqual([]);
	}
});

test("readRevertedHash reads git revert's line, for a commit and for a merge", () => {
	const hash = 'a'.repeat(40);
	expect(readRevertedHash(`This reverts commit ${hash}.`)).toBe(hash);
	expect(
		readRevertedHash(
			`This reverts commit ${hash}, reversing\nchanges made to ${'b'.repeat(40)}.`,
		),
	).toBe(hash);
	expect(readRevertedHash('Reverts the layout change')).toBeUndefined();
});

test('readRevertedMainline reads the parent a merge revert kept, wrapped or not', () => {
	const merge = 'a'.repeat(40);
	const mainline = 'b'.repeat(40);
	expect(
		readRevertedMainline(
			`This reverts commit ${merge}, reversing\nchanges made to ${mainline}.`,
		),
	).toBe(mainline);
	expect(
		readRevertedMainline(
			`This reverts commit ${merge}, reversing changes made to ${mainline}.`,
		),
	).toBe(mainline);
	expect(readRevertedMainline(`This reverts commit ${merge}.`)).toBeUndefined();
});
