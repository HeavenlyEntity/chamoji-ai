import {expect, test} from 'vitest';
import {bumpFor, nextVersion} from '../src/version.js';
import {commit} from './helpers/commit.js';

test('boom means major', () => {
	expect(bumpFor([commit('✨ Add'), commit('💥 Drop node 18')])).toBe('major');
});

test('breaking footer means major', () => {
	expect(
		bumpFor([commit('✨ Add', {body: 'BREAKING CHANGE: renamed export'})]),
	).toBe('major');
});

test('sparkles and bug means minor', () => {
	expect(bumpFor([commit('🐛 Fix'), commit('✨ Add')])).toBe('minor');
});

test('only bug means patch', () => {
	expect(bumpFor([commit('🐛 Fix')])).toBe('patch');
});

test('only memo means no bump', () => {
	expect(bumpFor([commit('📝 Docs')])).toBeNull();
	expect(bumpFor([])).toBeNull();
});

test('nextVersion', () => {
	expect(nextVersion('v1.2.3', 'minor')).toBe('1.3.0');
	expect(nextVersion('1.2.3', 'major')).toBe('2.0.0');
	expect(nextVersion(null, 'patch')).toBe('0.0.1');
	expect(nextVersion('1.2.3', null)).toBeNull();
});
