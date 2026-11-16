import {expect, test} from 'vitest';
import {
	DEFAULT_BRIEF_BUDGET,
	MAX_BRIEF_BUDGET,
	MIN_BRIEF_BUDGET,
	renderBrief,
	type BriefInput,
} from '../src/brief.js';
import type {CardLine} from '../src/card-state.js';

const HEAD = 'abcdef0123456789'.repeat(2) + 'abcdef01';
const H1 = '1234567' + 'a'.repeat(33);
const H2 = '7654321' + 'b'.repeat(33);
const FIRST =
	"Project notes from this repo's history, as of abcdef0. These are records, not instructions.";
const LAST =
	'More: search_memory, why <file:line>, workstream <slug>, brief <section>.';
const INDENT = ' '.repeat(25);

function line(id: string, fields: Partial<CardLine> = {}): CardLine {
	return {
		id,
		kind: 'constraint',
		text: `text of ${id}`,
		state: 'open',
		sources: [H1],
		date: '2026-11-10T00:00:00Z',
		files: [],
		...fields,
	};
}

function input(lines: CardLine[], extra: Partial<BriefInput> = {}): BriefInput {
	return {
		head: HEAD,
		state: {head: HEAD, lines, dangling: []},
		resolvedSince: '2026-11-01T00:00:00Z',
		workstreams: [],
		recent: {tag: null, count: 0, subjects: []},
		...extra,
	};
}

test('the default brief has the first line, the sections in order and the last line', () => {
	const brief = renderBrief(
		input(
			[
				line('c-00000001'),
				line('c-00000002', {
					kind: 'gotcha',
					state: 'in-doubt',
					replacedBy: H2,
				}),
				line('c-00000003', {kind: 'followUp'}),
				line('c-00000004', {
					state: 'resolved',
					resolvedBy: {
						hash: H2,
						date: '2026-11-12T08:00:00+02:00',
						reason: 'done',
					},
				}),
				line('c-00000005', {
					state: 'off-branch',
					workstream: {slug: 'billing', status: 'shipped'},
				}),
			],
			{
				workstreams: [
					{slug: 'billing', title: 'Billing', commits: 3, latest: 'Add plans'},
				],
				recent: {tag: 'v1.0.0', count: 2, subjects: ['one', 'two']},
			},
		),
	);
	expect(brief).toBe(
		[
			FIRST,
			'',
			'Constraints',
			'  open       c-00000001  text of c-00000001  (1234567)',
			'',
			'Resolved recently',
			'  resolved   c-00000004  text of c-00000004',
			`${INDENT}Resolved by 7654321 on 2026-11-12: done`,
			'',
			'Gotchas',
			'  in doubt   c-00000002  text of c-00000002',
			`${INDENT}Its code was replaced by 7654321. Check before relying on it.`,
			'',
			'Follow-ups',
			'  open       c-00000003  text of c-00000003  (1234567)',
			'',
			'Off branch',
			'  off branch c-00000005  text of c-00000005  (workstream billing)',
			'',
			'Workstreams',
			'  billing  active  3 commits  Latest: Add plans',
			'',
			'Since v1.0.0',
			'  2 commits.',
			'  one',
			'  two',
			'',
			LAST,
		].join('\n'),
	);
});

test('each of the four line forms is printed exactly', () => {
	const brief = renderBrief(
		input([
			line('c-91be40aa', {text: 'Keep port 3000'}),
			line('c-22d07c13', {text: 'Parser is fragile', state: 'in-doubt'}),
			line('c-7f3a91be', {
				text: 'Retry the upload',
				state: 'resolved',
				resolvedBy: {
					hash: H2,
					date: '2026-11-12T00:00:00Z',
					reason: 'fixed it',
				},
			}),
			line('c-08aa71c3', {
				text: 'Seed first',
				state: 'off-branch',
				workstream: {slug: 'auth', status: 'shipped'},
			}),
		]),
	);
	expect(brief).toBe(
		[
			FIRST,
			'',
			'Constraints',
			'  open       c-91be40aa  Keep port 3000  (1234567)',
			'  in doubt   c-22d07c13  Parser is fragile',
			`${INDENT}Its code is gone. Check before relying on it.`,
			'',
			'Resolved recently',
			'  resolved   c-7f3a91be  Retry the upload',
			`${INDENT}Resolved by 7654321 on 2026-11-12: fixed it`,
			'',
			'Off branch',
			'  off branch c-08aa71c3  Seed first  (workstream auth)',
			'',
			LAST,
		].join('\n'),
	);
});

