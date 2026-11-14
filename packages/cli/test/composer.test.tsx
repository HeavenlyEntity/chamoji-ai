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
	impact?: {own: string[]; rides: string[]},
	check?: {
		checkWhy?: (why: string, title: string) => Promise<boolean>;
		checkWhyTimeoutMs?: number;
		draft?:
			| {text: string; source: string}
			| Promise<{text: string; source: string} | undefined>;
	},
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
			impact={impact}
			checkWhy={check?.checkWhy}
			checkWhyTimeoutMs={check?.checkWhyTimeoutMs}
			draft={check?.draft}
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
	await app.type(
		'boom',
		ENTER,
		'drop v1',
		ENTER,
		'v1 had no auth, so anyone could read other people orders',
		ENTER,
	);
	await app.type('y', 'the /v1 routes are gone', ENTER);
	expect(app.onSubmit).toHaveBeenCalledWith(
		'💥 Drop v1\n\nBREAKING CHANGE: the /v1 routes are gone\nWhy: v1 had no auth, so anyone could read other people orders',
	);
});

const THIN_WARNING =
	'Name the bug, limit or request behind this, or what breaks if someone reverts it. Enter again keeps it as written.';

// The 100-column test frame wraps long lines; compare without the wrap.
const flat = (frame: string | undefined) =>
	(frame ?? '').replaceAll(/\s+/g, ' ');

async function toWhy() {
	const app = open({scopePrompt: false, messagePrompt: false});
	await app.type('bug', ENTER, 'fix it', ENTER);
	return app;
}

test('the why prompt asks what would break if the change were undone', async () => {
	const app = await toWhy();
	expect(app.lastFrame()).toContain(
		'What would break, or come back, if someone undid this?',
	);
});

test('a thin why warns and stays on the step', async () => {
	const app = await toWhy();
	await app.type('fix bug', ENTER);
	expect(app.lastFrame()).toContain('What would break, or come back');
	expect(flat(app.lastFrame())).toContain(THIN_WARNING);
	expect(app.lastFrame()).not.toContain('Breaking change? (y/N)');
});

test('a second Enter keeps a thin why as written', async () => {
	const app = await toWhy();
	await app.type('fix bug', ENTER, ENTER);
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
	await app.type(ENTER);
	expect(app.onSubmit.mock.calls[0]?.[0]).toContain('Why: fix bug');
});

test('editing a thin why clears the warning', async () => {
	const app = await toWhy();
	await app.type('fix bug', ENTER);
	expect(flat(app.lastFrame())).toContain(THIN_WARNING);
	await app.type(' because sessions expire');
	expect(flat(app.lastFrame())).not.toContain(THIN_WARNING);
});

test('a good why moves on with the first Enter', async () => {
	const app = await toWhy();
	await app.type('Safari drops the session cookie when the tab sleeps', ENTER);
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
});

const AI_WARNING =
	"This doesn't say what would go wrong without the change. Name the cause or the limit behind it. Enter again keeps it as written.";
const VAGUE_BUT_LONG = 'this makes the code better and easier to maintain';

async function toWhyChecked(
	checkWhy: (why: string, title: string) => Promise<boolean>,
	checkWhyTimeoutMs?: number,
) {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		undefined,
		undefined,
		undefined,
		{checkWhy, checkWhyTimeoutMs},
	);
	await app.type('bug', ENTER, 'fix it', ENTER);
	return app;
}

test('Jev finding a why unclear warns once, and a second Enter moves on', async () => {
	const checkWhy = vi.fn(async () => true);
	const app = await toWhyChecked(checkWhy);
	await app.type(VAGUE_BUT_LONG, ENTER);
	await tick();
	expect(checkWhy).toHaveBeenCalledWith(VAGUE_BUT_LONG, 'fix it');
	expect(flat(app.lastFrame())).toContain(AI_WARNING);
	expect(app.lastFrame()).not.toContain('Breaking change? (y/N)');
	await app.type(ENTER);
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
	expect(checkWhy).toHaveBeenCalledTimes(1);
});

test('Jev finding a why fine moves on with the first Enter', async () => {
	const app = await toWhyChecked(async () => false);
	await app.type(VAGUE_BUT_LONG, ENTER);
	await tick();
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
});

test('a check that never answers moves on after the timeout', async () => {
	const app = await toWhyChecked(
		async () => new Promise<boolean>(() => {}),
		150,
	);
	await app.type(VAGUE_BUT_LONG, ENTER);
	expect(app.lastFrame()).toContain('Checking the reason');
	await new Promise(resolve => setTimeout(resolve, 200));
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
});

test('a check that fails moves on', async () => {
	const app = await toWhyChecked(async () => {
		throw new Error('offline');
	});
	await app.type(VAGUE_BUT_LONG, ENTER);
	await tick();
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
});

