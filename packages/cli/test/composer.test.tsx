import {DEFAULT_COMPOSE_CONFIG, type ComposeConfig} from '@chamoji/core';
import {render} from 'ink-testing-library';
import {afterEach, expect, test, vi} from 'vitest';
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

function open(config: Partial<ComposeConfig> = {}) {
	const onSubmit = vi.fn();
	const onCancel = vi.fn();
	const app = render(
		<Composer
			config={{...DEFAULT_COMPOSE_CONFIG, ...config}}
			onSubmit={onSubmit}
			onCancel={onCancel}
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