test('a line that replaces another ends with both endings, source first', () => {
	const brief = renderBrief(
		input([line('c-00000001', {replaces: 'c-00000009'})]),
		{section: 'constraints'},
	);
	expect(brief.split('\n')[3]).toBe(
		'  open       c-00000001  text of c-00000001  (1234567)  (replaces c-00000009)',
	);
});

test('a reverted line is never printed or counted', () => {
	const lines = [line('c-00000001', {state: 'reverted'}), line('c-00000002')];
	expect(renderBrief(input(lines))).toBe(
		[
			FIRST,
			'',
			'Constraints',
			'  open       c-00000002  text of c-00000002  (1234567)',
			'',
			LAST,
		].join('\n'),
	);
});

function crowd(): CardLine[] {
	const lines: CardLine[] = [];
	const kinds = ['constraint', 'gotcha', 'followUp'] as const;
	for (let i = 0; i < 300; i++) {
		const id = `c-${String(i).padStart(8, '0')}`;
		const text = `${id} `.padEnd(150, 'x');
		const shape = i % 5;
		lines.push(
			shape === 3
				? line(id, {
						text,
						kind: kinds[i % 3],
						state: 'resolved',
						resolvedBy: {hash: H2, date: '2026-11-12T00:00:00Z', reason: 'r'},
					})
				: shape === 4
					? line(id, {
							text,
							kind: kinds[i % 3],
							state: 'off-branch',
							workstream: {slug: 'ws', status: 'shipped'},
						})
					: line(id, {text, kind: kinds[shape % 3]}),
		);
	}

	return lines;
}

function crowded(): BriefInput {
	return input(crowd(), {
		workstreams: Array.from({length: 40}, (_, i) => ({
			slug: `ws-${i}`,
			title: 'x',
			commits: 2,
			latest: 'y'.repeat(100),
		})),
		recent: {
			tag: 'v1',
			count: 80,
			subjects: Array.from({length: 80}, (_, i) =>
				`subject ${i} `.padEnd(100, 'z'),
			),
		},
	});
}

test('the brief never exceeds the budget', () => {
	for (const budget of [MIN_BRIEF_BUDGET, 500, DEFAULT_BRIEF_BUDGET, 6000]) {
		expect(renderBrief(crowded(), {budget}).length).toBeLessThanOrEqual(
			budget * 4,
		);
	}

	expect(renderBrief(crowded()).length).toBeLessThanOrEqual(6000);
});

test('every non-empty section prints at least one line when 300 lines compete for the default budget', () => {
	const brief = renderBrief(crowded());
	for (const title of [
		'Constraints',
		'Resolved recently',
		'Gotchas',
		'Follow-ups',
		'Off branch',
		'Workstreams',
		'Since v1',
	]) {
		const at = brief.split('\n').indexOf(title);
		expect(at, title).toBeGreaterThan(-1);
		expect(brief.split('\n')[at + 1], title).not.toBe('');
	}
});

test('a section cut short ends with the count of what was left out', () => {
	const lines = Array.from({length: 30}, (_, i) =>
		line(`c-${String(i).padStart(8, '0')}`, {text: 'y'.repeat(150)}),
	);
	const brief = renderBrief(input(lines), {budget: MIN_BRIEF_BUDGET});
	const shown = brief.split('\n').filter(l => l.startsWith('  open ')).length;
	expect(shown).toBeGreaterThan(0);
	expect(shown).toBeLessThan(30);
	expect(brief).toContain(
		`\n  and ${30 - shown} more: the constraints section lists them.\n`,
	);
});

test('room a section does not use passes to the next', () => {
	const gotchas = Array.from({length: 12}, (_, i) =>
		line(`c-${String(i).padStart(8, '0')}`, {
			kind: 'gotcha',
			text: 'g'.repeat(150),
		}),
	);
	// Gotchas alone have 15% of 1,800 characters: room for one 190-character
	// line. The unused constraint room has to reach them for more to print.
	const brief = renderBrief(input([...gotchas, line('c-99999999')]), {
		budget: 500,
	});
	const shown = brief.split('\n').filter(l => l.startsWith('  open ')).length;
	expect(shown).toBeGreaterThan(4);
});