async function pendingCheck() {
	let resolve!: (unclear: boolean) => void;
	const checkWhy = vi.fn(
		async () =>
			new Promise<boolean>(done => {
				resolve = done;
			}),
	);
	const app = await toWhyChecked(checkWhy, 5000);
	await app.type(VAGUE_BUT_LONG, ENTER);
	expect(app.lastFrame()).toContain('Checking the reason');
	return {app, resolve};
}

test.each([true, false])(
	'an answer of %s that arrives after more typing is dropped',
	async answer => {
		const {app, resolve} = await pendingCheck();
		await app.type('!');
		resolve(answer);
		await tick();
		expect(flat(app.lastFrame())).not.toContain(AI_WARNING);
		expect(app.lastFrame()).not.toContain('Checking the reason');
		expect(app.lastFrame()).toContain('What would break, or come back');
		expect(app.lastFrame()).not.toContain('Breaking change? (y/N)');
	},
);

test.each([true, false])(
	'an answer of %s that arrives after Esc is dropped',
	async answer => {
		const {app, resolve} = await pendingCheck();
		await app.type(ESC);
		resolve(answer);
		await tick();
		expect(flat(app.lastFrame())).not.toContain(AI_WARNING);
		expect(app.lastFrame()).not.toContain('Checking the reason');
		expect(app.lastFrame()).not.toContain('Breaking change? (y/N)');
		expect(app.lastFrame()).toContain('Title');
	},
);

test('an answer that arrives after Ctrl-C is dropped', async () => {
	const {app, resolve} = await pendingCheck();
	await app.type(CTRL_C);
	resolve(true);
	await tick();
	expect(app.onCancel).toHaveBeenCalled();
	expect(app.onSubmit).not.toHaveBeenCalled();
	expect(flat(app.lastFrame())).not.toContain(AI_WARNING);
});

test('a locally thin why never reaches Jev', async () => {
	const checkWhy = vi.fn(async () => true);
	const app = await toWhyChecked(checkWhy);
	await app.type('fix bug', ENTER);
	expect(flat(app.lastFrame())).toContain(THIN_WARNING);
	expect(checkWhy).not.toHaveBeenCalled();
});

test('an empty why does not ask Jev', async () => {
	const checkWhy = vi.fn(async () => true);
	const app = await toWhyChecked(checkWhy);
	await app.type(ENTER);
	expect(checkWhy).not.toHaveBeenCalled();
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
});

