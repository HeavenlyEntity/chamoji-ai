import {EventEmitter} from 'node:events';
import {
	detect,
	questions,
	recommend,
	summary,
	type Detection,
	type Preview,
	type PreviewUnit,
	type ReplayLine,
	type SetupAnswers,
} from '@chamoji/core';
import {render} from 'ink-testing-library';
import {afterAll, afterEach, beforeAll, expect, test, vi} from 'vitest';
import type {FixtureRepo} from '../../core/test/helpers/fixture-repo.js';
import {
	gearzLayout,
	singlePackage,
} from '../../core/test/helpers/setup-fixtures.js';
import {
	runSetupScreen,
	SetupScreen,
	terminalSetupScreen,
	type ScreenLook,
} from '../src/setup/screen.js';
import type {SetupScreenProps} from '../src/setup/setup.js';
import type {StepName, StepState} from '../src/setup/steps.js';

const ENTER = '\r';
const ESC = '\u001B';
const CTRL_C = '\u0003';
const DOWN = '\u001B[B';
const HEADING = 'The next release from here would be:';

// Ink handles each write on a later tick, so the tests pause between keys.
const sleep = async (ms: number) =>
	new Promise(resolve => setTimeout(resolve, ms));
const tick = async () => sleep(30);
/** Ink wraps long lines; on a narrow screen, a paragraph reads back with its spaces evened out. */
const flat = (text: string) => text.replaceAll(/\s+/g, ' ');

let gearz: FixtureRepo;
let single: FixtureRepo;
let detection: Detection;
let singleDetection: Detection;
beforeAll(async () => {
	gearz = await gearzLayout({template: true});
	single = await singlePackage();
	detection = await detect(gearz.dir);
	singleDetection = await detect(single.dir);
}, 30_000);

afterAll(async () => {
	await gearz.cleanup();
	await single.cleanup();
});

/** Every app a test opened, unmounted after it. */
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()!();
});

const state = (
	step: StepName,
	done: boolean,
	offered = true,
	line = `${done ? '✓' : '○'} the ${step} step`,
): StepState => ({step, done, offered, line});

/** Releases to ask about, and every per-clone step done or not offered. */
const NOTHING_ELSE: StepState[] = [
	state('releases', false),
	state('memory', true),
	state('agents', false, false),
	state('hook', true),
];

const releasing = (
	unit: string,
	from: string | null,
	version: string,
): Extract<PreviewUnit, {status: 'releases'}> => ({
	unit,
	status: 'releases',
	from,
	version,
	tag: `${unit}/v${version}`,
	bump: 'minor',
	own: 2,
	shared: 0,
	notes: [`## ${unit} ${version}`, '- ✨ Add a thing'],
});

/** web releases; mobile waits, unless shared changes release dependents. */
async function fakePreview(answers: SetupAnswers): Promise<Preview> {
	return {
		heading: HEADING,
		units:
			answers.sharedChanges === 'release-dependents'
				? [
						releasing('web', '0.1.0', '0.2.0'),
						releasing('mobile', '1.0.0', '1.1.0'),
					]
				: [
						releasing('web', '0.1.0', '0.2.0'),
						{unit: 'mobile', status: 'waits', own: 0, shared: 3},
					],
		warnings: [],
	};
}

function open(props: Partial<SetupScreenProps> & {look?: ScreenLook} = {}) {
	const onDone = vi.fn();
	const initial = props.initial ?? recommend(props.detection ?? detection);
	const app = render(
		<SetupScreen
			detection={detection}
			states={NOTHING_ELSE}
			preview={fakePreview}
			replay={async () => []}
			columns={120}
			{...props}
			initial={initial}
			onDone={onDone}
		/>,
	);
	cleanups.push(app.unmount);
	const type = async (...keys: string[]) => {
		for (const key of keys) {
			app.stdin.write(key);
			await tick();
		}
	};

	const frame = () => app.lastFrame() ?? '';
	return {...app, type, frame, onDone, initial};
}

/** The keys that move the "Change something" list from the top to question `id`. */
function toQuestion(answers: SetupAnswers, id: string): string[] {
	const index = questions(detection, answers).findIndex(
		question => question.id === id,
	);
	expect(index).toBeGreaterThan(-1);
	return Array.from({length: index}, () => DOWN);
}

test('one Enter saves every detected answer', async () => {
	const app = open({columns: 80});
	await tick();
	expect(flat(app.frame())).toContain(flat(summary(detection, app.initial)));
	await app.type(ENTER);
	expect(app.onDone).toHaveBeenCalledTimes(1);
	expect(app.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: recommend(detection),
		steps: [],
	});
});

