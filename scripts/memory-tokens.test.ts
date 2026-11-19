import {readFileSync} from 'node:fs';
import {expect, test} from 'vitest';
import {
	estimateTokens,
	pickSample,
	ratio,
	renderTables,
	replaceSection,
	sectionBody,
	summarize,
	typicalSwitch,
	windowShares,
	WINDOWS,
} from './lib/memory-tokens.mjs';

test('estimateTokens rounds up at 4 characters a token', () => {
	expect(estimateTokens('')).toBe(0);
	expect(estimateTokens('abcd')).toBe(1);
	expect(estimateTokens('abcde')).toBe(2);
});

test('typicalSwitch is one what-stands plus five whys at the mean', () => {
	expect(typicalSwitch({whatStands: 1500, whyMean: 140.4})).toBe(2202);
});

test('windowShares gives the share and how many switches fit', () => {
	expect(windowShares({withTokens: 2500, withoutTokens: 50_000})[0]).toEqual({
		window: 250_000,
		withShare: 0.01,
		withoutShare: 0.2,
		withFits: 100,
		withoutFits: 5,
	});
});

test('windowShares covers all three windows by default', () => {
	expect(
		windowShares({withTokens: 1, withoutTokens: 1}).map(row => row.window),
	).toEqual(WINDOWS);
});

test('windowShares and ratio give null, not Infinity, at zero tokens', () => {
	expect(
		windowShares({withTokens: 0, withoutTokens: 10})[0].withFits,
	).toBeNull();
	expect(ratio(0, 10)).toBeNull();
});

test('windowShares gives null fits for a side with zero tokens', () => {
	expect(
		windowShares({withTokens: 10, withoutTokens: 0})[0].withoutFits,
	).toBeNull();
});

test('ratio is without over with, to one decimal', () => {
	expect(ratio(3, 10)).toBe(3.3);
});

test('summarize of an empty list is all zeros', () => {
	expect(summarize([])).toEqual({mean: 0, median: 0, min: 0, max: 0});
});

test('summarize of an odd count takes the middle value', () => {
	expect(summarize([9, 1, 5])).toEqual({mean: 5, median: 5, min: 1, max: 9});
});

test('summarize of an even count averages the two middle values', () => {
	expect(summarize([4, 1, 2, 10])).toEqual({
		mean: 4.25,
		median: 3,
		min: 1,
		max: 10,
	});
});

test('pickSample is the first n by commit hash, whatever order they arrive in', () => {
	const c = [{commit: 'c'}, {commit: 'a'}, {commit: 'b'}];
	expect(pickSample(c, 2)).toEqual([{commit: 'a'}, {commit: 'b'}]);
	expect(pickSample([...c].reverse(), 2)).toEqual([
		{commit: 'a'},
		{commit: 'b'},
	]);
});

test('pickSample does not reorder its input', () => {
	const c = [{commit: 'b'}, {commit: 'a'}];
	pickSample(c, 1);
	expect(c).toEqual([{commit: 'b'}, {commit: 'a'}]);
});

const resultsUrl = new URL(
	'../docs/benchmarks/memory-tokens.json',
	import.meta.url,
);
const pageUrl = new URL(
	'../docs/site/guides/memory-tokens.mdx',
	import.meta.url,
);
const results = () => JSON.parse(readFileSync(resultsUrl, 'utf8'));

test('renderTables shows the three windows as 250k, 500k and 1M with both shares as percentages', () => {
	const base = results();
	const text = renderTables({
		...base,
		windows: [
			{
				window: 250_000,
				withShare: 0.0073,
				withoutShare: 0.3042,
				withFits: 136,
				withoutFits: 3,
			},
			{
				window: 500_000,
				withShare: 0.0037,
				withoutShare: 0.1521,
				withFits: 272,
				withoutFits: 6,
			},
			{
				window: 1_000_000,
				withShare: 0.0018,
				withoutShare: 0.076,
				withFits: 544,
				withoutFits: 13,
			},
		],
	});

	expect(text).toMatch(/\|\s*250k\s*\|\s*0\.73%\s*\|\s*30\.4%\s*\|/);
	expect(text).toMatch(/\|\s*500k\s*\|\s*0\.37%\s*\|\s*15\.2%\s*\|/);
	expect(text).toMatch(/\|\s*1M\s*\|\s*0\.18%\s*\|\s*7\.6%\s*\|/);
});

test('renderTables writes "not measured" for a null ratio and never prints NaN, Infinity or null', () => {
	const base = results();
	const text = renderTables({
		...base,
		typicalSwitch: {...base.typicalSwitch, ratio: null},
		windows: base.windows.map((w: object) => ({
			...w,
			withFits: null,
			withoutFits: null,
		})),
	});

	expect(text).toContain('not measured');
	expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
	expect(renderTables(base)).not.toMatch(/NaN|Infinity|null|undefined/);
});

test('renderTables formats tokens with separators, ratios with a times sign and the date as UTC', () => {
	const text = renderTables(results());

	expect(text).toMatch(/\d{1,3},\d{3}/);
	expect(text).toMatch(/\d+\.\d×/);
	expect(text).toMatch(/\d{4}-\d{2}-\d{2} UTC/);
});

test('renderTables rounds half up to whole tokens', () => {
	const base = results();
	const text = renderTables({
		...base,
		why: {...base.why, card: {mean: 67.5, median: 62.5, min: 44, max: 143}},
	});

	expect(text).toMatch(/\|\s+68 \|\s+63 \|\s+44 \|\s+143 \|/);
});

test('the page between its two markers equals renderTables of docs/benchmarks/memory-tokens.json', () => {
	const page = readFileSync(pageUrl, 'utf8');

	expect(sectionBody(page, '## The numbers')).toBe(
		renderTables(results()).trim(),
	);
});

test('every whole number of four digits or more in the generated part appears in the results file', () => {
	const known = new Set<number>();
	const collect = (value: unknown) => {
		if (typeof value === 'number') {
			known.add(value);
			known.add(Math.round(value));
		} else if (value && typeof value === 'object') {
			Object.values(value).forEach(collect);
		}
	};
	collect(results());
	const text = renderTables(results());
	const found = [
		...text.matchAll(
			/(?<![\w.,-])(?:\d{1,3}(?:,\d{3})+(?![\w.-]|,\d)|\d{4,}(?![\w.-]))/g,
		),
	].map(([match]) => Number(match.replaceAll(',', '')));

	expect(found.length).toBeGreaterThan(10);
	for (const number of found) expect(known.has(number)).toBe(true);
});

test('the page holds the live section with the not-run sentence, and replaceSection leaves other sections alone', () => {
	const page = readFileSync(pageUrl, 'utf8');
	const live = sectionBody(page, '## A sample of real runs');

	expect(live).toContain('The live sample has not been run yet.');
	const swapped = replaceSection(page, '## The numbers', 'Changed.');
	expect(sectionBody(swapped ?? '', '## The numbers')).toBe('Changed.');
	expect(sectionBody(swapped ?? '', '## A sample of real runs')).toBe(live);
	expect(replaceSection(page, '## No such heading', 'x')).toBeNull();
});