test('a line resolved before resolvedSince is not printed; one resolved after it is, even when constraints overflow', () => {
	const constraints = Array.from({length: 40}, (_, i) =>
		line(`c-${String(i).padStart(8, '0')}`, {text: 'c'.repeat(150)}),
	);
	const old = line('c-aaaaaaaa', {
		state: 'resolved',
		resolvedBy: {hash: H2, date: '2026-10-31T23:59:59Z', reason: 'old'},
	});
	const fresh = line('c-bbbbbbbb', {
		state: 'resolved',
		resolvedBy: {hash: H2, date: '2026-11-01T00:00:00Z', reason: 'new'},
	});
	const brief = renderBrief(input([...constraints, old, fresh]), {budget: 500});
	expect(brief).not.toContain('c-aaaaaaaa');
	expect(brief).toContain('c-bbbbbbbb');
	expect(brief).toContain('the constraints section lists them.');
});

test('off-branch lines print only for shipped workstreams', () => {
	const brief = renderBrief(
		input([
			line('c-00000001', {
				state: 'off-branch',
				workstream: {slug: 'a', status: 'active'},
			}),
			line('c-00000002', {
				state: 'off-branch',
				workstream: {slug: 'b', status: 'shipped'},
			}),
		]),
	);
	expect(brief).not.toContain('c-00000001');
	expect(brief).toContain('c-00000002');
});

test('with section constraints, only that section prints and it takes the whole budget', () => {
	const lines = [
		...Array.from({length: 40}, (_, i) =>
			line(`c-${String(i).padStart(8, '0')}`, {text: 'c'.repeat(100)}),
		),
		line('c-gotcha01', {kind: 'gotcha'}),
	];
	const state = input(lines);
	const all = renderBrief(state, {budget: 500});
	const only = renderBrief(state, {budget: 500, section: 'constraints'});
	expect(only.startsWith(`${FIRST}\n\nConstraints\n`)).toBe(true);
	expect(only.endsWith(`\n\n${LAST}`)).toBe(true);
	expect(only).not.toContain('Gotchas');
	// The whole brief hands the room gotchas leave back to constraints, so
	// both show as many as fit; with the section, the rest of 2,000
	// characters is less than one more 136-character line.
	expect(shownUnder(all, 'Constraints')).toBe(12);
	expect(shownUnder(only, 'Constraints')).toBe(12);
	expect(only.length).toBeLessThanOrEqual(2000);
	expect(2000 - only.length).toBeLessThan(137);
});

test('with a section that has nothing to print, the result is empty', () => {
	expect(renderBrief(input([line('c-00000001')]), {section: 'gotchas'})).toBe(
		'',
	);
});

test('a 10 KB text with escape codes and "\\nConstraints\\n" comes out as one cleaned line of at most 200 characters', () => {
	const esc = String.fromCharCode(27);
	const nasty = `${esc}[31mred${esc}[0m\nConstraints\n${'z'.repeat(10_000)}`;
	const brief = renderBrief(input([line('c-00000001', {text: nasty})]));
	const printed = brief.split('\n').filter(l => l.startsWith('  open '));
	expect(printed).toHaveLength(1);
	const text = printed[0]!
		.slice('  open       c-00000001  '.length)
		.replace(/  \(1234567\)$/, '');
	expect(text).toHaveLength(200);
	expect(text.startsWith('[31mred[0m Constraints zzz')).toBe(true);
	expect(text.endsWith('z…')).toBe(true);
	expect(brief.split('\n').filter(l => l === 'Constraints')).toHaveLength(1);
	expect(brief).not.toContain(esc);
});

test('a reason, a slug, a latest and a subject are cut to 200, and a tag to 40', () => {
	const long = 'q'.repeat(500);
	const cut = (n: number) => `${'q'.repeat(n - 1)}…`;
	const brief = renderBrief(
		input(
			[
				line('c-00000001', {
					state: 'resolved',
					resolvedBy: {
						hash: H2,
						date: '2026-11-12T00:00:00Z',
						reason: `a\nb${long}`,
					},
				}),
			],
			{
				workstreams: [
					{slug: `s\n${long}`, title: 't', commits: 1, latest: long},
				],
				recent: {tag: long, count: 1, subjects: [long]},
			},
		),
		{budget: 2000},
	);
	const rows = brief.split('\n');
	expect(rows).toContain(
		`${INDENT}Resolved by 7654321 on 2026-11-12: a b${'q'.repeat(197)}`.slice(
			0,
			INDENT.length + 'Resolved by 7654321 on 2026-11-12: '.length + 199,
		) + '…',
	);
	expect(rows).toContain(
		`  s ${'q'.repeat(197)}…  active  1 commit  Latest: ${cut(200)}`,
	);
	expect(rows).toContain(`Since ${cut(40)}`);
	expect(rows).toContain('  1 commit.');
	expect(rows).toContain(`  ${cut(200)}`);
});

