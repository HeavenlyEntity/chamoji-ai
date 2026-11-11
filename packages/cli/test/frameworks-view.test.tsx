import type {DetectedFramework} from '@chamoji/core';
import chalk from 'chalk';
import {render} from 'ink-testing-library';
import {afterEach, expect, test} from 'vitest';
import {
	FrameworkSummary,
	frameworksOf,
	frameworkText,
	iconColor,
	MIN_ICON_WIDTH,
} from '../src/setup/frameworks-view.js';

const next: DetectedFramework = {
	id: 'next',
	name: 'Next.js',
	version: '15.2',
	basedOn: ['react'],
};
const expo: DetectedFramework = {
	id: 'expo',
	name: 'Expo',
	version: '52',
	basedOn: ['react-native'],
};
const both = [
	{framework: next, units: ['web']},
	{framework: expo, units: ['mobile']},
];
const BLOCKS = /[▀-▟]/u;
const ESC = '\u001B';

const saved = chalk.level;
afterEach(() => {
	chalk.level = saved;
});

/** The rows of text the summary drew. */
function draw(width: number, level: 0 | 1 | 2 | 3 = 0, rows = both) {
	const app = render(
		<FrameworkSummary frameworks={rows} width={width} level={level} />,
	);
	const frame = app.lastFrame() ?? '';
	app.unmount();
	return frame;
}
const iconRows = (frame: string) =>
	frame.split('\n').filter(line => BLOCKS.test(line)).length;

test('icons draw side by side and wrap on narrow widths', () => {
	const wide = draw(100);
	expect(iconRows(wide)).toBe(4);
	expect(wide).toContain('Next.js 15.2');
	expect(wide).toContain('Expo 52');
	expect(wide).toContain('web');
	expect(wide).toContain('mobile');
	const narrow = draw(70);
	expect(iconRows(narrow)).toBe(8);
});

test('below MIN_ICON_WIDTH a ● and the name are drawn', () => {
	const frame = draw(MIN_ICON_WIDTH - 1);
	expect(frame).not.toMatch(BLOCKS);
	expect(frame).toContain('● Next.js 15.2');
	expect(frame).toContain('● Expo 52');
	expect(frame).toContain('web');
});

test('truecolor gets the exact hex; level 0 draws no colour codes', () => {
	chalk.level = 3;
	const rows = [{framework: {...next, id: 'vite'}, units: ['web']}];
	// vite's brand colour is #9135ff
	expect(draw(100, 3, rows)).toContain(`${ESC}[38;2;145;53;255m`);
	const plain = draw(100, 0, rows);
	expect(plain).not.toContain(`${ESC}[38;`);
	expect(iconRows(plain)).toBe(4);
});

test('a Phosphor fallback keeps its icon colour and its name goes uncoloured', () => {
	chalk.level = 3;
	const rows = [
		{framework: {...next, id: 'vite-lit', name: 'Lit'}, units: ['a']},
	];
	const frame = draw(100, 3, rows);
	// #8a8a8a on the icon rows, none on the name line
	expect(frame).toContain(`${ESC}[38;2;138;138;138m`);
	const nameLine = frame.split('\n').find(line => line.includes('Lit'))!;
	expect(/\u001B\[38;[\d;]*mLit/.test(nameLine)).toBe(false);
});

test('Next.js #000000 is drawn in the default colour', () => {
	expect(iconColor('#000000')).toBeUndefined();
});

test('Vite #646CFF keeps its colour', () => {
	expect(iconColor('#646CFF')).toBe('#646CFF');
});

test('a very light colour is drawn in the default colour', () => {
	expect(iconColor('#ffffff')).toBeUndefined();
});

test('frameworkText gives one line per framework', () => {
	expect(frameworkText(both)).toBe('Next.js 15.2: web\nExpo 52: mobile');
	expect(
		frameworkText([
			{framework: {...next, version: null}, units: ['web', 'docs']},
		]),
	).toBe('Next.js: web, docs');
	expect(frameworkText([])).toBe('');
});

test('units on different versions of one framework get a row each', () => {
	const layout = {
		units: [
			{name: 'docs', framework: {...next, version: '14'}},
			{name: 'web', framework: next},
			{name: 'blog', framework: next},
		],
	} as unknown as Parameters<typeof frameworksOf>[0];
	const rows = frameworksOf(layout);
	expect(frameworkText(rows)).toBe('Next.js 14: docs\nNext.js 15.2: web, blog');
	const frame = draw(100, 0, rows);
	expect(frame).toContain('Next.js 14');
	expect(frame).toContain('Next.js 15.2');
});
