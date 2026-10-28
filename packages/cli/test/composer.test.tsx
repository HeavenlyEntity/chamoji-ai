import {DEFAULT_COMPOSE_CONFIG, type ComposeConfig} from '@chamoji/core';
import {render} from 'ink-testing-library';
import {afterEach, expect, test, vi} from 'vitest';
import type {Advice} from '../src/advisor.js';
import {Composer} from '../src/composer.js';

const ENTER = '\r';
const ESC = '\u001B';
const CTRL_C = '\u0003';
const DOWN = '\u001B[B';

// Ink handles each write on a later tick, so the tests pause between keys.
const tick = async () => new Promise(resolve => setTimeout(resolve, 30));

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function open(
	config: Partial<ComposeConfig> = {},
	advice?: Promise<Advice | null>,
	adviceTimeoutMs?: number,
) {
	const onSubmit = vi.fn();
	const onCancel = vi.fn();
	const app = render(
		<Composer
			config={{...DEFAULT_COMPOSE_CONFIG, ...config}}
			onSubmit={onSubmit}
			onCancel={onCancel}
			advice={advice}
			adviceTimeoutMs={adviceTimeoutMs}
		/>,
	);
	cleanup = app.unmount;
	const type = async (...keys: string[]) => {
		for (const key of keys) {
			app.stdin.write(key);
			await tick();
		}
	};

	return {...app, type, onSubmit, onCancel};
}

test('search, scope, title, then Enter through the rest writes the message', async () => {
	const app = open();
	await app.type('bug', ENTER, 'api', ENTER, 'fix timeout', ENTER);
	await app.type(ENTER, ENTER, ENTER); // no body, no why, not breaking
	expect(app.onSubmit).toHaveBeenCalledWith('🐛 (api): Fix timeout');
	expect(app.onCancel).not.toHaveBeenCalled();
});

test('the screen shows the matches and a live preview', async () => {
	const app = open();
	await app.type('bug');
	expect(app.lastFrame()).toContain('🐛');
	expect(app.lastFrame()).toContain('Fix a bug');
	await app.type(ENTER, ENTER, 'fix');
	expect(app.lastFrame()).toContain('🐛 Fix');
});

test('arrow keys pick another match', async () => {
	const app = open({scopePrompt: false, messagePrompt: false});
	await app.type('fix', DOWN, ENTER, 'patch the parser', ENTER, ENTER, ENTER);
	const message = app.onSubmit.mock.calls[0]?.[0] as string;
	expect(message).toMatch(/^\S+ Patch the parser$/);
	expect(message.startsWith('🐛')).toBe(false);
});

test('Esc goes back a step, keeping what was typed', async () => {
	const app = open();
	await app.type('bug', ENTER, 'api', ENTER, ESC);
	expect(app.lastFrame()).toContain('Scope');
	expect(app.lastFrame()).toContain('api');
});

test('the title is required', async () => {
	const app = open({scopePrompt: false});
	await app.type('bug', ENTER, ENTER);
	expect(app.lastFrame()).toContain('Title');
});

test('Ctrl-C cancels', async () => {
	const app = open();
	await app.type('bug', ENTER, CTRL_C);
	expect(app.onCancel).toHaveBeenCalled();
	expect(app.onSubmit).not.toHaveBeenCalled();
});