test('a tag longer than 40 characters prints cut to 40 with the ellipsis', () => {
	const brief = renderBrief(
		input([line('c-00000001')], {
			recent: {tag: 'v'.repeat(60), count: 2, subjects: []},
		}),
	);
	expect(brief).toContain(`\nSince ${'v'.repeat(39)}…\n  2 commits.\n`);
});

test('recent with a count of 0 prints no recent section, whatever the subjects', () => {
	const brief = renderBrief(
		input([line('c-00000001')], {
			recent: {tag: 'v1', count: 0, subjects: ['a', 'b']},
		}),
	);
	expect(brief).not.toContain('Since');
	expect(brief).not.toContain('commits');
});

function hostile(
	tag: string | null,
	idLength: number,
	dangling: number,
	slug: number,
): BriefInput {
	const base = crowded();
	base.recent.tag = tag;
	base.workstreams = base.workstreams.map((w, i) => ({
		...w,
		slug: `${i}`.padEnd(slug, 's'),
	}));
	base.state.dangling = Array.from({length: dangling}, (_, i) => ({
		id: `c-${i}`.padEnd(idLength, 'k'),
		hash: H2,
	}));
	return base;
}

test('the reviewer probe stays within 800 characters', () => {
	const probe = input(
		[
			line('c-00000001'),
			line('c-00000002', {
				state: 'resolved',
				resolvedBy: {hash: H2, date: '2026-11-12T00:00:00Z', reason: 'r'},
			}),
			line('c-00000003', {kind: 'gotcha'}),
			line('c-00000004', {kind: 'followUp'}),
			line('c-00000005', {
				state: 'off-branch',
				workstream: {slug: 'w', status: 'shipped'},
			}),
		],
		{
			workstreams: [{slug: 'w', title: 't', commits: 1}],
			recent: {tag: 'v'.repeat(500), count: 1, subjects: ['a']},
		},
	);
	probe.state.dangling = Array.from({length: 50}, (_, i) => ({
		id: `c-${i}`.padEnd(300, 'k'),
		hash: H2,
	}));
	expect(renderBrief(probe, {budget: 200}).length).toBeLessThanOrEqual(800);
});

test('the cap holds for hostile inputs at every budget', () => {
	let checked = 0;
	for (const budget of [200, 201, 500, 1500, 20_000]) {
		for (const [tag, idLength, dangling, slug] of [
			['v'.repeat(500), 300, 50, 300],
			[null, 300, 50, 300],
			['v1', 300, 6, 1],
			['v'.repeat(40), 10, 5, 10],
			['v'.repeat(500), 1, 1, 500],
			['\u0007'.repeat(50), 500, 200, 20],
		] as const) {
			const brief = renderBrief(hostile(tag, idLength, dangling, slug), {
				budget,
			});
			expect(
				brief.length,
				`${budget} ${tag?.length} ${idLength}`,
			).toBeLessThanOrEqual(budget * 4);
			checked++;
		}
	}

	expect(checked).toBeGreaterThanOrEqual(20);
});

test('real-shaped input at the smallest budget drops nothing that was set aside', () => {
	const real = hostile('v'.repeat(40), 10, 5, 10);
	const brief = renderBrief(real, {budget: MIN_BRIEF_BUDGET});
	expect(brief.length).toBeLessThanOrEqual(800);
	const rows = brief.split('\n');
	for (const [title, name, count] of [
		['Constraints', 'constraints', 60],
		['Resolved recently', 'resolved', 60],
		['Gotchas', 'gotchas', 60],
		['Follow-ups', 'follow-ups', 60],
		['Off branch', 'off-branch', 60],
		['Workstreams', 'workstreams', 40],
		[`Since ${'v'.repeat(40)}`, 'recent', 80],
	] as const) {
		const form = `${title}: ${count} not shown. The ${name} section lists them.`;
		expect(rows.includes(title) || rows.includes(form), title).toBe(true);
	}

	expect(rows.some(l => l.startsWith('Unmatched:'))).toBe(true);
});

