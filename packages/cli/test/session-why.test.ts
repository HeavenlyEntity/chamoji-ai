import {mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import type {AdvisorClient} from '../src/advisor.js';
import {
	draftFromSession,
	reasonCandidates,
	recentUserMessages,
} from '../src/session-why.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const ROOT = '/work/my_repo';
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true})));
});

async function tempHome() {
	const home = await mkdtemp(path.join(tmpdir(), 'chamoji-home-'));
	dirs.push(home);
	return home;
}

async function plant(file: string, lines: unknown[], ageMs = 60_000) {
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(
		file,
		lines
			.map(line => (typeof line === 'string' ? line : JSON.stringify(line)))
			.join('\n') + '\n',
	);
	const at = new Date(NOW.getTime() - ageMs);
	await utimes(file, at, at);
}

const claudeDir = (home: string, root = ROOT) =>
	path.join(home, '.claude', 'projects', root.replaceAll(/[^A-Za-z0-9]/g, '-'));
const user = (content: unknown, extra: object = {}) => ({
	type: 'user',
	message: {role: 'user', content},
	...extra,
});

async function plantClaude(home: string, ageMs = 60_000) {
	await plant(
		path.join(claudeDir(home), 'a.jsonl'),
		[
			user('first message'),
			'this is not json',
			{
				type: 'assistant',
				message: {role: 'assistant', content: 'a model said this'},
			},
			user('meta text', {isMeta: true}),
			user('<command-name>/clear</command-name>'),
			user([
				{type: 'text', text: 'second message'},
				{type: 'tool_result', content: 'tool output'},
			]),
		],
		ageMs,
	);
}

async function plantCodex(
	home: string,
	cwd: string,
	name = 'rollout-1.jsonl',
	ageMs = 60_000,
) {
	await plant(
		path.join(home, '.codex', 'sessions', '2026', '11', '13', name),
		[
			{type: 'session_meta', payload: {cwd}},
			'garbage',
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'user',
					content: [
						{
							type: 'input_text',
							text: '<environment_context>x</environment_context>',
						},
					],
				},
			},
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'user',
					content: [
						{type: 'input_text', text: 'codex user text'},
						{type: 'output_text', text: 'not this'},
					],
				},
			},
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					content: [{type: 'output_text', text: 'model text'}],
				},
			},
		],
		ageMs,
	);
}

test('the Claude Code reader returns the user texts in order', async () => {
	const home = await tempHome();
	await plantClaude(home);
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toEqual({
		source: 'claude-code',
		messages: ['first message', 'second message'],
	});
});

test('the Codex reader matches by cwd and reads only input_text of user messages', async () => {
	const home = await tempHome();
	await plantCodex(home, path.join(ROOT, 'sub'));
	await plantCodex(home, '/elsewhere', 'rollout-2.jsonl', 1000);
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toEqual({
		source: 'codex',
		messages: ['codex user text'],
	});
});

test('a Codex session for another folder is ignored', async () => {
	const home = await tempHome();
	await plantCodex(home, '/elsewhere');
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toBeUndefined();
});

test('a session older than two hours gives nothing', async () => {
	const home = await tempHome();
	await plantClaude(home, 3 * 60 * 60 * 1000);
	await plantCodex(home, ROOT, 'rollout-1.jsonl', 3 * 60 * 60 * 1000);
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toBeUndefined();
});

test('with both, the newer session wins', async () => {
	const home = await tempHome();
	await plantClaude(home, 600_000);
	await plantCodex(home, ROOT, 'rollout-1.jsonl', 5000);
	expect((await recentUserMessages(ROOT, {home, now: NOW}))?.source).toBe(
		'codex',
	);
	await plantClaude(home, 1000);
	expect((await recentUserMessages(ROOT, {home, now: NOW}))?.source).toBe(
		'claude-code',
	);
});

test('it keeps the last 20 messages, each cut to 2000 characters', async () => {
	const home = await tempHome();
	await plant(
		path.join(claudeDir(home), 'a.jsonl'),
		Array.from({length: 25}, (_, index) =>
			user(`${index} ${'x'.repeat(3000)}`),
		),
	);
	const result = await recentUserMessages(ROOT, {home, now: NOW});
	expect(result?.messages).toHaveLength(20);
	expect(result?.messages[0]?.startsWith('5 ')).toBe(true);
	expect(result?.messages.every(text => text.length === 2000)).toBe(true);
});

test('a missing home gives undefined, never a throw', async () => {
	expect(
		await recentUserMessages(ROOT, {home: '/nonexistent/home', now: NOW}),
	).toBeUndefined();
});

const REASON =
	'The provider returns 422 for stays over 365 nights so guests lose the booking after paying.';

test('reasonCandidates keeps only a sentence that gives a reason', () => {
	expect(
		reasonCandidates(['Can you cap stays?', REASON, 'thanks'], []),
	).toEqual([REASON]);
});

test('a sentence with a token-like run is dropped', () => {
	expect(
		reasonCandidates(
			[
				'The provider returns 422 because we pasted tok_abcdefghijklmnopqrstuvwxyz into the config.',
			],
			[],
		),
	).toEqual([]);
});

