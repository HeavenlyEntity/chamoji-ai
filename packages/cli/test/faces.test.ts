import stringWidth from 'string-width';
import {expect, test} from 'vitest';
import {
	ASCII_FACES,
	FACES,
	IDLE_LOOP,
	type FaceName,
	useAscii,
} from '../src/faces.js';

const names: FaceName[] = [
	'rest',
	'left',
	'right',
	'blink',
	'wink',
	'done',
	'warn',
	'fail',
];

test('the faces match the spec exactly', () => {
	expect(FACES).toEqual({
		rest: '( •‿• )',
		left: '(•‿•  )',
		right: '(  •‿•)',
		blink: '( -‿- )',
		wink: '( •‿- )',
		done: '( ■‿■ )',
		warn: '( •_• )',
		fail: '( ;_; )',
	});
	expect(ASCII_FACES).toEqual({
		rest: '( o_o )',
		left: '(o_o  )',
		right: '(  o_o)',
		blink: '( -_- )',
		wink: '( o_- )',
		done: '( ^_^ )',
		warn: '( o_O )',
		fail: '( ;_; )',
	});
});

test('every face is 7 columns in both sets', () => {
	for (const set of [FACES, ASCII_FACES]) {
		for (const name of names) {
			expect(stringWidth(set[name]), `${name}: ${set[name]}`).toBe(7);
		}
	}
});

test('the idle loop only names faces that exist', () => {
	expect(IDLE_LOOP).toEqual([
		'rest',
		'rest',
		'left',
		'rest',
		'right',
		'rest',
		'blink',
		'rest',
		'wink',
	]);
	for (const name of IDLE_LOOP) {
		expect(FACES).toHaveProperty(name);
		expect(ASCII_FACES).toHaveProperty(name);
	}
});

test('useAscii is true for CHAMOJI_ASCII=1 on any platform', () => {
	expect(useAscii({CHAMOJI_ASCII: '1'}, 'darwin')).toBe(true);
	expect(useAscii({CHAMOJI_ASCII: '1'}, 'linux')).toBe(true);
	expect(useAscii({CHAMOJI_ASCII: '1', WT_SESSION: 'x'}, 'win32')).toBe(true);
});

test('useAscii is true for win32 with no WT_SESSION', () => {
	expect(useAscii({}, 'win32')).toBe(true);
});

test('useAscii is false for win32 inside Windows Terminal', () => {
	expect(useAscii({WT_SESSION: 'abc'}, 'win32')).toBe(false);
});

test('useAscii is false on darwin', () => {
	expect(useAscii({}, 'darwin')).toBe(false);
});
