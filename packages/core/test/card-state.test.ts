import {expect, test} from 'vitest';
import {cardLineId} from '../src/card-lines.js';
import {
	foldCardState,
	type CardLine,
	type FoldCommit,
	type FoldInput,
} from '../src/card-state.js';
import type {MemoryCommit} from '../src/memory.js';
import type {IntentCard} from '../src/types.js';

const HEAD = 'f'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const R = 'e'.repeat(40);

const PORT = 'The dev server must stay on port 3000';
const PORT_ID = cardLineId('constraint', PORT);
const PORT_4000 = 'The dev server must stay on port 4000';
const PORT_4000_ID = cardLineId('constraint', PORT_4000);
const FLAKY = 'The upload test is flaky on CI';
const FLAKY_ID = cardLineId('gotcha', FLAKY);

function card(lines: Partial<IntentCard>): IntentCard {
	return {why: [], constraint: [], gotcha: [], followUp: [], ...lines};
}

function commit(
	hash: string,
	day: number,
	fields: Partial<Omit<FoldCommit, 'hash' | 'date'>> = {},
): FoldCommit {
	return {
		hash,
		date: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
		subject: `commit ${hash.slice(0, 1)}`,
		resolves: [],
		...fields,
	};
}

/**
 * Folds commits given newest first. Unless told otherwise, a commit later in
 * the array is an ancestor of every commit before it, as on a straight line.
 */
function fold(commits: FoldCommit[], extra: Partial<FoldInput> = {}) {
	const order = commits.map(c => c.hash);
	return foldCardState({
		head: HEAD,
		commits,
		voids: new Map(),
		isAncestor: (ancestor, descendant) =>
			order.indexOf(ancestor) > order.indexOf(descendant),
		survives: new Map(),
		remembered: [],
		...extra,
	});
}

function line(lines: CardLine[], id: string): CardLine | undefined {
	return lines.find(l => l.id === id);
}

test('a line nothing resolves is open', () => {
	const state = fold([commit(A, 1, {card: card({constraint: [PORT]})})]);

	expect(state.head).toBe(HEAD);
	expect(line(state.lines, PORT_ID)).toEqual({
		id: PORT_ID,
		kind: 'constraint',
		text: PORT,
		state: 'open',
		sources: [A],
		date: '2026-11-01T00:00:00Z',
		files: [],
	});
});

test('a later commit that resolves it makes it resolved, with the reason', () => {
	const state = fold([
		commit(R, 3, {resolves: [{id: PORT_ID, reason: 'released in 0.11.0'}]}),
		commit(A, 1, {card: card({constraint: [PORT]})}),
	]);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('resolved');
	expect(found?.resolvedBy).toEqual({
		hash: R,
		date: '2026-11-03T00:00:00Z',
		reason: 'released in 0.11.0',
	});
});

test("with no reason, the resolving commit's subject stands in", () => {
	const state = fold([
		commit(R, 3, {subject: 'Move to the new port', resolves: [{id: PORT_ID}]}),
		commit(A, 1, {card: card({constraint: [PORT]})}),
	]);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('resolved');
	expect(found?.resolvedBy?.reason).toBe('Move to the new port');
});

test('the same text stated again after the resolve is open', () => {
	const state = fold([
		commit(B, 4, {card: card({constraint: [PORT]})}),
		commit(R, 3, {resolves: [{id: PORT_ID}]}),
		commit(A, 1, {card: card({constraint: [PORT]})}),
	]);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('open');
	expect(found?.sources).toEqual([B, A]);
	expect(found?.resolvedBy).toBeUndefined();
});

test('a source that is not an ancestor of the resolving commit keeps the line open', () => {
	const state = fold(
		[
			commit(R, 3, {resolves: [{id: PORT_ID}]}),
			commit(A, 1, {card: card({constraint: [PORT]})}),
		],
		{isAncestor: () => false},
	);

	expect(line(state.lines, PORT_ID)?.state).toBe('open');
});

test('reverting the resolving commit reopens the line', () => {
	const state = fold(
		[
			commit(D, 4, {subject: 'Revert "Move to the new port"'}),
			commit(R, 3, {resolves: [{id: PORT_ID}]}),
			commit(A, 1, {card: card({constraint: [PORT]})}),
		],
		{voids: new Map([[D, [R]]])},
	);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('open');
	expect(found?.resolvedBy).toBeUndefined();
	expect(state.dangling).toEqual([]);
});

test('a revert that is itself reverted undoes nothing', () => {
	const state = fold(
		[
			commit(D, 5),
			commit(C, 4),
			commit(R, 3, {resolves: [{id: PORT_ID}]}),
			commit(A, 1, {card: card({constraint: [PORT]})}),
		],
		{
			voids: new Map([
				[D, [C]],
				[C, [R]],
			]),
		},
	);

	expect(line(state.lines, PORT_ID)?.state).toBe('resolved');
	expect(line(state.lines, PORT_ID)?.resolvedBy?.hash).toBe(R);
});

