import {expect, test} from 'vitest';
import {stripControl, stripControlLines} from '../src/text.js';

// Built from code points, so that no invisible character sits in this source.
const char = (code: number) => String.fromCharCode(code);
const range = (from: number, to: number) =>
	Array.from({length: to - from + 1}, (_, index) => char(from + index));

test('stripControl removes C0 and C1 control characters', () => {
	expect(stripControl('a\u001B[31mb\u0007c\u0085d\u009Be\u007Ff')).toBe(
		'a[31mbcdef',
	);
});

test('stripControl removes bidirectional overrides, isolates and line separators', () => {
	// Each of these is hidden when printed, and most reorder what follows.
	const hidden = [
		...range(0x20_2a, 0x20_2e),
		...range(0x20_66, 0x20_69),
		char(0x20_28),
		char(0x20_29),
	];
	expect(hidden).toHaveLength(11);
	for (const character of hidden) {
		expect(stripControl(`ab${character}cd`)).toBe('abcd');
	}

	expect(stripControl(`evil${char(0x20_2e)}gnp.exe`)).toBe('evilgnp.exe');
});

test('stripControl keeps ordinary text, emoji and the characters beside the range', () => {
	const text = `🔐 Auth revamp, 認証 – ok ${char(0x20_0d)}${char(0x20_0e)}${char(0x20_2f)}${char(0x20_65)}${char(0x20_6a)}`;
	expect(stripControl(text)).toBe(text);
});

test('stripControl drops newlines, and stripControlLines keeps the lines apart', () => {
	expect(stripControl('a\nb')).toBe('ab');
	expect(stripControlLines(`a${char(0x20_2e)}\nb${char(0x20_28)}`)).toBe(
		'a\nb',
	);
});