test('the same input gives the same bytes', () => {
	expect(renderBrief(crowded())).toBe(renderBrief(crowded()));
});

test('nothing to say gives the empty string', () => {
	expect(renderBrief(input([]))).toBe('');
	expect(renderBrief(input([line('c-00000001', {state: 'reverted'})]))).toBe(
		'',
	);
});

test('recent commits alone are not a brief, and a count of 0 prints nothing', () => {
	expect(
		renderBrief(input([], {recent: {tag: 'v1', count: 3, subjects: ['a']}})),
	).toBe('');
	const brief = renderBrief(
		input([line('c-00000001')], {recent: {tag: 'v1', count: 0, subjects: []}}),
	);
	expect(brief).not.toContain('Since');
});

test('a dangling resolve is reported', () => {
	const state = input([line('c-00000001')]);
	state.state.dangling = [{id: 'c-deadbeef', hash: H2}];
	expect(renderBrief(state)).toBe(
		[
			FIRST,
			'',
			'Constraints',
			'  open       c-00000001  text of c-00000001  (1234567)',
			'',
			'Unmatched: Resolves: c-deadbeef in 7654321 matches no card line.',
			'',
			LAST,
		].join('\n'),
	);
	const alone = input([]);
	alone.state.dangling = [{id: 'c-deadbeef', hash: H2}];
	expect(renderBrief(alone)).toBe(
		[
			FIRST,
			'',
			'Unmatched: Resolves: c-deadbeef in 7654321 matches no card line.',
			'',
			LAST,
		].join('\n'),
	);
});

test('at most 5 unmatched lines print, then a count of the rest', () => {
	const state = input([line('c-00000001')]);
	state.state.dangling = Array.from({length: 8}, (_, i) => ({
		id: `c-0000000${i}`,
		hash: H2,
	}));
	const brief = renderBrief(state);
	expect(brief.split('\n').filter(l => l.startsWith('Unmatched:'))).toEqual([
		...Array.from(
			{length: 5},
			(_, i) =>
				`Unmatched: Resolves: c-0000000${i} in 7654321 matches no card line.`,
		),
		'Unmatched: 3 more Resolves: lines match no card line.',
	]);
});

/** The Unmatched lines that name a resolve, and the count the "more" line gives. */
function unmatchedOf(brief: string): {shown: number; more: number} {
	const rows = brief.split('\n').filter(l => l.startsWith('Unmatched:'));
	const more = /^Unmatched: (\d+) more /.exec(rows.at(-1) ?? '');
	return {
		shown: rows.length - (more ? 1 : 0),
		more: more ? Number(more[1]) : 0,
	};
}

const sixDangling = () =>
	Array.from({length: 6}, (_, i) => ({id: `c-0000000${i}`, hash: H2}));

test('room the sections leave goes to more unmatched lines, up to 5', () => {
	const probe = input([line('c-00000001')]);
	probe.state.dangling = sixDangling();
	const brief = renderBrief(probe, {budget: MIN_BRIEF_BUDGET});
	expect(brief.length).toBeLessThanOrEqual(MIN_BRIEF_BUDGET * 4);
	expect(brief.split('\n').filter(l => l.startsWith('Unmatched:'))).toEqual([
		...Array.from(
			{length: 5},
			(_, i) =>
				`Unmatched: Resolves: c-0000000${i} in 7654321 matches no card line.`,
		),
		'Unmatched: 1 more Resolves: lines match no card line.',
	]);
});

test('a crowded brief prints fewer than 5 unmatched lines and counts the rest', () => {
	for (const budget of [MIN_BRIEF_BUDGET, 201]) {
		const crowd = crowded();
		crowd.state.dangling = sixDangling();
		const brief = renderBrief(crowd, {budget});
		const {shown, more} = unmatchedOf(brief);
		expect(shown, `${budget}`).toBeLessThan(5);
		expect(shown + more, `${budget}`).toBe(6);
		expect(brief.length).toBeLessThanOrEqual(budget * 4);
	}
});

