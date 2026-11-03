import {expect, test} from 'vitest';
import {
	LOGO_FRAMES,
	LOGO_HEIGHT,
	LOGO_WIDTH,
	O_COLUMNS,
	type LogoFace,
} from '../src/logo-frames.js';

const faces = Object.keys(LOGO_FRAMES) as LogoFace[];
const allowed = new Set([...' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█']);

test('every frame is 8 rows of 68 columns', () => {
	expect(faces).toHaveLength(9);
	for (const face of faces) {
		const frame = LOGO_FRAMES[face];
		expect(frame, face).toHaveLength(LOGO_HEIGHT);
		for (const row of frame) {
			expect([...row], face).toHaveLength(LOGO_WIDTH);
		}
	}
});

test('frames use only quadrant characters and spaces', () => {
	for (const face of faces) {
		for (const char of LOGO_FRAMES[face].join('')) {
			expect(allowed.has(char), `${face}: ${char}`).toBe(true);
		}
	}
});

test('frames differ only inside the O', () => {
	const [start, end] = O_COLUMNS;
	const outside = (row: string) =>
		[...row].slice(0, start).join('') + [...row].slice(end).join('');
	for (const face of faces) {
		expect(
			LOGO_FRAMES[face].map(row => outside(row)),
			face,
		).toEqual(LOGO_FRAMES.rest.map(row => outside(row)));
	}
});

test('the shades frame has solid lenses', () => {
	const [start, end] = O_COLUMNS;
	const row = [...LOGO_FRAMES.shades[3]!].slice(start, end).join('');
	expect(row).toContain('███ ███');
});