test('scopePrompt and messagePrompt false skip those steps', async () => {
	const app = open({scopePrompt: false, messagePrompt: false});
	await app.type('sparkles', ENTER, 'add export', ENTER, ENTER, ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith('✨ Add export');
});

test('a breaking change and a why become trailers', async () => {
	const app = open({scopePrompt: false, messagePrompt: false});
	await app.type('boom', ENTER, 'drop v1', ENTER, 'v1 had no auth', ENTER);
	await app.type('y', 'the /v1 routes are gone', ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith(
		'💥 Drop v1\n\nBREAKING CHANGE: the /v1 routes are gone\nWhy: v1 had no auth',
	);
});

test('emojiFormat code writes the shortcode', async () => {
	const app = open({
		scopePrompt: false,
		messagePrompt: false,
		emojiFormat: 'code',
	});
	await app.type('bug', ENTER, 'fix it', ENTER, ENTER, ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith(':bug: Fix it');
});

const ADVICE: Advice = {
	gitmojis: [
		{code: 'sparkles', probability: 0.92},
		{code: 'memo', probability: 0.1},
		{code: 'recycle', probability: 0.05},
	],
	breaking: 0.1,
	split: 0.1,
};

test('advice that arrives first puts its gitmojis at the top, preselected', async () => {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		Promise.resolve(ADVICE),
	);
	await tick();
	const frame = app.lastFrame()!;
	expect(frame).toContain('suggested');
	expect(frame.indexOf('sparkles')).toBeLessThan(frame.indexOf('memo'));
	expect(frame.indexOf('memo')).toBeLessThan(frame.indexOf('recycle'));
	expect(frame.indexOf('recycle')).toBeLessThan(frame.indexOf(' art '));
	await app.type(ENTER, 'add export', ENTER, ENTER, ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith('✨ Add export');
});

test('less certain advice keeps the usual order and shows a hint instead', async () => {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		Promise.resolve({
			...ADVICE,
			gitmojis: [
				{code: 'memo', probability: 0.6},
				{code: 'wrench', probability: 0.2},
				{code: 'bug', probability: 0.1},
			],
		}),
	);
	await tick();
	const frame = app.lastFrame()!;
	expect(frame).toContain('Jev suggests');
	expect(frame).toContain('📝 memo');
	expect(frame).not.toContain(' suggested');
	await app.type(ENTER, 'tidy up', ENTER, ENTER, ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith('🎨 Tidy up');
});

test('the hint goes away once a search is typed', async () => {
	const app = open(
		{},
		Promise.resolve({
			...ADVICE,
			gitmojis: [{code: 'memo', probability: 0.6}],
		}),
	);
	await tick();
	await app.type('bug');
	expect(app.lastFrame()).not.toContain('Jev suggests');
});

test('advice that arrives after typing leaves the list alone', async () => {
	let resolve!: (advice: Advice) => void;
	const late = new Promise<Advice>(done => {
		resolve = done;
	});
	const app = open({}, late);
	await app.type('b');
	resolve(ADVICE);
	await tick();
	await app.type('\u007F');
	expect(app.lastFrame()).not.toContain('suggested');
	expect(app.lastFrame()).not.toContain('Jev suggests');
});

test('a likely breaking change shows a hint, and the default stays No', async () => {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		Promise.resolve({...ADVICE, breaking: 0.82}),
	);
	await tick();
	await app.type(ENTER, 'drop the v1 api', ENTER, ENTER);
	expect(app.lastFrame()).toContain('may be breaking (82%)');
	await app.type(ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith('✨ Drop the v1 api');
});

test('an uncertain breaking probability shows nothing', async () => {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		Promise.resolve({...ADVICE, breaking: 0.55}),
	);
	await tick();
	await app.type(ENTER, 'tweak', ENTER, ENTER);
	expect(app.lastFrame()).not.toContain('may be breaking');
});

test('mixed changes show a split hint on the title step', async () => {
	const app = open(
		{scopePrompt: false},
		Promise.resolve({...ADVICE, split: 0.86}),
	);
	await tick();
	await app.type(ENTER);
	expect(app.lastFrame()).toContain('mix unrelated work');
});

test('advice that fails or comes too late changes nothing', async () => {
	const failing = open({}, Promise.reject(new Error('offline')));
	await tick();
	expect(failing.lastFrame()).not.toContain('suggested');
	failing.unmount();

	// Resolved only once the composer is up and its 40 ms wait is long over,
	// so a slow machine can't make the advice arrive in time.
	let resolve!: (advice: Advice) => void;
	const slow = new Promise<Advice>(done => {
		resolve = done;
	});
	const app = open({}, slow, 40);
	await new Promise(done => setTimeout(done, 300));
	resolve(ADVICE);
	await tick();
	await app.type('\u007F');
	expect(app.lastFrame()).not.toContain('suggested');
});