test('the unmatched lines shown and the count of the rest always add up to every dangling resolve', () => {
	for (const budget of [
		MIN_BRIEF_BUDGET,
		201,
		300,
		500,
		DEFAULT_BRIEF_BUDGET,
	]) {
		for (const count of [1, 2, 5, 6, 9, 50]) {
			for (const lines of [[], [line('c-00000001')], many('constraint', 3)]) {
				const probe = input(lines);
				probe.state.dangling = Array.from({length: count}, (_, i) => ({
					id: `c-${String(i).padStart(8, '0')}`,
					hash: H2,
				}));
				const brief = renderBrief(probe, {budget});
				const {shown, more} = unmatchedOf(brief);
				const label = `${budget} ${count} ${lines.length}`;
				expect(brief.length, label).toBeLessThanOrEqual(budget * 4);
				expect(shown, label).toBeLessThanOrEqual(5);
				if (shown + more > 0) expect(shown + more, label).toBe(count);
			}
		}
	}
});

test('a dangling resolve is not reported with a section', () => {
	const state = input([line('c-00000001')]);
	state.state.dangling = [{id: 'c-deadbeef', hash: H2}];
	expect(renderBrief(state, {section: 'constraints'})).not.toContain(
		'Unmatched',
	);
});

test('a budget out of range is clamped, not refused', () => {
	const lines = crowd();
	expect(renderBrief(input(lines), {budget: 1}).length).toBeLessThanOrEqual(
		MIN_BRIEF_BUDGET * 4,
	);
	expect(
		renderBrief(input(lines), {budget: 10 ** 9}).length,
	).toBeLessThanOrEqual(MAX_BRIEF_BUDGET * 4);
	expect(renderBrief(input(lines), {budget: 10 ** 9})).toBe(
		renderBrief(input(lines), {budget: MAX_BRIEF_BUDGET}),
	);
});

test('a workstream with no latest description and a single commit read plainly', () => {
	expect(
		renderBrief(
			input([], {
				workstreams: [{slug: 'solo', title: 't', commits: 1}],
				recent: {tag: null, count: 1, subjects: []},
			}),
		),
	).toBe(
		[
			FIRST,
			'',
			'Workstreams',
			'  solo  active  1 commit',
			'',
			'Recent commits',
			'  1 commit.',
			'',
			LAST,
		].join('\n'),
	);
});

test('a date that does not parse counts as recent', () => {
	const brief = renderBrief(
		input([
			line('c-00000001', {
				state: 'resolved',
				resolvedBy: {hash: H2, date: 'sometime', reason: 'r'},
			}),
		]),
	);
	expect(brief).toContain('c-00000001');
});

test('at the smallest budget every non-empty section shows in full or as its one-line form', () => {
	const brief = renderBrief(crowded(), {budget: MIN_BRIEF_BUDGET});
	expect(brief.length).toBeLessThanOrEqual(800);
	const rows = brief.split('\n');
	for (const [title, name, count] of [
		['Constraints', 'constraints', 60],
		['Resolved recently', 'resolved', 60],
		['Gotchas', 'gotchas', 60],
		['Follow-ups', 'follow-ups', 60],
		['Off branch', 'off-branch', 60],
		['Workstreams', 'workstreams', 40],
		['Since v1', 'recent', 80],
	] as const) {
		const form = `${title}: ${count} not shown. The ${name} section lists them.`;
		expect(rows.includes(title) || rows.includes(form), title).toBe(true);
	}
});

test('a section with no room prints its one-line form exactly, and a tag shows in the recent one', () => {
	const flooded = crowded();
	flooded.state.dangling = Array.from({length: 5}, (_, i) => ({
		id: `c-${i}${'k'.repeat(300)}`,
		hash: H2,
	}));
	const brief = renderBrief(flooded, {budget: MIN_BRIEF_BUDGET});
	expect(brief.length).toBeLessThanOrEqual(800);
	expect(brief).toContain(
		'\n\nOff branch: 60 not shown. The off-branch section lists them.\n\n',
	);
	expect(brief).toContain(
		'\n\nSince v1: 80 not shown. The recent section lists them.\n\n',
	);
});

test('with a section, a full budget still prints it in full', () => {
	const brief = renderBrief(crowded(), {
		budget: MIN_BRIEF_BUDGET,
		section: 'off-branch',
	});
	expect(brief).toContain('Off branch\n  off branch ');
	expect(brief).not.toContain('not shown');
	expect(brief.length).toBeLessThanOrEqual(MIN_BRIEF_BUDGET * 4);
});

