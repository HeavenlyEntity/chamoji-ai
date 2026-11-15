import {expect, test} from 'vitest';
import {readResolves, readRevertedHash} from '../src/resolves.js';

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