test("reverting a line's only source removes the line", () => {
	const state = fold(
		[
			commit(D, 3),
			commit(B, 2, {card: card({gotcha: [FLAKY]})}),
			commit(A, 1, {card: card({constraint: [PORT]})}),
		],
		{voids: new Map([[D, [A]]])},
	);

	expect(line(state.lines, PORT_ID)).toBeUndefined();
	expect(state.lines.map(l => [l.id, l.state])).toEqual([[FLAKY_ID, 'open']]);
});

test('an open line whose sources all have survives false is in doubt', () => {
	const state = fold(
		[
			commit(B, 2, {card: card({gotcha: [FLAKY]})}),
			commit(A, 1, {card: card({gotcha: [FLAKY]})}),
		],
		{
			survives: new Map([
				[A, false],
				[B, false],
			]),
		},
	);

	expect(line(state.lines, FLAKY_ID)?.state).toBe('in-doubt');
});

test('a source that added no lines keeps the line open', () => {
	const state = fold(
		[
			commit(B, 2, {card: card({gotcha: [FLAKY]})}),
			commit(A, 1, {card: card({gotcha: [FLAKY]})}),
		],
		{
			survives: new Map([
				[A, false],
				[B, undefined],
			]),
		},
	);

	expect(line(state.lines, FLAKY_ID)?.state).toBe('open');
});

test('one surviving source out of two keeps the line open', () => {
	const state = fold(
		[
			commit(B, 2, {card: card({gotcha: [FLAKY]})}),
			commit(A, 1, {card: card({gotcha: [FLAKY]})}),
		],
		{
			survives: new Map([
				[A, true],
				[B, false],
			]),
		},
	);

	expect(line(state.lines, FLAKY_ID)?.state).toBe('open');
});

test('a resolved line is never in doubt', () => {
	const state = fold(
		[
			commit(R, 3, {resolves: [{id: FLAKY_ID}]}),
			commit(A, 1, {card: card({gotcha: [FLAKY]})}),
		],
		{survives: new Map([[A, false]])},
	);

	expect(line(state.lines, FLAKY_ID)?.state).toBe('resolved');
});

function remembered(
	slug: string,
	status: 'active' | 'shipped' | 'dropped',
	memory: MemoryCommit,
): FoldInput['remembered'][number] {
	return {slug, status, commit: memory};
}

test('a line only in workstream memory is off branch, with its workstream', () => {
	const state = fold([commit(A, 1)], {
		remembered: [
			remembered('old-port', 'dropped', {
				hash: B,
				subject: 'Pin the port',
				date: '2026-11-02T00:00:00Z',
				card: card({constraint: [PORT]}),
			}),
			remembered('new-port', 'active', {
				hash: C,
				subject: 'Pin the port again',
				date: '2026-11-05T00:00:00Z',
				card: card({constraint: [PORT]}),
			}),
		],
	});

	expect(line(state.lines, PORT_ID)).toEqual({
		id: PORT_ID,
		kind: 'constraint',
		text: PORT,
		state: 'off-branch',
		sources: [C, B],
		date: '2026-11-05T00:00:00Z',
		files: [],
		workstream: {slug: 'new-port', status: 'active'},
	});
});

test('an off-branch line that a commit on HEAD resolves is resolved', () => {
	const state = fold(
		[commit(R, 3, {resolves: [{id: PORT_ID, reason: 'dropped the branch'}]})],
		{
			remembered: [
				remembered('old-port', 'dropped', {
					hash: B,
					subject: 'Pin the port',
					date: '2026-11-02T00:00:00Z',
					card: card({constraint: [PORT]}),
				}),
			],
		},
	);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('resolved');
	expect(found?.sources).toEqual([B]);
	expect(found?.resolvedBy).toEqual({
		hash: R,
		date: '2026-11-03T00:00:00Z',
		reason: 'dropped the branch',
	});
	expect(state.dangling).toEqual([]);
});

test('an off-branch line stated again after the resolve stays off branch', () => {
	const state = fold([commit(R, 3, {resolves: [{id: PORT_ID}]})], {
		remembered: [
			remembered('new-port', 'active', {
				hash: B,
				subject: 'Pin the port again',
				date: '2026-11-05T00:00:00Z',
				card: card({constraint: [PORT]}),
			}),
		],
	});

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('off-branch');
	expect(found?.resolvedBy).toBeUndefined();
	expect(found?.workstream).toEqual({slug: 'new-port', status: 'active'});
	expect(state.dangling).toEqual([]);
});

