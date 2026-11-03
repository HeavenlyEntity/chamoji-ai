import {ASCII_FACES, FACES, IDLE_LOOP, type FaceName} from './faces.js';
import {paintFoil, type Theme} from './foil.js';

export type StepOutcome = 'ok' | 'warn' | 'fail';

export type Step = {
	update(label: string): void;
	end(outcome: StepOutcome, text: string): void;
};

export type Face = {
	step(label: string): Step;
	wrap(write: (text: string) => void): (text: string) => void;
	stop(): void;
};

export type FaceOptions = {
	/** Writes to stderr. */
	write: (text: string) => void;
	level: 0 | 1 | 2 | 3;
	theme: Theme;
	ascii: boolean;
	columns: () => number;
	clock?: {
		now(): number;
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	};
	signals?: {
		once(event: 'SIGINT' | 'SIGTERM', fn: () => void): void;
		removeListener(event: string, fn: () => void): void;
		kill(signal: string): void;
	};
};

/** A step has to run this long before its face appears. */
const DELAY_MS = 200;
/** The line is drawn again this often. */
const REDRAW_MS = 100;
/** The expression moves one place along IDLE_LOOP this often. */
const EXPRESSION_MS = 700;
/** The foil moves this far along its length on each redraw. */
const FOIL_STEP = 1 / 60;
const FOIL_SPREAD = 30;

const REDRAW = '\r\u001B[2K';
const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';
const DIM = '\u001B[2m';
const UNDIM = '\u001B[22m';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** `3s`, `1m 4s` or `1h 2m 3s`. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	}

	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}

	return `${seconds}s`;
}

/**
 * Cuts the text to `max` columns, ending in … when it had to cut. Width is
 * counted in code points: the faces and labels chamoji draws are single width.
 */
function cut(text: string, max: number): string {
	const characters = [...text];
	if (characters.length <= max) {
		return text;
	}

	if (max <= 0) {
		return '';
	}

	return `${characters.slice(0, max - 1).join('')}…`;
}

type Live = {
	label: string;
	startedAt: number;
	drawnAt: number | undefined;
	timer: ReturnType<typeof setInterval>;
};

const NO_STEP: Step = {
	update() {},
	end() {},
};

/** A face that draws nothing. Used when nothing should animate. */
export const NO_FACE: Face = {
	step: () => NO_STEP,
	wrap: write => write,
	stop() {},
};

export function createFace(options: FaceOptions): Face {
	const {write, ascii, columns} = options;
	// On the light theme the faces use the default text colour.
	const level = options.theme === 'light' ? 0 : options.level;
	const clock = options.clock ?? {
		now: () => Date.now(),
		setInterval,
		clearInterval,
	};
	const signals = options.signals ?? {
		once: (event: 'SIGINT' | 'SIGTERM', fn: () => void) => {
			process.once(event, fn);
		},
		removeListener: (event: string, fn: () => void) => {
			process.removeListener(event, fn);
		},
		kill: (signal: string) => {
			process.kill(process.pid, signal);
		},
	};
	const set = ascii ? ASCII_FACES : FACES;

	let live: Live | undefined;
	let offset = 0;
	const handlers = new Map<string, () => void>();

	const paint = (text: string) =>
		paintFoil(text, {offset, spread: FOIL_SPREAD, level});

	const installSignals = () => {
		for (const signal of SIGNALS) {
			const handler = () => {
				teardown();
				signals.kill(signal);
			};

			handlers.set(signal, handler);
			signals.once(signal, handler);
		}
	};

	const removeSignals = () => {
		for (const [signal, handler] of handlers) {
			signals.removeListener(signal, handler);
		}

		handlers.clear();
	};

	/** Stops drawing and gives the terminal back, leaving no line behind. */
	function teardown() {
		if (!live) {
			return;
		}

		clock.clearInterval(live.timer);
		const drawn = live.drawnAt !== undefined;
		live = undefined;
		if (drawn) {
			removeSignals();
			write(`${REDRAW}${SHOW_CURSOR}`);
		}
	}

	const expression = (now: number, drawnAt: number): FaceName =>
		IDLE_LOOP[Math.floor((now - drawnAt) / EXPRESSION_MS) % IDLE_LOOP.length]!;

	const draw = () => {
		if (!live || live.drawnAt === undefined) {
			return;
		}

		const now = clock.now();
		const head = `${set[expression(now, live.drawnAt)]} ${live.label}…`;
		const line = [
			...cut(`${head} ${formatElapsed(now - live.startedAt)}`, columns() - 1),
		];
		const split = [...head].length;
		const body = paint(line.slice(0, split).join(''));
		const rest = line.slice(split).join('');
		const tail = rest && level > 0 ? `${DIM}${rest}${UNDIM}` : rest;
		offset += FOIL_STEP;
		write(`${REDRAW}${body}${tail}`);
	};

	const tick = () => {
		if (!live) {
			return;
		}

		const now = clock.now();
		if (live.drawnAt === undefined) {
			if (now - live.startedAt < DELAY_MS) {
				return;
			}

			live.drawnAt = now;
			offset = 0;
			installSignals();
			write(HIDE_CURSOR);
		}

		draw();
	};

	const finish = (outcome: StepOutcome, text: string) => {
		if (!live) {
			return;
		}

		const {drawnAt, startedAt} = live;
		clock.clearInterval(live.timer);
		live = undefined;
		if (drawnAt === undefined) {
			return;
		}

		removeSignals();
		const done =
			set[outcome === 'ok' ? 'done' : outcome === 'warn' ? 'warn' : 'fail'];
		const mark = outcome === 'ok' ? '✓' : outcome === 'warn' ? '!' : '✗';
		const elapsed =
			outcome === 'ok' ? ` in ${formatElapsed(clock.now() - startedAt)}` : '';
		const line = cut(`${done} ${mark} ${text}${elapsed}`, columns() - 1);
		write(`${REDRAW}${paint(line)}\n${SHOW_CURSOR}`);
	};

	return {
		step(label) {
			// Only one step is live. The one before ends as it was.
			if (live) {
				finish('ok', live.label);
			}

			const current: Live = {
				label,
				startedAt: clock.now(),
				drawnAt: undefined,
				timer: clock.setInterval(tick, REDRAW_MS),
			};
			// A waiting step must not keep the process alive on its own.
			(current.timer as {unref?: () => void}).unref?.();
			live = current;
			return {
				update(next) {
					if (live !== current) {
						return;
					}

					current.label = next;
					draw();
				},
				end(outcome, text) {
					if (live === current) {
						finish(outcome, text);
					}
				},
			};
		},
		wrap(output) {
			return text => {
				if (!live || live.drawnAt === undefined || text === '') {
					output(text);
					return;
				}

				write(REDRAW);
				output(text);
				// The face goes on a line of its own, never after half a line.
				if (!text.endsWith('\n')) {
					write('\n');
				}

				draw();
			};
		},
		stop: teardown,
	};
}

/**
 * Runs `work` as a step. `finish` says how it ended; a throw ends it as a
 * failure with the step's own label, and is rethrown.
 */
export async function runStep<T>(
	face: Face,
	label: string,
	work: (step: Step) => Promise<T>,
	finish: (result: T) => {outcome: StepOutcome; text: string},
): Promise<T> {
	const step = face.step(label);
	try {
		const result = await work(step);
		const {outcome, text} = finish(result);
		step.end(outcome, text);
		return result;
	} catch (error) {
		step.end('fail', label);
		throw error;
	}
}