test('a section view of a later section keeps to the budget', () => {
	for (const section of ['gotchas', 'follow-ups', 'recent'] as const) {
		for (const budget of [MIN_BRIEF_BUDGET, DEFAULT_BRIEF_BUDGET]) {
			expect(
				renderBrief(crowded(), {budget, section}).length,
				`${section} ${budget}`,
			).toBeLessThanOrEqual(budget * 4);
		}
	}
});

/** `n` open lines of `kind`, each with a text `length` characters long. */
function many(kind: CardLine['kind'], n: number, length = 150): CardLine[] {
	return Array.from({length: n}, (_, i) =>
		line(`${kind[0]}-${String(i).padStart(8, '0')}`, {
			kind,
			text: `${kind} ${i} `.padEnd(length, 'x'),
		}),
	);
}

/** How many lines print under `title`, a section's full form. */
function shownUnder(brief: string, title: string): number {
	const rows = brief.split('\n');
	const at = rows.indexOf(title);
	if (at < 0) return 0;
	let shown = 0;
	for (let i = at + 1; i < rows.length && rows[i] !== ''; i++) {
		if (rows[i]!.startsWith('  open ')) shown++;
	}

	return shown;
}

/** Each of these lines is 186 characters and a newline. */
const LINE_ROOM = 187;

test('60 constraints alone fill the default budget', () => {
	const brief = renderBrief(input(many('constraint', 60)));
	const shown = shownUnder(brief, 'Constraints');
	expect(brief.length).toBeLessThanOrEqual(6000);
	expect(shown === 60 || 6000 - brief.length < 300, `${shown}`).toBe(true);
	expect(shown).toBe(30);
});

test('60 follow-ups alone fill the default budget', () => {
	const brief = renderBrief(input(many('followUp', 60)));
	const shown = shownUnder(brief, 'Follow-ups');
	expect(brief.length).toBeLessThanOrEqual(6000);
	expect(shown === 60 || 6000 - brief.length < 300, `${shown}`).toBe(true);
	expect(shown).toBe(30);
});

test('room left after the last section goes back to the first section that was cut', () => {
	const brief = renderBrief(
		input([...many('constraint', 60), ...many('followUp', 60)], {
			workstreams: [{slug: 'w', title: 't', commits: 1}],
		}),
	);
	// The first pass gives constraints their 40%, room for 12 lines, and
	// follow-ups their 10% with the 30% resolved and gotchas leave: 12 lines.
	// What off-branch, workstreams and recent leave goes to constraints, not
	// to follow-ups, until not one more constraint fits.
	expect(shownUnder(brief, 'Constraints')).toBe(18);
	expect(shownUnder(brief, 'Follow-ups')).toBe(12);
	expect(6000 - brief.length).toBeLessThan(LINE_ROOM);
});

test('at the smallest budget, constraints print lines before follow-ups do', () => {
	const brief = renderBrief(
		input([...many('constraint', 24, 300), ...many('followUp', 3, 20)]),
		{budget: MIN_BRIEF_BUDGET},
	);
	expect(brief.length).toBeLessThanOrEqual(800);
	expect(shownUnder(brief, 'Constraints')).toBeGreaterThanOrEqual(1);
	expect(brief).toContain(
		'\n  and 23 more: the constraints section lists them.\n',
	);
});

const SHALLOW =
	'This is a shallow clone, so notes from older commits are missing.';

test('a shallow brief says so on its second line, right under the first', () => {
	expect(renderBrief(input([line('c-00000001')], {shallow: true}))).toBe(
		[
			FIRST,
			SHALLOW,
			'',
			'Constraints',
			'  open       c-00000001  text of c-00000001  (1234567)',
			'',
			LAST,
		].join('\n'),
	);
	expect(
		renderBrief(input([line('c-00000001')], {shallow: true}), {
			section: 'constraints',
		}).split('\n')[1],
	).toBe(SHALLOW);
});

test('a shallow brief with nothing else to say is still empty', () => {
	expect(renderBrief(input([], {shallow: true}))).toBe('');
	expect(
		renderBrief(input([line('c-00000001')], {shallow: true}), {
			section: 'gotchas',
		}),
	).toBe('');
});

