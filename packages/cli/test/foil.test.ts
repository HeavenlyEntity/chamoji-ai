import {EventEmitter} from 'node:events';
import {afterEach, expect, test, vi} from 'vitest';
import {
	detectTheme,
	FOIL_STOPS,
	foilAt,
	inForeground,
	isLight,
	paintFoil,
	parseOscBackground,
	queryBackground,
	themeFromEnv,
	type Rgb,
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

/**
 * Starts a query in the foreground and waits for it to reach the terminal,
 * since the foreground check is async. Returns the pending answer, boxed so
 * awaiting this does not wait for the answer itself.
 */
async function ask(
	input: NodeJS.ReadStream,
	stderr: NodeJS.WriteStream,
	timeoutMs?: number,
	interrupt: () => void = () => {},
): Promise<{pending: Promise<Rgb | undefined>}> {
	const pending = queryBackground(input, stderr, timeoutMs, interrupt, {
		isForeground: async () => true,
	});
	await vi.advanceTimersByTimeAsync(0);
	return {pending};
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

test('queryBackground answers undefined at the limit, then restores after the grace window', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr, write} = fakeStreams();
	let result: unknown = 'pending';
	const pending = (await ask(input, stderr)).pending.then(color => {
		result = color;
		return color;
	});
	expect(write).toHaveBeenCalledWith(`${ESC}]11;?${ESC}\\`);
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
	expect(stdin.listenerCount('data')).toBe(1);

	await vi.advanceTimersByTimeAsync(99);
	expect(result).toBe('pending');
	await vi.advanceTimersByTimeAsync(1);
	expect(result).toBeUndefined();
	expect(await pending).toBeUndefined();

	// Resolved, but still raw and listening, so a late reply cannot echo.
	expect(stdin.isRaw).toBe(true);
	expect(stdin.listenerCount('data')).toBe(1);
	expect(stdin.pause).not.toHaveBeenCalled();

	await vi.advanceTimersByTimeAsync(199);
	expect(stdin.isRaw).toBe(true);
	await vi.advanceTimersByTimeAsync(1);
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
	expect(stdin.isRaw).toBe(false);
	expect(stdin.pause).toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
	expect(vi.getTimerCount()).toBe(0);
});

test('queryBackground swallows a reply that arrives after the limit', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const {pending} = await ask(input, stderr);
	await vi.advanceTimersByTimeAsync(100);
	expect(await pending).toBeUndefined();

	await vi.advanceTimersByTimeAsync(50);
	expect(stdin.isRaw).toBe(true);
	stdin.emit('data', Buffer.from(`${ESC}]11;rgb:ffff/ffff/`));
	expect(stdin.isRaw).toBe(true);
	expect(stdin.listenerCount('data')).toBe(1);
	stdin.emit('data', Buffer.from(`ffff${ESC}\\`));

	expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
	expect(stdin.isRaw).toBe(false);
	expect(stdin.pause).toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
	expect(vi.getTimerCount()).toBe(0);
});

