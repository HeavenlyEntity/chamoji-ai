import {expect, test} from 'vitest';
import {GITMOJIS, findGitmoji, getGitmoji} from '../src/gitmojis.js';

test('knows the official gitmojis', () => {
	expect(GITMOJIS.length).toBeGreaterThanOrEqual(74);
	expect(getGitmoji('zap')?.semver).toBe('patch');
	expect(getGitmoji('white_check_mark')?.emoji).toBe('✅');
});

test('findGitmoji matches unicode with and without FE0F', () => {
	expect(findGitmoji('⚡ Speed up parser')?.code).toBe('zap');
	expect(findGitmoji('⚡️ Speed up parser')?.code).toBe('zap');
	expect(findGitmoji('♻ Refactor')?.code).toBe('recycle');
});

test('findGitmoji matches :code: and ignores unknown codes', () => {
	expect(findGitmoji(':bug: Fix crash')).toEqual({
		code: 'bug',
		index: 0,
		length: 5,
	});
	expect(findGitmoji(':nope: Something')).toBeNull();
	expect(findGitmoji('Plain message')).toBeNull();
});

test('findGitmoji returns the earliest match', () => {
	expect(findGitmoji('🐛 Fix :sparkles: rendering')?.code).toBe('bug');
});