test('the first screen shows each question that needs an answer, preselected', async () => {
	const app = open();
	await tick();
	const asked = questions(detection, app.initial).filter(
		question => question.needsAnswer,
	);
	expect(asked.map(question => question.id).sort()).toEqual(
		[
			'firstVersion:mobile',
			'firstVersion:web',
			'upstream.name',
			'zeroMajor',
		].sort(),
	);
	for (const question of asked) {
		expect(app.frame()).toContain(question.title);
		const recommended = question.options.find(option => option.recommended);
		expect(app.frame()).toContain(`› ${recommended!.label}`);
	}

	expect(app.frame()).toContain('No past releases of your own yet');
});

test('c, pick sharedChanges, pick release-dependents: the preview shows mobile releasing', async () => {
	const app = open();
	await tick();
	expect(app.frame()).toContain('web 0.1.0 → 0.2.0 (minor) web/v0.2.0');
	expect(app.frame()).toContain('waits: 3 shared changes ride along');
	await app.type('c');
	// Every question, with what chamoji found under its title.
	const all = questions(detection, app.initial);
	const sharedChanges = all.find(question => question.id === 'sharedChanges')!;
	await app.type(...toQuestion(app.initial, 'sharedChanges'));
	expect(app.frame()).toContain(sharedChanges.title);
	expect(app.frame()).toContain(sharedChanges.found);
	await app.type(ENTER);
	expect(app.frame()).toContain('It releases every app that uses it');
	await app.type(DOWN, ENTER);
	await sleep(400);
	expect(app.frame()).toContain('mobile 1.0.0 → 1.1.0 (minor) mobile/v1.1.0');
	expect(app.frame()).not.toContain('waits: 3 shared changes ride along');
	await app.type(ESC, ENTER);
	expect(app.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: expect.objectContaining({sharedChanges: 'release-dependents'}),
		steps: [],
	});
});

test('a unit with no version yet reads none → its first version', async () => {
	const app = open({
		preview: async () => ({
			heading: HEADING,
			units: [releasing('web', null, '1.0.0')],
			warnings: [],
		}),
	});
	await tick();
	expect(app.frame()).toContain('web none → 1.0.0 (minor) web/v1.0.0');
});

test('Esc on the summary cancels with nothing saved', async () => {
	const app = open();
	await tick();
	await app.type(ESC);
	expect(app.onDone).toHaveBeenCalledWith({saved: false});

	const again = open();
	await tick();
	await again.type(CTRL_C);
	expect(again.onDone).toHaveBeenCalledWith({saved: false});
});

/** The line of the preview's heading, and the last line of the first screen's last question. */
function lines(frame: string) {
	const rows = frame.split('\n');
	const asked = questions(detection, recommend(detection)).filter(
		question => question.needsAnswer,
	);
	// Its first words, which never wrap.
	const last = asked.at(-1)!.title.slice(0, 20);
	return {
		heading: rows.findIndex(row => row.includes(HEADING)),
		question: rows.findLastIndex(row => row.includes(last)),
	};
}

test('narrow terminals put the preview under the questions', async () => {
	const narrow = open({columns: 80});
	await tick();
	const under = lines(narrow.frame());
	expect(under.question).toBeGreaterThan(-1);
	expect(under.heading).toBeGreaterThan(under.question);
	narrow.unmount();

	// At 100 columns or more it sits beside them.
	const wide = open({columns: 100});
	await tick();
	const beside = lines(wide.frame());
	expect(beside.heading).toBeGreaterThan(-1);
	expect(beside.heading).toBeLessThan(beside.question);
});

test('a stale preview never replaces a newer one', async () => {
	let calls = 0;
	const preview = async (answers: SetupAnswers): Promise<Preview> => {
		calls++;
		if (calls === 1) {
			await sleep(700);
			return {
				heading: HEADING,
				units: [releasing('web', '0.1.0', '9.9.9')],
				warnings: [],
			};
		}

		return fakePreview(answers);
	};

	const app = open({preview});
	await tick();
	expect(app.frame()).toContain('…');
	await app.type('c', ...toQuestion(app.initial, 'sharedChanges'), ENTER);
	await app.type(DOWN, ENTER);
	// Until the 300 ms pass and the newer preview comes, only … shows.
	expect(app.frame()).not.toContain('9.9.9');
	await sleep(400);
	expect(calls).toBe(2);
	expect(app.frame()).toContain('mobile 1.0.0 → 1.1.0 (minor) mobile/v1.1.0');
	await sleep(400);
	expect(app.frame()).toContain('mobile 1.0.0 → 1.1.0 (minor) mobile/v1.1.0');
	expect(app.frame()).not.toContain('9.9.9');
});

