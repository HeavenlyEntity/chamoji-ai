import {EventEmitter} from 'node:events';
import {afterEach, expect, test, vi} from 'vitest';
import {
	detectTheme,
	FOIL_STOPS,
	foilAt,
	isLight,
	paintFoil,
	parseOscBackground,
	queryBackground,
	themeFromEnv,
} from '../src/foil.js';

const ESC = '\u001B';
const BEL = '\u0007';
const white = {r: 255, g: 255, b: 255};

afterEach(() => {
	vi.useRealTimers();
});

test('foilAt hits each stop exactly', () => {
	expect(FOIL_STOPS).toHaveLength(7);
	for (let index = 0; index < 7; index++) {
		expect(foilAt(index / 7)).toEqual(FOIL_STOPS[index]);
	}
});

test('foilAt eases between stops', () => {
	const [first, second] = FOIL_STOPS;
	expect(foilAt(0.5 / 7)).toEqual({
		r: Math.round((first!.r + second!.r) / 2),
		g: Math.round((first!.g + second!.g) / 2),
		b: Math.round((first!.b + second!.b) / 2),
	});
	// An ease, not a line: a quarter of the way in is 14.6% blended.
	const eased = (1 - Math.cos(Math.PI / 4)) / 2;
	expect(foilAt(0.25 / 7)).toEqual({
		r: Math.round(first!.r + (second!.r - first!.r) * eased),
		g: Math.round(first!.g + (second!.g - first!.g) * eased),
		b: Math.round(first!.b + (second!.b - first!.b) * eased),
	});
});

test('foilAt wraps', () => {
	expect(foilAt(1.25)).toEqual(foilAt(0.25));
	expect(foilAt(-0.75)).toEqual(foilAt(0.25));
});

test('paintFoil at level 0 returns the text unchanged', () => {
	expect(paintFoil('chamoji', {offset: 0, spread: 7, level: 0})).toBe(
		'chamoji',
	);
});

test('paintFoil colours each character through chalk at the level', () => {
	const painted = paintFoil('ab', {offset: 0, spread: 7, level: 3});
	const second = foilAt(1 / 7);
	expect(painted).toBe(
		`${ESC}[38;2;213;225;203ma${ESC}[39m${ESC}[38;2;${second.r};${second.g};${second.b}mb${ESC}[39m`,
	);
});

test('paintFoil leaves spaces uncoloured', () => {
	const painted = paintFoil('a b', {offset: 0, spread: 7, level: 3});
	const third = foilAt(2 / 7);
	// The space keeps its place in the count, and takes no colour of its own.
	expect(painted).toBe(
		`${ESC}[38;2;213;225;203ma${ESC}[39m ${ESC}[38;2;${third.r};${third.g};${third.b}mb${ESC}[39m`,
	);
});

test('themeFromEnv reads CHAMOJI_THEME first', () => {
	expect(themeFromEnv({CHAMOJI_THEME: 'light'})).toBe('light');
	expect(themeFromEnv({CHAMOJI_THEME: 'dark'})).toBe('dark');
	expect(themeFromEnv({CHAMOJI_THEME: 'light', COLORFGBG: '15;0'})).toBe(
		'light',
	);
});

test('themeFromEnv reads the background from COLORFGBG', () => {
	expect(themeFromEnv({COLORFGBG: '0;15'})).toBe('light');
	expect(themeFromEnv({COLORFGBG: '0;7'})).toBe('light');
	expect(themeFromEnv({COLORFGBG: '15;0'})).toBe('dark');
	expect(themeFromEnv({COLORFGBG: '15;default;0'})).toBe('dark');
	expect(themeFromEnv({COLORFGBG: 'default;default'})).toBeUndefined();
	expect(themeFromEnv({})).toBeUndefined();
});

