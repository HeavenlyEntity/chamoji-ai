import {expect, test} from 'vitest';
import type {IntentCard, WhyReason} from '../src/index.js';
import {CAUSAL_MARKERS, WHY_ADVICE, judgeWhy} from '../src/why-quality.js';
import labels from './fixtures/why-labels.json' with {type: 'json'};

type Row = {
	subject: string;
	card: IntentCard;
	label: 'good' | 'vague';
	reason?: WhyReason;
};

const rows = labels as Row[];
const good = rows.filter(row => row.label === 'good');
const vague = rows.filter(row => row.label === 'vague');

const card = (why: string[], rest: Partial<IntentCard> = {}): IntentCard => ({
	why,
	constraint: [],
	gotcha: [],
	followUp: [],
	...rest,
});

test.each(good)('keeps a good Why: $card.why', ({card: c, subject}) => {
	expect(judgeWhy(c, subject).level).toBe('ok');
});

test('catches at least 80% of the vague fixture', () => {
	const caught = vague.filter(
		row => judgeWhy(row.card, row.subject).level === 'thin',
	);
	expect(caught.length / vague.length).toBeGreaterThanOrEqual(0.8);
});

test('the fixture covers each local reason at least 8 times', () => {
	for (const reason of [
		'filler',
		'too-short',
		'repeats-subject',
		'what-not-why',
	]) {
		expect(
			vague.filter(row => row.reason === reason).length,
		).toBeGreaterThanOrEqual(8);
	}
});

test('filler', () => {
	expect(judgeWhy(card(['fix bug']), '🐛 Fix login')).toEqual({
		level: 'thin',
		reasons: ['filler', 'too-short'],
		advice: WHY_ADVICE.filler,
	});
});

test('as discussed is filler', () => {
	expect(judgeWhy(card(['as discussed']), 'Tweak copy').reasons[0]).toBe(
		'filler',
	);
});

test('too short', () => {
	expect(judgeWhy(card(['Safari is slow']), 'Cache the list').reasons).toEqual([
		'too-short',
	]);
});

test('repeats the subject', () => {
	expect(
		judgeWhy(
			card(['to add retry to the upload, retry upload']),
			'Add retry to upload',
		).reasons,
	).toContain('repeats-subject');
});

test('what, not why', () => {
	expect(
		judgeWhy(
			card(['Add a cache layer to the device list endpoint']),
			'Cache devices',
		).reasons,
	).toEqual(['what-not-why']);
});

test('a causal marker saves it', () => {
	expect(
		judgeWhy(
			card(['Add a cache because the device list takes 4 s']),
			'Cache devices',
		).level,
	).toBe('ok');
});

test('a constraint saves a thin Why', () => {
	expect(
		judgeWhy(
			card(['fix bug'], {
				constraint: ['the provider caps stays at 365 nights'],
			}),
			'Cap stays',
		).level,
	).toBe('ok');
});

test('a card with only a Gotcha is ok', () => {
	expect(
		judgeWhy(card([], {gotcha: ['nights, not days']}), 'Cap stays').level,
	).toBe('ok');
});

test('another language', () => {
	expect(
		judgeWhy(
			card(['el proveedor devuelve 422 para estancias de más de 365 noches']),
			'Limitar estancias',
		).level,
	).toBe('ok');
});

test('a long German Why is ok', () => {
	expect(
		judgeWhy(
			card([
				'Der Anbieter lehnt Aufenthalte über 365 Nächte mit einem Fehler ab',
			]),
			'Aufenthalte begrenzen',
		).level,
	).toBe('ok');
});

test('several Why lines are judged together', () => {
	expect(
		judgeWhy(
			card(['the provider returns 422', 'for stays over 365 nights']),
			'Cap stays',
		).level,
	).toBe('ok');
});

test('filler is matched as whole words only', () => {
	expect(
		judgeWhy(
			card(['prefixes were silently dropped by the parser']),
			'Keep prefixes',
		).level,
	).toBe('ok');
});

test('the causal markers are exported', () => {
	expect(CAUSAL_MARKERS.has('because')).toBe(true);
});