test("the step prompts show only steps that aren't done, hook defaulting to No", async () => {
	const states = [
		state('releases', false),
		state('memory', false),
		state('agents', true),
		state('hook', false),
	];
	const app = open({states});
	await tick();
	expect(app.frame()).not.toContain('Share memory through origin?');
	await app.type(ENTER);
	expect(app.onDone).not.toHaveBeenCalled();
	expect(app.frame()).toContain('○ the memory step');
	expect(app.frame()).toContain('Share memory through origin? (Y/n)');
	expect(flat(app.frame())).not.toContain('Found 4 apps');
	await app.type(ENTER);
	expect(app.frame()).toContain('Install the commit composer hook? (y/N)');
	expect(app.frame()).not.toContain('Connect Claude Code here?');
	await app.type(ENTER);
	expect(app.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: app.initial,
		steps: ['memory'],
	});

	const other = open({
		states: [
			state('releases', false),
			state('memory', false),
			state('agents', false),
			state('hook', false),
		],
	});
	await tick();
	await other.type(ENTER, 'n');
	expect(other.frame()).toContain('Connect Claude Code here? (Y/n)');
	await other.type('y', 'y');
	expect(other.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: other.initial,
		steps: ['agents', 'hook'],
	});
});

test('releases with nothing to ask skip straight to the step prompts (R16)', async () => {
	const preview = vi.fn(fakePreview);
	const solo = open({
		detection: singleDetection,
		states: [
			state('releases', true),
			state('memory', false),
			state('agents', false, false),
			state('hook', true),
		],
		preview,
	});
	await tick();
	expect(solo.frame()).toContain('Share memory through origin? (Y/n)');
	expect(flat(solo.frame())).not.toContain(
		flat(summary(singleDetection, solo.initial)),
	);
	expect(solo.frame()).not.toContain(HEADING);
	expect(preview).not.toHaveBeenCalled();
	await solo.type(ENTER);
	expect(solo.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: solo.initial,
		steps: ['memory'],
	});

	// A set-up repo: releases are done, so only the hook is asked.
	const done = open({
		states: [
			state('releases', true),
			state('memory', true),
			state('agents', false, false),
			state('hook', false),
		],
	});
	await tick();
	expect(flat(done.frame())).not.toContain('Found 4 apps');
	expect(done.frame()).toContain('Install the commit composer hook? (y/N)');
	await done.type('y');
	expect(done.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: done.initial,
		steps: ['hook'],
	});
});

test('an answer core refuses shows inline and keeps the old answers', async () => {
	const app = open({columns: 80});
	await tick();
	await app.type('c', ...toQuestion(app.initial, 'name:mobile'), ENTER);
	await app.type(...'Bad Name');
	await app.type(ENTER);
	const refused = `A unit name must match ^[a-z0-9][a-z0-9._-]*$ and be unique; "Bad Name" doesn't`;
	expect(flat(app.frame())).toContain(refused);
	// Editing the answer takes the message away.
	await app.type('\u007F');
	expect(flat(app.frame())).not.toContain('A unit name must match');
	await app.type('e', ENTER);
	expect(flat(app.frame())).toContain('A unit name must match');
	await app.type('x');
	expect(flat(app.frame())).not.toContain('A unit name must match');
	await app.type(ESC, ESC, ENTER);
	expect(app.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: recommend(detection),
		steps: [],
	});
});

test('ticks toggle with Space and save with Enter', async () => {
	const app = open();
	await tick();
	// units: apps/dev-tool, apps/e2e, apps/mobile, apps/web; mobile and web ticked.
	await app.type('c', ...toQuestion(app.initial, 'units'), ENTER);
	expect(app.frame()).toContain('[x] mobile (apps/mobile)');
	expect(app.frame()).toContain('[ ] e2e (apps/e2e)');
	const options = questions(detection, app.initial).find(
		question => question.id === 'units',
	)!.options;
	const e2e = options.findIndex(option => option.value === 'apps/e2e');
	await app.type(...Array.from({length: e2e}, () => DOWN), ' ', ENTER);
	await app.type(ESC, ENTER);
	const saved = app.onDone.mock.calls[0]?.[0] as {answers: SetupAnswers};
	expect(saved.answers.units.map(unit => unit.name).sort()).toEqual([
		'e2e',
		'mobile',
		'web',
	]);
});

