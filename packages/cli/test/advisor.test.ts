import type {StagedChanges} from '@chamoji/core';
import {expect, test} from 'vitest';
import {
	ADVICE_VERSION,
	createCommitAdvisor,
	HINT_THRESHOLD,
	type AdvisorClient,
} from '../src/advisor.js';

type Request = Parameters<AdvisorClient['systemOne']>[0];

const staged: StagedChanges = {
	files: [
		{path: 'src/export.ts', status: 'added', added: 120, deleted: 0},
		{path: 'src/index.ts', status: 'modified', added: 3, deleted: 1},
	],
	withheld: 1,
};

function fakeClient(answers: Record<string, unknown>) {
	const requests: Request[] = [];
	const client: AdvisorClient = {
		async systemOne(request) {
			requests.push(request);
			return {answers} as Awaited<ReturnType<AdvisorClient['systemOne']>>;
		},
	};
	return {client, requests};
}

const answers = {
	gitmoji: {
		type: 'choice',
		choice: 'none',
		confidence: 0.4,
		probabilities: {
			none: 0.4,
			sparkles: 0.3,
			bug: 0.05,
			memo: 0.15,
			recycle: 0.1,
		},
	},
	breaking: {type: 'noul', noul: 0.12},
	split: {type: 'noul', noul: 0.81},
};

test('one request with the gitmoji, breaking and split questions', async () => {
	const {client, requests} = fakeClient(answers);
	await createCommitAdvisor(client)({staged, draft: 'add csv export'});
	expect(requests).toHaveLength(1);
	const [request] = requests;
	expect(Object.keys(request!.questions).sort()).toEqual([
		'breaking',
		'gitmoji',
		'split',
	]);
	expect(request!.questions.gitmoji).toMatchObject({type: 'choice'});
	expect(request!.questions.breaking).toMatchObject({type: 'noul'});
	expect(request!.questions.split).toMatchObject({type: 'noul'});
	const criteria = (request!.questions.gitmoji as {criteria: object}).criteria;
	expect(criteria).toHaveProperty('sparkles');
	expect(criteria).toHaveProperty('none');
	expect(criteria).not.toHaveProperty('boom');
	expect(criteria).not.toHaveProperty('bookmark');
});

test('the state has paths, counts and the draft, and no diff unless given', async () => {
	const {client, requests} = fakeClient(answers);
	await createCommitAdvisor(client)({staged, draft: 'add csv export'});
	expect(requests[0]!.state).toEqual({
		files: staged.files,
		withheldFiles: 1,
		draftTitle: 'add csv export',
	});

	await createCommitAdvisor(client)({staged: {...staged, diff: '+ok'}});
	expect(requests[1]!.state).toMatchObject({diff: '+ok', draftTitle: ''});
});

test('the top three gitmojis come from the probabilities, without none', async () => {
	const {client} = fakeClient(answers);
	const advice = await createCommitAdvisor(client)({staged});
	expect(advice.gitmojis).toEqual([
		{code: 'sparkles', probability: 0.3},
		{code: 'memo', probability: 0.15},
		{code: 'recycle', probability: 0.1},
	]);
	expect(advice.breaking).toBe(0.12);
	expect(advice.split).toBe(0.81);
});

test('a client error rejects, so the composer can carry on without advice', async () => {
	const client: AdvisorClient = {
		async systemOne() {
			throw new Error('offline');
		},
	};
	await expect(createCommitAdvisor(client)({staged})).rejects.toThrow(
		'offline',
	);
});

test('the hint threshold and version are exported for the composer and cache', () => {
	expect(HINT_THRESHOLD).toBe(0.7);
	expect(ADVICE_VERSION).toMatch(/advice/);
});