test('an email in a sentence is replaced', () => {
	const [first] = reasonCandidates(
		[
			'The provider returns 422 when mail to jo@example.com bounces for guests today.',
		],
		[],
	);
	expect(first).toContain('<email>');
	expect(first).not.toContain('jo@example.com');
});

test('a staged file basename counts as a marker, newest first, deduped', () => {
	expect(
		reasonCandidates(
			[
				'Please look at stays.ts and cap the length of every single stay we allow',
				REASON,
				REASON,
			],
			['src/stays.ts'],
		),
	).toEqual([
		REASON,
		'Please look at stays.ts and cap the length of every single stay we allow',
	]);
});

function client(
	votes: Record<string, number>,
	asked: unknown[] = [],
): AdvisorClient {
	return {
		async systemOne(request) {
			asked.push(request);
			return {answers: {pick: {probabilities: votes}}};
		},
	};
}
const input = (home: string, extra: object = {}) => ({
	root: ROOT,
	home,
	now: NOW,
	stagedFiles: ['src/stays.ts'],
	...extra,
});

async function homeWithReason() {
	const home = await tempHome();
	await plant(path.join(claudeDir(home), 'a.jsonl'), [user(REASON)]);
	return home;
}

test('without a client the first candidate is offered with its source', async () => {
	const home = await homeWithReason();
	expect(await draftFromSession(input(home))).toEqual({
		text: REASON,
		source: 'your Claude Code session',
	});
});

test('with a client voting for a candidate, that sentence is offered', async () => {
	const home = await homeWithReason();
	const asked: unknown[] = [];
	expect(
		(
			await draftFromSession(
				input(home, {client: client({c0: 0.8, none: 0.2}, asked)}),
			)
		)?.text,
	).toBe(REASON);
	expect(JSON.stringify(asked)).toContain('best says why');
	expect(JSON.stringify(asked)).not.toContain(home);
});

test('with a client voting none, nothing is offered', async () => {
	const home = await homeWithReason();
	expect(
		await draftFromSession(input(home, {client: client({c0: 0.1, none: 0.9})})),
	).toBeUndefined();
});

test('control characters never reach the draft', async () => {
	const home = await tempHome();
	await plant(path.join(claudeDir(home), 'a.jsonl'), [
		user(REASON.replace('returns', 'returns \u001B[31m')),
	]);
	const draft = await draftFromSession(input(home));
	expect(draft?.text).not.toContain('\u001B');
});

test('a Codex session for a sibling folder sharing the name prefix is ignored', async () => {
	const home = await tempHome();
	await plantCodex(home, `${ROOT}-other`);
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toBeUndefined();
});

const FILLER = (count: number) =>
	Array.from({length: count}, () => user('ok ' + 'y'.repeat(900)));

test('only the end of a large Claude Code file is read', async () => {
	const home = await tempHome();
	const file = path.join(claudeDir(home), 'a.jsonl');
	await plant(file, [user(REASON), ...FILLER(400)]);
	const early = await recentUserMessages(ROOT, {home, now: NOW});
	expect(early?.messages.join(' ')).not.toContain('returns 422');
	expect(await draftFromSession(input(home))).toBeUndefined();
	await plant(file, [...FILLER(400), user(REASON)]);
	expect((await draftFromSession(input(home)))?.text).toBe(REASON);
});

test('a Codex file for another folder is rejected from its first line', async () => {
	const home = await tempHome();
	const file = path.join(
		home,
		'.codex',
		'sessions',
		'2026',
		'11',
		'13',
		'r.jsonl',
	);
	await plant(file, [
		{type: 'session_meta', payload: {cwd: '/elsewhere'}},
		...FILLER(2000),
	]);
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toBeUndefined();
});

test('a Codex file whose first line never ends is skipped', async () => {
	const home = await tempHome();
	const file = path.join(
		home,
		'.codex',
		'sessions',
		'2026',
		'11',
		'13',
		'r.jsonl',
	);
	await plant(file, [
		`{"type":"session_meta","payload":{"cwd":"${ROOT}","pad":"${'z'.repeat(70_000)}"}}`,
	]);
	expect(await recentUserMessages(ROOT, {home, now: NOW})).toBeUndefined();
});

test('summaries, subagent turns and AGENTS.md text are never read as the user', async () => {
	const home = await tempHome();
	await plant(path.join(claudeDir(home), 'a.jsonl'), [
		user(REASON, {isCompactSummary: true}),
		user(REASON, {isSidechain: true}),
		user('real message'),
	]);
	expect((await recentUserMessages(ROOT, {home, now: NOW}))?.messages).toEqual([
		'real message',
	]);
	const other = await tempHome();
	await plant(
		path.join(other, '.codex', 'sessions', '2026', '11', '13', 'r.jsonl'),
		[
			{type: 'session_meta', payload: {cwd: ROOT}},
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'user',
					content: [
						{
							type: 'input_text',
							text: '# AGENTS.md instructions for /x\n\n' + REASON,
						},
					],
				},
			},
		],
	);
	expect(
		await recentUserMessages(ROOT, {home: other, now: NOW}),
	).toBeUndefined();
});