test('the shallow line counts toward the budget', () => {
	const lines = many('constraint', 60, 100);
	const full = renderBrief(input(lines));
	const shallow = renderBrief(input(lines, {shallow: true}));
	// Without it, 42 lines use 5,984 of 6,000 characters; the shallow line and
	// its newline take the room of the 42nd.
	expect(full.length).toBe(5984);
	expect(shownUnder(full, 'Constraints')).toBe(42);
	expect(shownUnder(shallow, 'Constraints')).toBe(41);
	expect(shallow.length).toBeLessThanOrEqual(6000);
	for (const budget of [MIN_BRIEF_BUDGET, 201, 500, DEFAULT_BRIEF_BUDGET]) {
		const crowd = {...crowded(), shallow: true};
		crowd.state.dangling = Array.from({length: 50}, (_, i) => ({
			id: `c-${i}`.padEnd(300, 'k'),
			hash: H2,
		}));
		const brief = renderBrief(crowd, {budget});
		expect(brief.length, `${budget}`).toBeLessThanOrEqual(budget * 4);
		expect(brief.split('\n')[1]).toBe(SHALLOW);
	}
});

test('controls are stripped before whitespace is collapsed, so a text never holds a double space', () => {
	const text = 'x \u0001 (replaces c-12345678) \u0001 (abc1234)';
	const brief = renderBrief(input([line('c-00000001', {text})]));
	expect(brief.split('\n')[3]).toBe(
		'  open       c-00000001  x (replaces c-12345678) (abc1234)  (1234567)',
	);
	// A line break or tab between words is still a single space.
	const broken = renderBrief(
		input([line('c-00000001', {text: 'a\n\u0001\nb\t\u001B\tc d'})]),
	);
	expect(broken.split('\n')[3]).toBe(
		'  open       c-00000001  a b c d  (1234567)',
	);
});

test('the count line of a cut section points to its section, or in a section view to a larger budget', () => {
	const gotchas = many('gotcha', 20);
	const all = renderBrief(input(gotchas), {budget: 300});
	expect(shownUnder(all, 'Gotchas')).toBe(5);
	expect(all.split('\n').at(-3)).toBe(
		'  and 15 more: the gotchas section lists them.',
	);

	const alone = renderBrief(input(gotchas), {budget: 300, section: 'gotchas'});
	expect(shownUnder(alone, 'Gotchas')).toBe(5);
	expect(alone.split('\n').at(-3)).toBe(
		'  and 15 more: ask for a larger budget to list them.',
	);
	expect(alone).not.toContain('section lists them');
});

test('with no tag, a recent section with no room prints its one-line form exactly', () => {
	const short = {text: 'aaaaa'};
	const brief = renderBrief(
		input(
			[
				line('c-00000001', short),
				line('c-00000002', {
					...short,
					state: 'resolved',
					resolvedBy: {hash: H2, date: '2026-11-12T00:00:00Z', reason: 'r'},
				}),
				line('c-00000003', {...short, kind: 'gotcha'}),
				line('c-00000004', {...short, kind: 'followUp'}),
				line('c-00000005', {
					...short,
					state: 'off-branch',
					workstream: {slug: 'w', status: 'shipped'},
				}),
			],
			{
				// Workstreams come first and take the room recent would need.
				workstreams: Array.from({length: 200}, (_, i) => ({
					slug: `w${i}`,
					title: 't',
					commits: 1,
				})),
				recent: {
					tag: null,
					count: 300,
					subjects: Array.from({length: 300}, () => 'sssss'),
				},
			},
		),
		{budget: MIN_BRIEF_BUDGET},
	);
	expect(brief).toBe(
		[
			FIRST,
			'',
			'Constraints',
			'  open       c-00000001  aaaaa  (1234567)',
			'',
			'Resolved recently',
			'  resolved   c-00000002  aaaaa',
			`${INDENT}Resolved by 7654321 on 2026-11-12: r`,
			'',
			'Gotchas',
			'  open       c-00000003  aaaaa  (1234567)',
			'',
			'Follow-ups',
			'  open       c-00000004  aaaaa  (1234567)',
			'',
			'Off branch',
			'  off branch c-00000005  aaaaa  (workstream w)',
			'',
			'Workstreams',
			...Array.from({length: 7}, (_, i) => `  w${i}  active  1 commit`),
			'  and 193 more: the workstreams section lists them.',
			'',
			'Recent commits: 300 not shown. The recent section lists them.',
			'',
			LAST,
		].join('\n'),
	);
	expect(brief.length).toBeLessThanOrEqual(800);
});