test('every string from the repo is stripped of control characters', async () => {
	// Escape sequences and bidi overrides, which Ink drops as well, and the
	// line and paragraph separators, which only stripControlLines takes out.
	const evil = '\u001B[2J\u001B]0;pwned\u0007\u009B31m\u202E\u2028\u2029';
	const tampered: Detection = {
		...detection,
		upstream: {...detection.upstream, remote: `up${evil}stream`},
	};
	const initial = recommend(detection);
	initial.upstream = {...initial.upstream!, name: `Make${evil}rkit`};
	const replay = async (): Promise<ReplayLine[]> => [
		{
			unit: 'web',
			tag: `web/v${evil}1.0.0`,
			version: `${evil}1.0.0`,
			shipped: 1,
			chamoji: 2,
			extra: [`ci${evil}`],
			missing: [],
		},
	];
	const preview = async (): Promise<Preview> => ({
		heading: `${HEADING}${evil}`,
		units: [
			{...releasing(`web${evil}`, '0.1.0', '0.2.0'), notes: [`- note${evil}`]},
			{unit: `mobile${evil}`, status: 'waits', own: 0, shared: 3},
		],
		warnings: [`careful${evil}`],
	});
	const app = open({
		detection: tampered,
		initial,
		preview,
		replay,
		states: [
			state('releases', false),
			state('memory', false, true, `○ memory${evil} is off`),
			state('agents', true),
			state('hook', true),
		],
	});
	await tick();
	expect(app.frame()).toContain('pwned');
	await app.type('c');
	await app.type(ESC, ENTER);
	expect(app.frame()).toContain('memory');
	for (const frame of app.frames) {
		expect(frame).not.toContain('\u001B[2J');
		expect(frame).not.toContain('\u001B]0;');
		expect(frame).not.toContain('\u0007');
		expect(frame).not.toContain('\u009B');
		expect(frame).not.toMatch(/[\u202E\u2028\u2029]/);
	}
});

test('with no animation the screen draws without the foil, and nothing moves', async () => {
	const forever = async () => new Promise<Preview>(() => {});
	const still = open({
		preview: forever,
		look: {animate: false, level: 3, ascii: false},
	});
	await sleep(200);
	const drawn = still.frames.length;
	await sleep(1400);
	expect(still.frames).toHaveLength(drawn);
	expect(still.frame()).toContain('…');
	expect(still.frame()).not.toContain('\u001B[38;2;');
	still.unmount();

	const moving = open({
		preview: forever,
		look: {animate: true, level: 3, ascii: false},
	});
	await sleep(200);
	const before = moving.frame();
	expect(before).toContain('\u001B[38;2;');
	// While the preview runs, the face looks around.
	await sleep(1400);
	expect(moving.frame()).not.toBe(before);
});

/** Just enough of a terminal for Ink, as ink-testing-library builds one. */
class FakeStdin extends EventEmitter {
	isTTY = true;
	private data: string | null = null;
	write(data: string) {
		this.data = data;
		this.emit('readable');
		this.emit('data', data);
	}

	read = () => {
		const {data} = this;
		this.data = null;
		return data;
	};

	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
}

class FakeStdout extends EventEmitter {
	isTTY = false;
	columns = 100;
	written = '';
	write = (text: string) => {
		this.written += text;
		return true;
	};
}

test('runSetupScreen mounts the screen and resolves with its result', async () => {
	const stdin = new FakeStdin();
	const stdout = new FakeStdout();
	const done = runSetupScreen(
		{
			detection,
			initial: recommend(detection),
			states: NOTHING_ELSE,
			preview: fakePreview,
			replay: async () => [],
			columns: 100,
		},
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
		},
	);
	await sleep(100);
	stdin.write(ENTER);
	expect(await done).toEqual({
		saved: true,
		answers: recommend(detection),
		steps: [],
	});
});

