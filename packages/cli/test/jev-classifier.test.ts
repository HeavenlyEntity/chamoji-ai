import type {ParsedCommit} from '@chamoji/core';
import {expect, test} from 'vitest';
import {commit} from '../../core/test/helpers/commit.js';
import {createJevClassifier, type JevClient} from '../src/jev-classifier.js';

type Request = Parameters<JevClient['systemOne']>[0];

/** A fake client that answers every question with `pick(commit index)`. */
function fakeClient(
	pick: (index: number) => {choice: string; confidence: number},
) {
	const requests: Request[] = [];
	const client: JevClient = {
		async systemOne(request) {
			requests.push(request);
			const answers: Record<string, {choice: string; confidence: number}> = {};
			for (const name of Object.keys(request.questions)) {
				answers[name] = pick(Number(name.slice('commit_'.length)));
			}

			return {
				answers,
				model: 'fake',
				usage: {input_tokens: 1, output_tokens: 0},
			};
		},
	};
	return {client, requests};
}

const commits = (count: number): ParsedCommit[] =>
	Array.from({length: count}, (_, index) =>
		commit(`Tidy area ${index}`, {body: 'x'.repeat(1000)}),
	);

test('sends subjects and trimmed bodies, never diffs, in batches', async () => {
	const {client, requests} = fakeClient(() => ({
		choice: 'sparkles',
		confidence: 0.9,
	}));
	const input = commits(30);
	await createJevClassifier(client, {batchSize: 25})(input);

	expect(requests).toHaveLength(2);
	const [first] = requests;
	const state = first!.state as {
		commits: Array<{subject: string; body: string}>;
	};
	expect(state.commits).toHaveLength(25);
	expect(state.commits[0]).toEqual({
		subject: 'Tidy area 0',
		body: 'x'.repeat(300),
	});
	expect(Object.keys(first!.questions)).toHaveLength(25);
	expect(Object.keys(requests[1]!.questions)).toHaveLength(5);
});

test('questions point at their commit and offer gitmojis plus none, not boom', async () => {
	const {client, requests} = fakeClient(() => ({
		choice: 'none',
		confidence: 1,
	}));
	await createJevClassifier(client)(commits(2));

	const question = requests[0]!.questions['commit_1'] as {
		type: string;
		instructions: string;
		criteria: Record<string, unknown>;
	};
	expect(question.type).toBe('choice');
	expect(question.instructions).toContain('`commits[1]`');
	expect(Object.keys(question.criteria)).toContain('sparkles');
	expect(Object.keys(question.criteria)).toContain('none');
	expect(Object.keys(question.criteria)).not.toContain('boom');
});

test('keeps only confident picks that are not none', async () => {
	const picks = [
		{choice: 'sparkles', confidence: 0.9},
		{choice: 'bug', confidence: 0.3},
		{choice: 'none', confidence: 0.95},
	];
	const {client} = fakeClient(index => picks[index]!);
	const input = commits(3);
	const result = await createJevClassifier(client)(input);

	expect([...result]).toEqual([[input[0]!.hash, 'sparkles']]);
});

test('reports how many commits it sorted', async () => {
	const {client} = fakeClient(index => ({
		choice: index === 0 ? 'bug' : 'none',
		confidence: 0.9,
	}));
	const reports: string[] = [];
	await createJevClassifier(client, {report: line => reports.push(line)})(
		commits(4),
	);
	expect(reports).toEqual(['Jev sorted 1 of 4 commits no rule could place']);
});
