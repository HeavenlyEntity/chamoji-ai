import {FRAMEWORKS} from '@chamoji/core';
import {expect, test} from 'vitest';
import {
	FRAMEWORK_ICONS,
	ICON_COLUMNS,
	ICON_ROWS,
} from '../src/framework-icons.js';

const allowed = new Set([...' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█']);

test('every framework id has an icon', () => {
	for (const {id} of FRAMEWORKS) expect(FRAMEWORK_ICONS[id]).toBeDefined();
});

test('each icon is ICON_ROWS rows of ICON_COLUMNS quadrant cells', () => {
	expect(ICON_ROWS).toBe(4);
	expect(ICON_COLUMNS).toBe(8);
	for (const [id, icon] of Object.entries(FRAMEWORK_ICONS)) {
		expect(icon.large, id).toHaveLength(ICON_ROWS);
		for (const row of icon.large) {
			expect([...row], id).toHaveLength(ICON_COLUMNS);
			for (const cell of row) expect(allowed.has(cell), id).toBe(true);
		}
	}
});

test('each hex is #rrggbb', () => {
	for (const [id, icon] of Object.entries(FRAMEWORK_ICONS)) {
		expect(icon.hex, id).toMatch(/^#[0-9a-f]{6}$/);
	}
});

test('no icon is blank', () => {
	for (const [id, icon] of Object.entries(FRAMEWORK_ICONS)) {
		expect(icon.large.join('').trim(), id).not.toBe('');
	}
});