test('runSetupScreen waits for a preview and replay still running when it closes', async () => {
	const stdin = new FakeStdin();
	const stdout = new FakeStdout();
	let finishPreview!: () => void;
	let finishReplay!: () => void;
	const order: string[] = [];
	const done = runSetupScreen(
		{
			detection,
			initial: recommend(detection),
			states: NOTHING_ELSE,
			preview: async answers =>
				new Promise<Preview>(resolve => {
					finishPreview = () => {
						order.push('preview');
						void fakePreview(answers).then(resolve);
					};
				}),
			replay: async () =>
				new Promise<ReplayLine[]>(resolve => {
					finishReplay = () => {
						order.push('replay');
						resolve([]);
					};
				}),
			columns: 100,
		},
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
		},
	);
	void done.then(() => order.push('resolved'));
	await sleep(100);
	stdin.write(ENTER);
	await sleep(50);
	expect(order).toEqual([]);
	finishReplay();
	await sleep(20);
	expect(order).toEqual(['replay']);
	finishPreview();
	expect(await done).toMatchObject({saved: true});
	expect(order).toEqual(['replay', 'preview', 'resolved']);
});

const PROPS = (): SetupScreenProps => ({
	detection,
	initial: recommend(detection),
	states: NOTHING_ELSE,
	preview: fakePreview,
	replay: async () => [],
	columns: 100,
});

/** The real screen on a fake terminal: what it drew, what it asked and its result. */
async function onTerminal(
	env: Record<string, string | undefined>,
	answer: {r: number; g: number; b: number} | undefined,
) {
	const stdin = new FakeStdin();
	const stderr = new FakeStdout();
	stderr.isTTY = true;
	const close = vi.fn();
	const ask = vi.fn(async () => answer);
	const screen = terminalSetupScreen({
		env,
		argv: ['setup'],
		stderr: stderr as unknown as NodeJS.WriteStream,
		level: 3,
		platform: 'darwin',
		openTerminal: () => ({
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stderr as unknown as NodeJS.WriteStream,
			close,
		}),
		ask,
	});
	const done = screen(PROPS());
	await sleep(150);
	stdin.write(ENTER);
	const result = await done;
	return {result, ask, close, foil: stderr.written.includes('\u001B[38;2;')};
}

test('the terminal screen asks for the background before it draws, and wears the foil only on dark', async () => {
	const dark = await onTerminal({}, {r: 11, g: 11, b: 15});
	expect(dark.result).toMatchObject({saved: true});
	expect(dark.ask).toHaveBeenCalledTimes(1);
	expect(dark.close).toHaveBeenCalledTimes(1);
	expect(dark.foil).toBe(true);

	const light = await onTerminal({}, {r: 255, g: 255, b: 255});
	expect(light.ask).toHaveBeenCalledTimes(1);
	expect(light.foil).toBe(false);

	// CHAMOJI_THEME settles it without asking.
	const named = await onTerminal({CHAMOJI_THEME: 'dark'}, undefined);
	expect(named.ask).not.toHaveBeenCalled();
	expect(named.foil).toBe(true);

	// With no animation nothing is asked and nothing is foiled.
	for (const env of [
		{CHAMOJI_NO_ANIMATION: '1'},
		{CI: 'true'},
		{TERM: 'dumb'},
	]) {
		const still = await onTerminal(env, {r: 0, g: 0, b: 0});
		expect(still.ask).not.toHaveBeenCalled();
		expect(still.foil).toBe(false);
		expect(still.result).toMatchObject({saved: true});
	}
});

test('a newline, as an Enter pressed before raw mode reads, is Enter everywhere and never typed', async () => {
	const LF = '\n';
	const app = open({
		columns: 80,
		states: [state('releases', false), state('memory', false)],
	});
	await tick();
	// Change something: a newline opens name:mobile and then answers it,
	// without becoming part of the name.
	await app.type('c', ...toQuestion(app.initial, 'name:mobile'), LF);
	await app.type(...'phone', LF);
	await app.type(ESC, LF);
	// The memory prompt takes its default, Yes.
	expect(app.frame()).toContain('Share memory through origin? (Y/n)');
	await app.type(LF);
	expect(app.onDone).toHaveBeenCalledTimes(1);
	const saved = app.onDone.mock.calls[0]?.[0] as {
		saved: boolean;
		answers: SetupAnswers;
		steps: StepName[];
	};
	expect(saved.saved).toBe(true);
	expect(saved.steps).toEqual(['memory']);
	expect(saved.answers.units.map(unit => unit.name).sort()).toEqual([
		'phone',
		'web',
	]);
});

test('a newline on the summary saves, as Enter does', async () => {
	const app = open({columns: 80});
	await tick();
	await app.type('\n');
	expect(app.onDone).toHaveBeenCalledWith({
		saved: true,
		answers: recommend(detection),
		steps: [],
	});
});
