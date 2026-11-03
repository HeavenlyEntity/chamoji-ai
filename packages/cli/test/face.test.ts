import {tmpdir} from 'node:os';
import {expect, test, vi} from 'vitest';
import {ASCII_FACES, FACES} from '../src/faces.js';
import {
	createFace,
	formatElapsed,
	gitStep,
	NO_FACE,
	runStep,
	type FaceOptions,
	type Step,
} from '../src/face.js';
import {recordingFace} from './helpers/recording-face.js';

const CLEAR = '\u001B[2K';
const HIDE = '\u001B[?25l';
const SHOW = '\u001B[?25h';
const REDRAW = `\r${CLEAR}`;
// Any colour or dim escape: SGR sequences end in "m".
// eslint-disable-next-line no-control-regex
const SGR = /\u001B\[[\d;]*m/;

/** A clock that only moves when the test says so. */
function fakeClock() {
	let time = 0;
	let nextId = 1;
	const timers = new Map<
		number,
		{run: () => void; every: number; due: number}
	>();
	return {
		now: () => time,
		setInterval: ((run: () => void, every: number) => {
			const id = nextId++;
			timers.set(id, {run, every, due: time + every});
			return id;
		}) as unknown as typeof setInterval,
		clearInterval: ((id: number) => {
			timers.delete(id);
		}) as unknown as typeof clearInterval,
		advance(ms: number) {
			const target = time + ms;
			for (;;) {
				const next = [...timers.values()]
					.filter(timer => timer.due <= target)
					.sort((a, b) => a.due - b.due)[0];
				if (!next) {
					break;
				}

				time = next.due;
				next.due += next.every;
				next.run();
			}

			time = target;
		},
		get timers() {
			return timers.size;
		},
	};
}

function fakeSignals() {
	const listeners = new Map<string, () => void>();
	return {
		once: (event: string, run: () => void) => {
			listeners.set(event, run);
		},
		removeListener: (event: string, run: () => void) => {
			if (listeners.get(event) === run) {
				listeners.delete(event);
			}
		},
		kill: vi.fn<(signal: string) => void>(),
		listeners,
		emit(event: string) {
			listeners.get(event)?.();
		},
	};
}

function setup(options: Partial<FaceOptions> = {}) {
	const clock = fakeClock();
	const signals = fakeSignals();
	const writes: string[] = [];
	const face = createFace({
		write: text => writes.push(text),
		level: 0,
		theme: 'dark',
		ascii: false,
		columns: () => 80,
		clock,
		signals,
		...options,
	});
	return {face, clock, signals, writes, out: () => writes.join('')};
}

/** The text of the last line drawn, with the redraw escape removed. */
function lastFrame(writes: string[]): string {
	const frame = writes.findLast(text => text.startsWith(REDRAW)) ?? '';
	return frame.slice(REDRAW.length);
}

test('formatElapsed counts seconds, minutes and hours', () => {
	expect(formatElapsed(0)).toBe('0s');
	expect(formatElapsed(3400)).toBe('3s');
	expect(formatElapsed(64_000)).toBe('1m 4s');
	expect(formatElapsed(3_723_000)).toBe('1h 2m 3s');
});

test('a step under 200 ms writes nothing', () => {
	const {face, clock, writes, signals} = setup();
	const step = face.step('Syncing memory');
	clock.advance(199);
	step.end('ok', 'Synced memory');
	expect(writes).toEqual([]);
	expect(signals.listeners.size).toBe(0);
	expect(clock.timers).toBe(0);
});

test('a step over 200 ms draws', () => {
	const {face, clock, writes} = setup();
	face.step('Syncing memory');
	clock.advance(199);
	expect(writes).toEqual([]);
	clock.advance(1);
	expect(writes.filter(text => text === HIDE)).toHaveLength(1);
	expect(writes.some(text => text.startsWith(REDRAW))).toBe(true);
	expect(lastFrame(writes)).toBe('( •‿• ) Syncing memory… 0s');
	clock.advance(1000);
	expect(writes.filter(text => text === HIDE)).toHaveLength(1);
});

test('the line redraws every 100 ms and the expression follows IDLE_LOOP', () => {
	const {face, clock, writes} = setup();
	face.step('Working');
	clock.advance(200);
	const first = writes.length;
	clock.advance(300);
	expect(writes.length - first).toBe(3);
	// The drawn time keeps counting.
	expect(lastFrame(writes)).toBe('( •‿• ) Working… 0s');
	clock.advance(700);
	expect(lastFrame(writes)).toBe('( •‿• ) Working… 1s');

	// Drawn at 200 ms. The expression moves on every 700 ms after that: the
	// second is rest, the third (1400 ms in, so 1600 ms) is left, the fourth rest.
	clock.advance(300);
	expect(clock.now()).toBe(1500);
	expect(lastFrame(writes).startsWith(FACES.rest)).toBe(true);
	clock.advance(100);
	expect(clock.now()).toBe(1600);
	expect(lastFrame(writes).startsWith(FACES.left)).toBe(true);
	clock.advance(600);
	expect(lastFrame(writes).startsWith(FACES.left)).toBe(true);
	clock.advance(100);
	expect(clock.now()).toBe(2300);
	expect(lastFrame(writes).startsWith(FACES.rest)).toBe(true);
});

test('end ok leaves the done line', () => {
	const {face, clock, writes, signals} = setup();
	const step = face.step('Syncing memory');
	clock.advance(4000);
	writes.length = 0;
	step.end('ok', 'Synced memory');
	expect(writes.join('')).toBe(
		`${REDRAW}( ■‿■ ) ✓ Synced memory in 4s\n${SHOW}`,
	);
	expect(signals.listeners.size).toBe(0);
	expect(clock.timers).toBe(0);
	// Ending twice does nothing more.
	step.end('ok', 'again');
	expect(writes).toHaveLength(1);
});

test('end warn and end fail leave their lines', () => {
	const warn = setup();
	const warned = warn.face.step('Syncing memory');
	warn.clock.advance(300);
	warn.writes.length = 0;
	warned.end('warn', 'Memory is stale');
	expect(warn.out()).toBe(`${REDRAW}( •_• ) ! Memory is stale\n${SHOW}`);

	const fail = setup();
	const failed = fail.face.step('Syncing memory');
	fail.clock.advance(300);
	fail.writes.length = 0;
	failed.end('fail', 'Syncing memory');
	expect(fail.out()).toBe(`${REDRAW}( ;_; ) ✗ Syncing memory\n${SHOW}`);
});

test('update changes the label in place', () => {
	const {face, clock, writes} = setup();
	const step = face.step('Syncing memory');
	clock.advance(300);
	step.update('Reading notes');
	expect(lastFrame(writes)).toContain('Reading notes… ');
	expect(lastFrame(writes)).not.toContain('Syncing memory');
	clock.advance(100);
	expect(lastFrame(writes)).toContain('Reading notes… ');
});

test('update before the first draw changes what is drawn first', () => {
	const {face, clock, writes} = setup();
	const step = face.step('Syncing memory');
	step.update('Reading notes');
	expect(writes).toEqual([]);
	clock.advance(200);
	expect(lastFrame(writes)).toBe('( •‿• ) Reading notes… 0s');
});

test('a new step ends the live one as ok with its last label', () => {
	const {face, clock, writes} = setup();
	const first = face.step('Reading notes');
	clock.advance(400);
	writes.length = 0;
	const second = face.step('Writing notes');
	expect(writes.join('')).toBe(
		`${REDRAW}( ■‿■ ) ✓ Reading notes in 0s\n${SHOW}`,
	);
	// The first step is over; it cannot draw or end again.
	first.update('ignored');
	first.end('fail', 'ignored');
	expect(writes).toHaveLength(1);
	clock.advance(200);
	expect(lastFrame(writes)).toBe('( •‿• ) Writing notes… 0s');
	second.end('ok', 'Wrote notes');
});

test('wrap clears the face line, writes the text, and redraws the face after it', () => {
	const {face, clock, writes} = setup();
	const out: string[] = [];
	const wrapped = face.wrap(text => out.push(text));
	// Nothing drawn: a plain write, and nothing else.
	wrapped('before\n');
	expect(out).toEqual(['before\n']);
	expect(writes).toEqual([]);

	face.step('Syncing memory');
	clock.advance(300);
	writes.length = 0;
	out.length = 0;
	wrapped('line\n');
	expect(out).toEqual(['line\n']);
	expect(writes[0]).toBe(REDRAW);
	expect(writes.at(-1)).toBe(`${REDRAW}( •‿• ) Syncing memory… 0s`);
	expect(writes).toHaveLength(2);

	// Text that stops mid-line gets a fresh line, so the face never lands on it.
	writes.length = 0;
	out.length = 0;
	wrapped('partial');
	expect(out).toEqual(['partial']);
	expect(writes[0]).toBe(REDRAW);
	expect(writes[1]).toBe('\n');
	expect(writes.at(-1)).toContain('Syncing memory');
});

test('the first draw starts a new line after text that stopped mid-line', () => {
	const {face, clock, writes} = setup();
	const out: string[] = [];
	const wrapped = face.wrap(text => out.push(text));
	face.step('Syncing memory');
	clock.advance(100);
	wrapped('Checking… ');
	expect(writes).toEqual([]);
	clock.advance(100);
	expect(out).toEqual(['Checking… ']);
	expect(writes[0]).toBe('\n');
	expect(writes[1]).toBe(HIDE);
	expect(writes[2]?.startsWith(REDRAW)).toBe(true);

	// Text that ended its line needs no extra one.
	const whole = setup();
	const wrappedWhole = whole.face.wrap(() => {});
	whole.face.step('Syncing memory');
	wrappedWhole('Checking…\n');
	whole.clock.advance(200);
	expect(whole.writes[0]).toBe(HIDE);
});

test('wrap passes text through once the step has ended', () => {
	const {face, clock, writes} = setup();
	const out: string[] = [];
	const wrapped = face.wrap(text => out.push(text));
	const step = face.step('Syncing memory');
	clock.advance(300);
	step.end('ok', 'Synced memory');
	writes.length = 0;
	wrapped('after\n');
	expect(out).toEqual(['after\n']);
	expect(writes).toEqual([]);
});

test('a long label is cut to columns − 1 with …', () => {
	const {face, clock, writes} = setup({columns: () => 20});
	face.step('A label that is much too long to fit');
	clock.advance(200);
	const line = lastFrame(writes);
	expect([...line]).toHaveLength(19);
	expect(line.endsWith('…')).toBe(true);
	expect(line.startsWith('( •‿• ) A label')).toBe(true);
});

test('a line that fits is not cut', () => {
	const {face, clock, writes} = setup({columns: () => 28});
	face.step('Syncing memory');
	clock.advance(200);
	// 26 columns in a 28 column terminal: room to spare.
	expect(lastFrame(writes)).toBe('( •‿• ) Syncing memory… 0s');
	const tight = setup({columns: () => 28});
	tight.face.step('Syncing memory!!');
	tight.clock.advance(200);
	expect([...lastFrame(tight.writes)]).toHaveLength(27);
	expect(lastFrame(tight.writes).endsWith('…')).toBe(true);
});

test('level 0 writes no colour escapes', () => {
	const {face, clock, out} = setup({level: 0});
	const step = face.step('Syncing memory');
	clock.advance(500);
	step.end('ok', 'Synced memory');
	expect(out()).not.toMatch(SGR);
	expect(out()).not.toContain('\u001B[2m');
});

test('the light theme writes no colour escapes', () => {
	const {face, clock, out} = setup({level: 3, theme: 'light'});
	const step = face.step('Syncing memory');
	clock.advance(500);
	step.end('warn', 'Careful');
	expect(out()).toContain('Syncing memory');
	expect(out()).not.toMatch(SGR);
});

test('colour paints the face and label and dims the elapsed time', () => {
	const {face, clock, writes} = setup({level: 3});
	face.step('Syncing memory');
	clock.advance(200);
	const frame = lastFrame(writes);
	expect(frame).toMatch(/\u001B\[38;2;\d+;\d+;\d+m\(/);
	expect(frame.endsWith('\u001B[2m 0s\u001B[22m')).toBe(true);
	// The foil moves a little each redraw.
	const before = frame;
	clock.advance(100);
	expect(lastFrame(writes)).not.toBe(before);
});

test('the ASCII set is used when ascii is true', () => {
	const {face, clock, writes} = setup({ascii: true});
	const step = face.step('Syncing memory');
	clock.advance(200);
	expect(lastFrame(writes).startsWith(ASCII_FACES.rest)).toBe(true);
	writes.length = 0;
	step.end('ok', 'Synced memory');
	expect(writes.join('')).toContain(`${ASCII_FACES.done} ✓ Synced memory`);
});

test('signal handlers are installed only while drawn', () => {
	const {face, clock, signals} = setup();
	const step = face.step('Syncing memory');
	expect(signals.listeners.size).toBe(0);
	clock.advance(200);
	expect([...signals.listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
	step.end('ok', 'Synced memory');
	expect(signals.listeners.size).toBe(0);
});

test('SIGINT while drawn clears the line, shows the cursor, removes its listener and re-raises SIGINT', () => {
	const {face, clock, writes, signals} = setup();
	face.step('Syncing memory');
	clock.advance(300);
	writes.length = 0;
	signals.emit('SIGINT');
	expect(writes.join('')).toBe(`${REDRAW}${SHOW}`);
	expect(signals.listeners.size).toBe(0);
	expect(signals.kill).toHaveBeenCalledExactlyOnceWith('SIGINT');
	// Nothing keeps drawing afterwards.
	expect(clock.timers).toBe(0);
	clock.advance(1000);
	expect(writes.join('')).toBe(`${REDRAW}${SHOW}`);
});

test('SIGTERM re-raises SIGTERM', () => {
	const {face, clock, signals} = setup();
	face.step('Syncing memory');
	clock.advance(300);
	signals.emit('SIGTERM');
	expect(signals.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
	expect(signals.listeners.size).toBe(0);
});

test('stop clears a drawn face without an ending line', () => {
	const {face, clock, writes, signals} = setup();
	face.step('Syncing memory');
	clock.advance(300);
	writes.length = 0;
	face.stop();
	expect(writes.join('')).toBe(`${REDRAW}${SHOW}`);
	expect(signals.listeners.size).toBe(0);
	expect(clock.timers).toBe(0);
	face.stop();
	expect(writes).toHaveLength(1);
});

test('stop before the first draw writes nothing', () => {
	const {face, clock, writes} = setup();
	face.step('Syncing memory');
	clock.advance(100);
	face.stop();
	clock.advance(1000);
	expect(writes).toEqual([]);
});

test('NO_FACE draws nothing and wrap returns the same function', () => {
	const write = (_text: string) => {};
	expect(NO_FACE.wrap(write)).toBe(write);
	const step = NO_FACE.step('Syncing memory');
	step.update('Still syncing');
	step.end('ok', 'Synced memory');
	NO_FACE.stop();
});

test('runStep ends a finished step with what finish says', async () => {
	const {face, clock, writes} = setup();
	const result = await runStep(
		face,
		'Syncing memory',
		async step => {
			clock.advance(2000);
			step.update('Almost');
			return 3;
		},
		count => ({outcome: 'ok', text: `Synced ${count} notes`}),
	);
	expect(result).toBe(3);
	expect(writes.join('')).toContain('( ■‿■ ) ✓ Synced 3 notes in 2s\n');
});

test('runStep ends a thrown step as fail with its label and rethrows', async () => {
	const {face, clock, out} = setup();
	const boom = new Error('boom');
	let seen: Step | undefined;
	await expect(
		runStep(
			face,
			'Syncing memory',
			async step => {
				seen = step;
				clock.advance(500);
				throw boom;
			},
			() => ({outcome: 'ok', text: 'unused'}),
		),
	).rejects.toBe(boom);
	expect(seen).toBeDefined();
	expect(out()).toContain(`( ;_; ) ✗ Syncing memory\n${SHOW}`);
	expect(out()).not.toContain('unused');
});

test('runStep with NO_FACE just runs the work', async () => {
	const result = await runStep(
		NO_FACE,
		'Syncing memory',
		async () => 'done',
		value => ({outcome: 'ok', text: value}),
	);
	expect(result).toBe('done');
});

test('runStep ends a thrown step as fail with the label it had when it threw', async () => {
	const {face, calls} = recordingFace();
	await expect(
		runStep(
			face,
			'Syncing memory with origin',
			async step => {
				step.update('Pushing memory to origin');
				throw new Error('rejected');
			},
			() => ({outcome: 'ok', text: 'unused'}),
		),
	).rejects.toThrow('rejected');
	expect(calls.at(-1)).toEqual(['end', 'fail', 'Pushing memory to origin']);
});

const authError = () =>
	Object.assign(new Error('Could not fetch memory from origin'), {
		stderr: 'fatal: could not read Username for https://example.com',
	});

test('gitStep runs the work once with the quiet env when it works', async () => {
	const {face, calls} = recordingFace();
	const seen: Array<Record<string, string> | undefined> = [];
	const result = await gitStep(
		face,
		tmpdir(),
		'Pushing memory to origin',
		async env => {
			seen.push(env);
			return 2;
		},
		count => ({outcome: 'ok', text: `Pushed ${count}`}),
	);
	expect(result).toBe(2);
	expect(seen).toHaveLength(1);
	expect(seen[0]).toMatchObject({GIT_TERMINAL_PROMPT: '0'});
	expect(calls).toEqual([
		['step', 'Pushing memory to origin'],
		['end', 'ok', 'Pushed 2'],
	]);
});

test('gitStep reruns without the quiet env after an auth failure', async () => {
	const {face, calls} = recordingFace();
	const seen: Array<Record<string, string> | undefined> = [];
	const result = await gitStep(
		face,
		tmpdir(),
		"Fetching origin's memory",
		async env => {
			seen.push(env);
			if (env) throw authError();
			return 'fetched';
		},
		() => ({outcome: 'ok', text: 'unused'}),
	);
	expect(result).toBe('fetched');
	expect(seen).toHaveLength(2);
	expect(seen[0]).toMatchObject({GIT_TERMINAL_PROMPT: '0'});
	expect(seen[1]).toBeUndefined();
	// The rerun has no face, so the prompt it may show is never drawn over.
	expect(calls).toEqual([
		['step', "Fetching origin's memory"],
		['end', 'warn', 'git needs your credentials'],
	]);
});

test('gitStep ends any other failure as fail and rethrows, with no rerun', async () => {
	const {face, calls} = recordingFace();
	let runs = 0;
	await expect(
		gitStep(
			face,
			tmpdir(),
			'Pushing memory to origin',
			async () => {
				runs++;
				throw new Error('remote rejected');
			},
			() => ({outcome: 'ok', text: 'unused'}),
		),
	).rejects.toThrow('remote rejected');
	expect(runs).toBe(1);
	expect(calls).toEqual([
		['step', 'Pushing memory to origin'],
		['end', 'fail', 'Pushing memory to origin'],
	]);
});

test('gitStep passes the step on, so the work can relabel it', async () => {
	const {face, calls} = recordingFace();
	await gitStep(
		face,
		tmpdir(),
		'Syncing memory with origin',
		async (_env, step) => {
			step?.update('Merging memory');
		},
		() => ({outcome: 'ok', text: 'Synced'}),
	);
	expect(calls).toContainEqual(['update', 'Merging memory']);
});

test('gitStep with NO_FACE runs the work once with no env, as before', async () => {
	const seen: Array<Record<string, string> | undefined> = [];
	const result = await gitStep(
		NO_FACE,
		tmpdir(),
		'Pushing memory to origin',
		async env => {
			seen.push(env);
			return 'pushed';
		},
		() => ({outcome: 'ok', text: 'unused'}),
	);
	expect(result).toBe('pushed');
	expect(seen).toEqual([undefined]);
});
