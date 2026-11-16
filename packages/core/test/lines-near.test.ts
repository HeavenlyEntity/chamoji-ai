import {expect, test} from 'vitest';
import type {CardLine, CardState} from '../src/card-state.js';
import {linesNear, nudgeText} from '../src/lines-near.js';

const HEAD = 'f'.repeat(40);
const H1 = '1'.repeat(40);

function line(id: string, fields: Partial<CardLine> = {}): CardLine {
	return {
		id,
		kind: 'constraint',
		text: `text of ${id}`,
		state: 'open',
		sources: [H1],
		date: '2026-11-10T00:00:00Z',
		files: ['src/server.ts'],
		...fields,
	};
}

const state = (lines: CardLine[]): CardState => ({
	head: HEAD,
	lines,
	dangling: [],
});

test('an open line whose files include a changed path is near', () => {
	const open = line('c-00000001');
	const doubt = line('g-00000002', {
		kind: 'gotcha',
		state: 'in-doubt',
		files: ['README.md', 'src/server.ts'],
	});
	const elsewhere = line('c-00000003', {files: ['src/client.ts']});
	const noFiles = line('f-00000004', {kind: 'followUp', files: []});
	const lines = linesNear(state([open, doubt, elsewhere, noFiles]), [
		'docs/a.md',
		'src/server.ts',
	]);
	expect(lines.map(found => found.id)).toEqual(['c-00000001', 'g-00000002']);
	expect(lines[0]).toBe(open);

	// A path must match whole, not as a prefix or in another folder.
	expect(
		linesNear(state([open]), ['src/server.tsx', 'server.ts', 'src']),
	).toEqual([]);
	expect(linesNear(state([open]), [])).toEqual([]);
});

test('a resolved line and an off-branch line are never near', () => {
	const lines = [
		line('c-00000001', {
			state: 'resolved',
			resolvedBy: {hash: H1, date: '2026-11-11T00:00:00Z', reason: 'done'},
		}),
		line('c-00000002', {state: 'off-branch'}),
		line('c-00000003', {state: 'reverted'}),
	];
	expect(linesNear(state(lines), ['src/server.ts'])).toEqual([]);
});

test('at most five lines come back, newest first', () => {
	const lines = [
		line('c-00000001', {date: '2026-11-01T00:00:00Z'}),
		line('c-00000002', {date: '2026-11-07T00:00:00Z'}),
		line('c-00000003', {date: '2026-11-03T00:00:00Z'}),
		line('c-0000000b', {date: '2026-11-06T00:00:00Z'}),
		line('c-0000000a', {date: '2026-11-06T00:00:00Z'}),
		line('c-00000006', {date: '2026-11-02T00:00:00Z'}),
		// The same moment in another zone is the same time.
		line('c-00000007', {date: '2026-11-05T02:00:00+02:00'}),
	];
	const near = linesNear(state(lines), ['src/server.ts']);
	expect(near.map(found => found.id)).toEqual([
		'c-00000002',
		'c-0000000a',
		'c-0000000b',
		'c-00000007',
		'c-00000003',
	]);

	expect(
		linesNear(state(lines), ['src/server.ts'], 2).map(found => found.id),
	).toEqual(['c-00000002', 'c-0000000a']);
	expect(linesNear(state(lines), ['src/server.ts'], 0)).toEqual([]);
	expect(linesNear(state(lines), ['src/server.ts'], -3)).toEqual([]);
	// The state's own lines are left in their order.
	expect(lines[0]!.id).toBe('c-00000001');
});

test('nudgeText prints one exact paragraph per line', () => {
	expect(nudgeText([])).toBe('');
	expect(
		nudgeText([line('c-00000001', {text: 'Port 8080 is fixed by the proxy'})]),
	).toBe(
		'This commit touched code under c-00000001 "Port 8080 is fixed by the proxy". If it ended that, run chamoji memory resolve c-00000001 --because "<reason>".',
	);

	const long = `${'a'.repeat(118)} bcdef`;
	const text = nudgeText([
		line('c-00000001', {text: 'one\nline\u001B[31m  with\tcontrols'}),
		line('g-00000002', {kind: 'gotcha', text: long}),
	]);
	expect(text).toBe(
		[
			'This commit touched code under c-00000001 "one line[31m with controls". If it ended that, run chamoji memory resolve c-00000001 --because "<reason>".',
			`This commit touched code under g-00000002 "${'a'.repeat(118)}…". If it ended that, run chamoji memory resolve g-00000002 --because "<reason>".`,
		].join('\n\n'),
	);
	expect(text.endsWith('\n')).toBe(false);
});
