import {isAuthFailure, quietGitEnv} from '@chamoji/core';
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
	/**
	 * The theme, or a way to find it out. A resolver is called once, when a
	 * step first draws, so a fast command never asks the terminal. Until it
	 * answers, the face draws with no colour, so foil never flashes on a light
	 * terminal. Its signal aborts when the face stops.
	 */
	theme: Theme | ((signal: AbortSignal) => Promise<Theme>);
	ascii: boolean;
	columns: () => number;
	clock?: {
		now(): number;
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	};
	signals?: {
		once(event: FaceSignal, fn: () => void): void;
		removeListener(event: string, fn: () => void): void;
		kill(signal: string): void;
	};
	/** Decides whether Ctrl-Z is watched: Windows has no job control. */
	platform?: NodeJS.Platform;
};

type FaceSignal = 'SIGINT' | 'SIGTERM' | 'SIGTSTP' | 'SIGCONT';

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
	const resolver =
		typeof options.theme === 'function' ? options.theme : undefined;
	let theme = typeof options.theme === 'function' ? undefined : options.theme;
	const stopped = new AbortController();
	// No colour until the theme is known. On the light theme the faces use the
	// default text colour.
	const level = () =>
		theme === undefined || theme === 'light' ? 0 : options.level;
	const clock = options.clock ?? {
		now: () => Date.now(),
		setInterval,
		clearInterval,
	};
	const signals = options.signals ?? {
		once: (event: FaceSignal, fn: () => void) => {
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
	const exits =
		(options.platform ?? process.platform) === 'win32'
			? (['SIGINT', 'SIGTERM'] as const)
			: (['SIGINT', 'SIGTERM', 'SIGTSTP'] as const);

	let live: Live | undefined;
	let offset = 0;
	let resolverCalled = false;
	// Whether the last wrapped text left the cursor at the start of a line.
	let atLineStart = true;
	const handlers = new Map<string, () => void>();

	const paint = (text: string) =>
		paintFoil(text, {offset, spread: FOIL_SPREAD, level: level()});

	/** Asks for the theme, once, and only if the face has not stopped. */
	const resolveTheme = () => {
		if (!resolver || resolverCalled || stopped.signal.aborted) {
			return;
		}

		resolverCalled = true;
		const asking = resolver(stopped.signal);
		asking.then(
			found => {
				// After a stop the answer may be a guess, so it is not used.
				if (!stopped.signal.aborted) {
					theme = found;
				}
			},
			() => {
				// No answer leaves the face uncoloured.
			},
		);
	};

	const listen = (signal: FaceSignal, handler: () => void) => {
		handlers.set(signal, handler);
		signals.once(signal, handler);
	};

	/**
	 * Ctrl-Z stops the process with the face mid-line and the cursor hidden.
	 * So the line is cleared and the cursor shown first, then the process
	 * stops for real: the handler is gone, so SIGTSTP does what it always
	 * does. When it carries on, the face hides the cursor and draws again.
	 */
	const suspend = () => {
		handlers.delete('SIGTSTP');
		write(`${REDRAW}${SHOW_CURSOR}`);
		listen('SIGCONT', () => {
			handlers.delete('SIGCONT');
			if (!live || live.drawnAt === undefined) {
				return;
			}

			listen('SIGTSTP', suspend);
			write(HIDE_CURSOR);
			draw();
		});
		signals.kill('SIGTSTP');
	};

	const installSignals = () => {
		for (const signal of exits) {
			if (signal === 'SIGTSTP') {
				listen(signal, suspend);
				continue;
			}

			listen(signal, () => {
				stop();
				signals.kill(signal);
			});
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
		const tail = rest && level() > 0 ? `${DIM}${rest}${UNDIM}` : rest;
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
			resolveTheme();

			installSignals();
			// Text written while the step waited may have stopped mid-line. The
			// face must not erase it, so it starts a line of its own.
			if (!atLineStart) {
				write('\n');
				atLineStart = true;
			}

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
				if (text === '') {
					output(text);
					return;
				}

				if (!live || live.drawnAt === undefined) {
					atLineStart = text.endsWith('\n');
					output(text);
					return;
				}

				write(REDRAW);
				output(text);
				// The face goes on a line of its own, never after half a line.
				if (!text.endsWith('\n')) {
					write('\n');
				}

				atLineStart = true;

				draw();
			};
		},
		stop,
	};

	/** Ends the face for good: the drawn line, and the theme question too. */
	function stop() {
		teardown();
		stopped.abort();
	}
}

/** A step that remembers its label, so a failure can name what it was doing. */
function tracked(face: Face, label: string): Step & {label: string} {
	const step = face.step(label);
	const self = {
		label,
		update(next: string) {
			self.label = next;
			step.update(next);
		},
		end(outcome: StepOutcome, text: string) {
			step.end(outcome, text);
		},
	};
	return self;
}

/**
 * Runs `work` as a step. `finish` says how it ended; a throw ends it as a
 * failure with the step's label at the time, and is rethrown.
 */
export async function runStep<T>(
	face: Face,
	label: string,
	work: (step: Step) => Promise<T>,
	finish: (result: T) => {outcome: StepOutcome; text: string},
): Promise<T> {
	const step = tracked(face, label);
	try {
		const result = await work(step);
		const {outcome, text} = finish(result);
		step.end(outcome, text);
		return result;
	} catch (error) {
		step.end('fail', step.label);
		throw error;
	}
}

/**
 * Runs a git command that talks to a remote as a step. The face redraws
 * every 100 ms and would wipe out a password prompt, so the work first gets
 * `quietGitEnv`, which makes git fail instead of asking. When it fails for
 * lack of credentials, the step ends with a warning and the work runs again
 * with no env and no face, so git can ask.
 *
 * The failed try may have done part of its work: a sync can fetch and merge
 * before its push is refused. Running it again is still safe, because each
 * of those steps is idempotent: the second fetch and merge find nothing new.
 *
 * Before the rerun the face stops, which also ends a theme question still
 * holding the terminal raw, so it can't read what is typed at git's prompt.
 *
 * With NO_FACE nothing is drawn, so the work runs once, as it always did.
 */
export async function gitStep<T>(
	face: Face,
	cwd: string,
	label: string,
	work: (env?: Record<string, string>, step?: Step) => Promise<T>,
	finish: (result: T) => {outcome: StepOutcome; text: string},
): Promise<T> {
	if (face === NO_FACE) return work(undefined);
	const env = await quietGitEnv(cwd);
	const step = tracked(face, label);
	try {
		const result = await work(env, step);
		const {outcome, text} = finish(result);
		step.end(outcome, text);
		return result;
	} catch (error) {
		if (!isAuthFailure(error)) {
			step.end('fail', step.label);
			throw error;
		}

		step.end('warn', 'git needs your credentials');
		face.stop();
	}

	return work(undefined);
}
