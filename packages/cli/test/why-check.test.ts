import {expect, test, vi} from 'vitest';
import type {AdvisorClient} from '../src/advisor.js';
import {createWhyChecker, WHY_CHECK_VERSION} from '../src/why-check.js';

const input = {
	title: 'Make the code better',
	why: 'this makes the code better and easier to maintain',
	files: ['src/a.ts', 'src/b.ts'],
};

function fake(noul: number) {
	const systemOne = vi.fn<AdvisorClient['systemOne']>(async () => ({
		answers: {specific: {noul}},
	}));
	return {client: {systemOne}, systemOne};
}

test('a reason Jev finds unlikely to be specific is unclear', async () => {
	const {client} = fake(0.1);
	expect(await createWhyChecker(client)(input)).toBe(true);
});

test('a reason Jev finds specific is fine', async () => {
	const {client} = fake(0.9);
	expect(await createWhyChecker(client)(input)).toBe(false);
});

test('an unsure answer is fine', async () => {
	const {client} = fake(0.5);
	expect(await createWhyChecker(client)(input)).toBe(false);
});

test('Jev sees only the title, the why and the file paths', async () => {
	const {client, systemOne} = fake(0.9);
	await createWhyChecker(client)(input);
	const request = systemOne.mock.calls[0]![0];
	expect(request.state).toEqual(input);
	expect(Object.keys(request.questions)).toHaveLength(1);
});

test('the version names the question', () => {
	expect(WHY_CHECK_VERSION).toBe('jev-latest:why-v1');
});
