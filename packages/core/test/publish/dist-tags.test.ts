import {expect, test} from 'vitest';
import {distTagFor, ReleaseError} from '../../src/index.js';

const options = {prereleaseTag: 'next'};

test('a prerelease goes under the prerelease tag', () => {
	expect(distTagFor('2.0.0-rc.1', '1.0.0', options)).toBe('next');
});

test('a release below latest throws publish-check', () => {
	try {
		distTagFor('1.4.2', '2.1.0', options);
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(ReleaseError);
		expect((error as ReleaseError).code).toBe('publish-check');
		expect((error as ReleaseError).message).toBe(
			'1.4.2 is lower than latest (2.1.0); pass --tag to publish it under another dist-tag, for example --tag v1',
		);
	}
});

test('--tag wins', () => {
	expect(distTagFor('1.4.2', '2.1.0', {...options, tag: 'v1'})).toBe('v1');
});

test('a newer release, or the first one, is latest', () => {
	expect(distTagFor('1.1.0', '1.0.0', options)).toBe('latest');
	expect(distTagFor('1.0.0', null, options)).toBe('latest');
});
