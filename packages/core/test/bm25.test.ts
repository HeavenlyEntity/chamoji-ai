import {expect, test} from 'vitest';
import {buildIndex, queryIndex, tokenize} from '../src/bm25.js';

const doc = (id: string, text: string, weight = 1) => ({
	id,
	fields: [{text, weight}],
});

test('bm25 ranks a rarer term higher', () => {
	const index = buildIndex([
		doc('rare', 'zebra'),
		doc('common', 'common'),
		doc('a', 'common'),
		doc('b', 'common'),
	]);
	const hits = queryIndex(index, 'zebra common', 10);
	expect(hits[0]?.id).toBe('rare');
	expect(hits.map(hit => hit.id)).toContain('common');
});

test('shorter documents score higher for the same term', () => {
	const index = buildIndex([
		doc('long', 'login with some more words that pad this one out a good deal'),
		doc('short', 'login page'),
	]);
	const [first, second] = queryIndex(index, 'login', 10);
	expect(first?.id).toBe('short');
	expect(first!.score).toBeGreaterThan(second!.score);
});

test('a field weight changes the order', () => {
	const documents = (weightOfFirst: number) => [
		{id: 'first', fields: [{text: 'cache', weight: weightOfFirst}]},
		{id: 'second', fields: [{text: 'cache', weight: 2}]},
	];
	expect(queryIndex(buildIndex(documents(1)), 'cache', 10)[0]?.id).toBe(
		'second',
	);
	expect(queryIndex(buildIndex(documents(3)), 'cache', 10)[0]?.id).toBe(
		'first',
	);
});

test('an empty query gives no results', () => {
	const index = buildIndex([doc('a', 'login')]);
	expect(queryIndex(index, '', 10)).toEqual([]);
	expect(queryIndex(index, '  ,. ', 10)).toEqual([]);
	expect(queryIndex(buildIndex([]), 'login', 10)).toEqual([]);
});

test('a query that matches nothing, or a limit of zero, gives no results', () => {
	const index = buildIndex([doc('a', 'login')]);
	expect(queryIndex(index, 'logout', 10)).toEqual([]);
	expect(queryIndex(index, 'login', 0)).toEqual([]);
});

test('the limit cuts the list and ties keep document order', () => {
	const index = buildIndex([doc('a', 'x'), doc('b', 'x'), doc('c', 'x')]);
	expect(queryIndex(index, 'x', 2).map(hit => hit.id)).toEqual(['a', 'b']);
});

test('tokenize lowercases and splits on anything that is not a letter or number', () => {
	expect(tokenize('Fix the Cache-Key: v2, (again)!')).toEqual([
		'fix',
		'the',
		'cache',
		'key',
		'v2',
		'again',
	]);
});

test('tokenize keeps non-Latin words', () => {
	expect(tokenize('日本語のコミット')).toEqual(['日本語のコミット']);
	expect(tokenize('Исправить кэш, добавить 缓存')).toEqual([
		'исправить',
		'кэш',
		'добавить',
		'缓存',
	]);
	const index = buildIndex([doc('jp', '日本語のコミット')]);
	expect(queryIndex(index, '日本語のコミット', 10)[0]?.id).toBe('jp');
});

test('terms named like Object properties are ordinary terms', () => {
	const index = buildIndex([
		doc('a', 'constructor __proto__ toString hasOwnProperty'),
		doc('b', 'something else'),
	]);
	for (const term of ['constructor', '__proto__', 'toString']) {
		expect(queryIndex(index, term, 10).map(hit => hit.id)).toEqual(['a']);
	}

	expect(queryIndex(index, 'valueOf', 10)).toEqual([]);
});

test('a query repeating a term does not count it twice', () => {
	const index = buildIndex([doc('a', 'login'), doc('b', 'logout')]);
	expect(queryIndex(index, 'login login login', 10)).toEqual(
		queryIndex(index, 'login', 10),
	);
});