test('queryBackground is not ended by a stray BEL before the reply', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const {pending} = await ask(input, stderr);
	stdin.emit('data', Buffer.from(BEL));
	expect(stdin.listenerCount('data')).toBe(1);
	expect(stdin.isRaw).toBe(true);
	stdin.emit('data', Buffer.from(`${ESC}\\`));
	expect(stdin.listenerCount('data')).toBe(1);

	stdin.emit('data', Buffer.from(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`));
	expect(await pending).toEqual(white);
	expect(stdin.listenerCount('data')).toBe(0);
	expect(stdin.isRaw).toBe(false);
});

test('queryBackground resolves the colour and removes its listener', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const {pending} = await ask(input, stderr);
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
	const {pending} = await ask(input, stderr, 50);
	await vi.advanceTimersByTimeAsync(50);
	await pending;
	await vi.advanceTimersByTimeAsync(200);
	// Raw was on before, so it is set to true again, not false.
	expect(stdin.setRawMode).toHaveBeenCalledTimes(2);
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
	expect(stdin.pause).toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
});

test('Ctrl-C during the query restores stdin and raises SIGINT', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const interrupt = vi.fn();
	const {pending} = await ask(input, stderr, 100, interrupt);
	stdin.emit('data', Buffer.from('\u0003'));
	expect(interrupt).toHaveBeenCalledTimes(1);
	expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
	expect(stdin.isRaw).toBe(false);
	expect(stdin.pause).toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
	expect(await pending).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});

test('Ctrl-C in the grace window restores stdin and raises SIGINT', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const interrupt = vi.fn();
	const {pending} = await ask(input, stderr, 100, interrupt);
	await vi.advanceTimersByTimeAsync(100);
	expect(await pending).toBeUndefined();
	await vi.advanceTimersByTimeAsync(50);
	expect(interrupt).not.toHaveBeenCalled();
	stdin.emit('data', Buffer.from('x\u0003'));
	expect(interrupt).toHaveBeenCalledTimes(1);
	expect(stdin.isRaw).toBe(false);
	expect(stdin.listenerCount('data')).toBe(0);
	expect(vi.getTimerCount()).toBe(0);
});

test('queryBackground never asks from a background job', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr, write} = fakeStreams();
	const pending = queryBackground(input, stderr, 100, () => {}, {
		isForeground: async () => false,
	});
	expect(await pending).toBeUndefined();
	expect(stdin.setRawMode).not.toHaveBeenCalled();
	expect(stdin.resume).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	// So the theme falls back to COLORFGBG, then dark.
	expect(
		await detectTheme({COLORFGBG: '0;15'}, async () =>
			queryBackground(input, stderr, 100, () => {}, {
				isForeground: async () => false,
			}),
		),
	).toBe('light');
});

test('queryBackground answers undefined when the foreground check fails', async () => {
	const {stdin, input, stderr} = fakeStreams();
	const pending = queryBackground(input, stderr, 100, () => {}, {
		async isForeground() {
			throw new Error('no ps');
		},
	});
	expect(await pending).toBeUndefined();
	expect(stdin.setRawMode).not.toHaveBeenCalled();
});

test('queryBackground answers undefined when raw mode throws', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr, write} = fakeStreams();
	stdin.setRawMode.mockImplementation(() => {
		throw new Error('EIO');
	});
	const {pending} = await ask(input, stderr);
	expect(await pending).toBeUndefined();
	expect(stdin.resume).not.toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
	expect(write).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

test('aborting in the grace window gives stdin back at once', async () => {
	vi.useFakeTimers();
	const {stdin, input, stderr} = fakeStreams();
	const controller = new AbortController();
	const pending = queryBackground(input, stderr, 100, () => {}, {
		isForeground: async () => true,
		signal: controller.signal,
	});
	await vi.advanceTimersByTimeAsync(150);
	expect(await pending).toBeUndefined();
	expect(stdin.isRaw).toBe(true);
	controller.abort();
	expect(stdin.isRaw).toBe(false);
	expect(stdin.pause).toHaveBeenCalled();
	expect(stdin.listenerCount('data')).toBe(0);
	expect(vi.getTimerCount()).toBe(0);
});

test('aborting before the question is sent asks nothing', async () => {
	const {stdin, input, stderr, write} = fakeStreams();
	const controller = new AbortController();
	controller.abort();
	expect(
		await queryBackground(input, stderr, 100, () => {}, {
			isForeground: async () => true,
			signal: controller.signal,
		}),
	).toBeUndefined();
	expect(stdin.setRawMode).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
});

test('inForeground is true on Windows and false for a process ps cannot find', async () => {
	expect(await inForeground(1, 'win32')).toBe(true);
	// No pid this large exists, so ps fails.
	expect(await inForeground(2 ** 30, 'darwin')).toBe(false);
});
