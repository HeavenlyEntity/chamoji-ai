import {expect, test} from 'vitest';
import {
	estimateTokens,
	pickSample,
	ratio,
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