test('without a check, a vague but long why moves on as before', async () => {
	const app = await toWhy();
	await app.type(VAGUE_BUT_LONG, ENTER);
	expect(app.lastFrame()).toContain('Breaking change? (y/N)');
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

test('the composer shows releases with: web · rides along to: mobile for a web and supabase change', async () => {
	const app = open({}, undefined, undefined, {own: ['web'], rides: ['mobile']});
	expect(app.lastFrame()).toContain(
		'releases with: web · rides along to: mobile',
	);
	await app.type('bug', ENTER, 'api', ENTER, 'fix timeout', ENTER);
	await app.type(ENTER, ENTER, ENTER); // no body, no why, not breaking
	// web is released by this change, so there is nothing to offer.
	expect(app.onSubmit).toHaveBeenCalledWith('🐛 (api): Fix timeout');
});

test('the impact line leaves out an empty half and strips control characters', async () => {
	const own = open({}, undefined, undefined, {own: ['web'], rides: []});
	expect(own.lastFrame()).toContain('releases with: web');
	expect(own.lastFrame()).not.toContain('rides along');
	const rides = open({}, undefined, undefined, {
		own: [],
		rides: ['we\u001B[2Jb'],
	});
	expect(rides.lastFrame()).toContain('rides along to: we[2Jb');
	expect(rides.lastFrame()).not.toContain('\u001B[2J');
	expect(rides.lastFrame()).not.toContain('releases with');
	const none = open({}, undefined, undefined, {own: [], rides: []});
	expect(none.lastFrame()).not.toContain('releases with');
});

test('a shared-only change offers Release trailers, default No', async () => {
	const impact = {own: [], rides: ['web', 'mobile']};
	const no = open({}, undefined, undefined, impact);
	await no.type('bug', ENTER, 'api', ENTER, 'fix timeout', ENTER);
	await no.type(ENTER, ENTER, ENTER); // no body, no why, not breaking
	expect(no.lastFrame()).toContain('Release web, mobile now? (y/N)');
	expect(no.onSubmit).not.toHaveBeenCalled();
	await no.type(ENTER);
	expect(no.onSubmit).toHaveBeenCalledWith('🐛 (api): Fix timeout');

	const yes = open({}, undefined, undefined, impact);
	await yes.type('bug', ENTER, 'api', ENTER, 'fix timeout', ENTER);
	await yes.type(ENTER, ENTER, ENTER, 'y');
	expect(yes.onSubmit).toHaveBeenCalledWith(
		'🐛 (api): Fix timeout\n\nRelease: web\nRelease: mobile',
	);

	const breaking = open({}, undefined, undefined, impact);
	await breaking.type('bug', ENTER, 'api', ENTER, 'fix timeout', ENTER);
	await breaking.type(ENTER, ENTER, 'y', 'it breaks', ENTER, 'y');
	expect(breaking.onSubmit).toHaveBeenCalledWith(
		'🐛 (api): Fix timeout\n\nBREAKING CHANGE: it breaks\nRelease: web\nRelease: mobile',
	);
});

test('the Release trailers carry the raw unit names', async () => {
	const app = open({}, undefined, undefined, {
		own: [],
		rides: ['we\u001B[2Jb'],
	});
	await app.type('bug', ENTER, 'api', ENTER, 'fix timeout', ENTER);
	await app.type(ENTER, ENTER, ENTER, 'y');
	expect(app.onSubmit).toHaveBeenCalledWith(
		'🐛 (api): Fix timeout\n\nRelease: we\u001B[2Jb',
	);
});

const DRAFT = {
	text: 'the provider returns 422 for stays over 365 nights',
	source: 'your Claude Code session',
};
const TAB = '\t';

async function toWhyWithDraft(draft?: typeof DRAFT) {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		undefined,
		undefined,
		undefined,
		{draft},
	);
	await app.type('bug', ENTER, 'cap the stay length', ENTER);
	return app;
}

test('a remembered reason is offered on the why step and Tab fills it', async () => {
	const app = await toWhyWithDraft(DRAFT);
	expect(flat(app.lastFrame())).toContain(
		'Tab fills it from your Claude Code session.',
	);
	// The row wraps beside the prompt, so only the start is whole.
	expect(app.lastFrame()).toContain('the provider returns 422');
	await app.type(TAB);
	expect(app.lastFrame()).toContain('the provider returns 422');
	expect(flat(app.lastFrame())).not.toContain('Tab fills it');
	await app.type(ENTER, ENTER);
	expect(app.onSubmit).toHaveBeenCalledTimes(1);
	expect(app.onSubmit.mock.calls[0]?.[0]).toContain(`Why: ${DRAFT.text}`);
});

test('the reason is never filled without Tab', async () => {
	const app = await toWhyWithDraft(DRAFT);
	await app.type(ENTER, ENTER);
	expect(app.onSubmit.mock.calls[0]?.[0]).not.toContain('Why:');
});

test('typing hides the offer and Tab then does nothing', async () => {
	const app = await toWhyWithDraft(DRAFT);
	await app.type('a');
	expect(flat(app.lastFrame())).not.toContain('Tab fills it');
	await app.type(TAB);
	expect(app.lastFrame()).not.toContain(DRAFT.text);
});

test('Tab does nothing on other steps, and without a draft', async () => {
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		undefined,
		undefined,
		undefined,
		{draft: DRAFT},
	);
	await app.type('bug', TAB, ENTER);
	expect(app.lastFrame()).not.toContain(DRAFT.text);
	const plain = await toWhyWithDraft();
	expect(flat(plain.lastFrame())).not.toContain('Tab fills it');
	await plain.type(TAB);
	await plain.type(ENTER, ENTER);
	expect(plain.onSubmit.mock.calls[0]?.[0]).not.toContain('Why:');
});

test('a draft that arrives late is offered while the Why is empty', async () => {
	let resolve: (draft: typeof DRAFT) => void = () => undefined;
	const late = new Promise<typeof DRAFT>(done => {
		resolve = done;
	});
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		undefined,
		undefined,
		undefined,
		{draft: late},
	);
	await app.type('bug', ENTER, 'cap the stay length', ENTER);
	expect(flat(app.lastFrame())).not.toContain('Tab fills it');
	resolve(DRAFT);
	await app.type('');
	expect(flat(app.lastFrame())).toContain(
		'Tab fills it from your Claude Code session.',
	);
	await app.type(TAB, ENTER, ENTER);
	expect(app.onSubmit.mock.calls[0]?.[0]).toContain(`Why: ${DRAFT.text}`);
});

test('a late draft is not offered once the person has typed a Why', async () => {
	let resolve: (draft: typeof DRAFT) => void = () => undefined;
	const late = new Promise<typeof DRAFT>(done => {
		resolve = done;
	});
	const app = open(
		{scopePrompt: false, messagePrompt: false},
		undefined,
		undefined,
		undefined,
		{draft: late},
	);
	await app.type('bug', ENTER, 'cap the stay length', ENTER, 'a');
	resolve(DRAFT);
	await app.type('');
	expect(flat(app.lastFrame())).not.toContain('Tab fills it');
	await app.type(TAB);
	expect(app.lastFrame()).not.toContain(DRAFT.text);
});