test('parseOscBackground reads the BEL and ST forms', () => {
	expect(parseOscBackground(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`)).toEqual(
		white,
	);
	expect(parseOscBackground(`${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`)).toEqual(
		white,
	);
});

test('parseOscBackground reads channels of 1 to 4 digits', () => {
	expect(parseOscBackground(`${ESC}]11;rgb:ff/00/80${BEL}`)).toEqual({
		r: 255,
		g: 0,
		b: 128,
	});
	expect(parseOscBackground(`${ESC}]11;rgb:f/0/f${BEL}`)).toEqual({
		r: 255,
		g: 0,
		b: 255,
	});
	expect(parseOscBackground(`${ESC}]11;rgb:0b0b/0b0b/0f0f${BEL}`)).toEqual({
		r: 11,
		g: 11,
		b: 15,
	});
});

test('parseOscBackground returns undefined for junk', () => {
	expect(parseOscBackground('')).toBeUndefined();
	expect(parseOscBackground('hello')).toBeUndefined();
	expect(parseOscBackground(`${ESC}]11;rgb:zz/00/00${BEL}`)).toBeUndefined();
	expect(parseOscBackground(`${ESC}]11;rgb:ffff/ffff${BEL}`)).toBeUndefined();
});

test('isLight uses relative luminance', () => {
	expect(isLight(white)).toBe(true);
	expect(isLight({r: 0x0b, g: 0x0b, b: 0x0f})).toBe(false);
});

test('detectTheme falls back to dark', async () => {
	const query = vi.fn(async () => undefined);
	expect(await detectTheme({}, query)).toBe('dark');
	expect(query).toHaveBeenCalledOnce();
});

test('detectTheme follows the terminal reply', async () => {
	expect(await detectTheme({}, async () => white)).toBe('light');
	expect(await detectTheme({}, async () => ({r: 0, g: 0, b: 0}))).toBe('dark');
});

test('detectTheme lets CHAMOJI_THEME beat the query', async () => {
	const query = vi.fn(async () => white);
	expect(await detectTheme({CHAMOJI_THEME: 'dark'}, query)).toBe('dark');
	expect(query).not.toHaveBeenCalled();
});

test('detectTheme asks the terminal before it reads COLORFGBG', async () => {
	expect(await detectTheme({COLORFGBG: '15;0'}, async () => white)).toBe(
		'light',
	);
	expect(await detectTheme({COLORFGBG: '0;15'}, async () => undefined)).toBe(
		'light',
	);
});

class FakeStdin extends EventEmitter {
	isRaw = false;
	readonly setRawMode = vi.fn((mode: boolean) => {
		this.isRaw = mode;
		return this;
	});

	readonly pause = vi.fn(() => this);
	readonly resume = vi.fn(() => this);
	setEncoding = vi.fn(() => this);
}

function fakeStreams() {
	const stdin = new FakeStdin();
	const write = vi.fn(() => true);
	const stderr = {write} as unknown as NodeJS.WriteStream;
	return {
		stdin,
		write,
		stderr,
		input: stdin as unknown as NodeJS.ReadStream,
	};
}

test('queryBackground gives up after the timeout and restores raw mode', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr, write} = fakeStreams();
	const pending = queryBackground(input, stderr);
	expect(write).toHaveBeenCalledWith(`${ESC}]11;?${ESC}\\`);
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
	expect(stdin.listenerCount('data')).toBe(1);

	await vi.advanceTimersByTimeAsync(99);
	expect(stdin.setRawMode).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);

	expect(await pending).toBeUndefined();
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
	expect(stdin.isRaw).toBe(false);
	expect(stdin.pause).toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
});

test('queryBackground resolves the colour and removes its listener', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const pending = queryBackground(input, stderr);
	stdin.emit('data', Buffer.from(`${ESC}]11;rgb:ffff/ffff/`));
	stdin.emit('data', Buffer.from(`ffff${ESC}\\`));

	expect(await pending).toEqual(white);
	expect(stdin.listenerCount('data')).toBe(0);
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
	expect(stdin.pause).toHaveBeenCalled();
	// The timer is cleared, so nothing is left to fire.
	expect(vi.getTimerCount()).toBe(0);
});

test('queryBackground puts raw mode back as it found it', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	stdin.isRaw = true;
	const pending = queryBackground(input, stderr, 50);
	await vi.advanceTimersByTimeAsync(50);
	await pending;
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
});