test('an off-branch line whose dates cannot be compared stays off branch', () => {
	const state = fold([commit(R, 3, {resolves: [{id: PORT_ID}]})], {
		remembered: [
			remembered('old-port', 'dropped', {
				hash: B,
				subject: 'Pin the port',
				date: 'not a date',
				card: card({constraint: [PORT]}),
			}),
		],
	});

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('off-branch');
	expect(found?.resolvedBy).toBeUndefined();
	expect(state.dangling).toEqual([]);
});

test('with two resolving commits where only the older covers the source, resolvedBy is the older one', () => {
	const state = fold(
		[
			commit(C, 5, {resolves: [{id: PORT_ID, reason: 'newer'}]}),
			commit(R, 3, {resolves: [{id: PORT_ID, reason: 'older'}]}),
			commit(A, 1, {card: card({constraint: [PORT]})}),
		],
		{isAncestor: (ancestor, descendant) => ancestor === A && descendant === R},
	);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('resolved');
	expect(found?.resolvedBy).toEqual({
		hash: R,
		date: '2026-11-03T00:00:00Z',
		reason: 'older',
	});
});

test('a Resolves: for an id stated only in a voided commit is dangling', () => {
	const state = fold(
		[
			commit(R, 3, {resolves: [{id: PORT_ID}]}),
			commit(D, 2),
			commit(A, 1, {card: card({constraint: [PORT]})}),
		],
		{voids: new Map([[D, [A]]])},
	);

	expect(line(state.lines, PORT_ID)).toBeUndefined();
	expect(state.dangling).toEqual([{id: PORT_ID, hash: R}]);
});

test('a remembered commit that is also on HEAD is not counted as remembered', () => {
	const state = fold([commit(A, 1, {card: card({constraint: [PORT]})})], {
		remembered: [
			remembered('old-port', 'shipped', {
				hash: A,
				subject: 'Pin the port',
				date: '2026-11-01T00:00:00Z',
				card: card({constraint: [PORT, PORT_4000]}),
			}),
		],
	});

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('open');
	expect(found?.sources).toEqual([A]);
	expect(found?.workstream).toBeUndefined();
	expect(line(state.lines, PORT_4000_ID)).toBeUndefined();
});

test('a Resolves: that matches nothing is listed as dangling, with its commit', () => {
	const state = fold([
		commit(R, 3, {resolves: [{id: 'c-00000000'}, {id: PORT_ID}]}),
		commit(A, 1, {card: card({constraint: [PORT]})}),
	]);

	expect(state.dangling).toEqual([{id: 'c-00000000', hash: R}]);
	expect(line(state.lines, PORT_ID)?.state).toBe('resolved');
});

test('a commit that resolves one constraint and states another marks the new one as replacing it', () => {
	const state = fold([
		commit(B, 3, {
			card: card({constraint: [PORT_4000]}),
			resolves: [{id: PORT_ID, reason: 'moved to 4000'}],
		}),
		commit(A, 1, {card: card({constraint: [PORT]})}),
	]);

	const newer = line(state.lines, PORT_4000_ID);
	expect(newer?.state).toBe('open');
	expect(newer?.replaces).toBe(PORT_ID);
	expect(line(state.lines, PORT_ID)?.state).toBe('resolved');
	expect(line(state.lines, PORT_ID)?.replaces).toBeUndefined();
});

test('a commit that states a line and resolves the same id leaves it open', () => {
	const state = fold([
		commit(A, 1, {
			card: card({constraint: [PORT]}),
			resolves: [{id: PORT_ID}],
		}),
	]);

	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('open');
	expect(found?.replaces).toBeUndefined();
});

test('the same text in two commits is one line with two sources, newest first', () => {
	const state = fold([
		commit(B, 2, {
			card: card({constraint: ['the dev server must stay on port 3000.']}),
		}),
		commit(A, 1, {card: card({constraint: [PORT]})}),
	]);

	expect(state.lines).toHaveLength(1);
	const found = line(state.lines, PORT_ID);
	expect(found?.state).toBe('open');
	expect(found?.sources).toEqual([B, A]);
	expect(found?.date).toBe('2026-11-02T00:00:00Z');
	expect(found?.text).toBe('the dev server must stay on port 3000.');
});

test('lines come newest first, then by id', () => {
	const state = fold([
		commit(B, 2, {card: card({gotcha: [FLAKY]})}),
		commit(A, 1, {card: card({constraint: [PORT, PORT_4000]})}),
	]);

	expect(state.lines.map(l => [l.id, l.state])).toEqual([
		[FLAKY_ID, 'open'],
		...[PORT_ID, PORT_4000_ID].sort().map(id => [id, 'open']),
	]);
});
