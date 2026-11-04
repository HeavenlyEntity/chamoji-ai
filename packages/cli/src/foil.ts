import {execFile} from 'node:child_process';
import {Chalk} from 'chalk';

export type Rgb = {r: number; g: number; b: number};
export type Theme = 'dark' | 'light';

const hex = (value: number): Rgb => ({
	r: (value >> 16) & 0xff,
	g: (value >> 8) & 0xff,
	b: value & 0xff,
});

/** The foil, in order. The last stop blends back into the first. */
export const FOIL_STOPS: readonly Rgb[] = [
	hex(0xd5_e1_cb),
	hex(0xaf_ee_e5),
	hex(0xbb_bf_f2),
	hex(0xa8_e2_f6),
	hex(0xdf_ad_e5),
	hex(0xfa_ad_c3),
	hex(0xfb_cf_b3),
];

/** The colour at `t`, cyclic over the stops: 0 is stop 0 and 1 wraps to it. */
export function foilAt(t: number): Rgb {
	const count = FOIL_STOPS.length;
	const wrapped = ((t % 1) + 1) % 1;
	const position = wrapped * count;
	const index = Math.floor(position) % count;
	const eased = (1 - Math.cos(Math.PI * (position - Math.floor(position)))) / 2;
	const from = FOIL_STOPS[index]!;
	const to = FOIL_STOPS[(index + 1) % count]!;
	const blend = (a: number, b: number) => Math.round(a + (b - a) * eased);
	return {
		r: blend(from.r, to.r),
		g: blend(from.g, to.g),
		b: blend(from.b, to.b),
	};
}

export type FoilOptions = {
	offset: number;
	spread: number;
	level: 0 | 1 | 2 | 3;
};

/** Colours each character that is not a space by its place along the foil. */
export function paintFoil(text: string, options: FoilOptions): string {
	if (options.level === 0) {
		return text;
	}

	const chalk = new Chalk({level: options.level});
	let index = 0;
	let painted = '';
	for (const character of text) {
		if (character !== ' ') {
			const {r, g, b} = foilAt(options.offset + index / options.spread);
			painted += chalk.rgb(r, g, b)(character);
		} else {
			painted += character;
		}

		index++;
	}

	return painted;
}

/** The theme named in the environment, or undefined when it names none. */
export function themeFromEnv(
	env: Record<string, string | undefined>,
): Theme | undefined {
	const named = env['CHAMOJI_THEME'];
	if (named === 'light' || named === 'dark') {
		return named;
	}

	// COLORFGBG is "foreground;background", sometimes with a middle field.
	const background = env['COLORFGBG']?.split(';').at(-1);
	if (background === undefined || !/^\d+$/.test(background)) {
		return undefined;
	}

	return background === '7' || background === '15' ? 'light' : 'dark';
}

const channel = (digits: string) =>
	Math.round((Number.parseInt(digits, 16) / (16 ** digits.length - 1)) * 255);

/** Reads an OSC 11 reply, `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by BEL or ST. */
export function parseOscBackground(reply: string): Rgb | undefined {
	const match =
		/\u001B\]11;rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})(?:\u0007|\u001B\\)/i.exec(
			reply,
		);
	if (!match) {
		return undefined;
	}

	return {
		r: channel(match[1]!),
		g: channel(match[2]!),
		b: channel(match[3]!),
	};
}

/** Whether the colour is light, by relative luminance over 0.5. */
export function isLight({r, g, b}: Rgb): boolean {
	const linear = (value: number) => {
		const unit = value / 255;
		return unit <= 0.039_28 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};

	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) > 0.5;
}

/** How long to keep swallowing input after the answer limit has passed. */
const GRACE_MS = 200;

/** Whether the reply is complete: a BEL or ST that follows `ESC ] 11 ;`. */
function replyEnded(received: string): boolean {
	const start = received.indexOf('\u001B]11;');
	if (start === -1) {
		return false;
	}

	const rest = received.slice(start);
	return rest.includes('\u0007') || rest.includes('\u001B\\');
}

/**
 * Whether this process is in the terminal's foreground process group. A
 * background job (`chamoji why f:1 &`) that changes the terminal's mode is
 * stopped by SIGTTOU, so it must never ask. `ps` marks the foreground with a
 * `+` in the STAT column. Windows has no job control, so there it is always
 * true. Anything that goes wrong counts as not in the foreground.
 */
export async function inForeground(
	pid = process.pid,
	platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
	if (platform === 'win32') {
		return true;
	}

	return new Promise(resolve => {
		try {
			execFile(
				'ps',
				['-o', 'stat=', '-p', String(pid)],
				{timeout: 1000},
				(error, stdout) => {
					resolve(!error && stdout.includes('+'));
				},
			);
		} catch {
			resolve(false);
		}
	});
}

export type QueryOptions = {
	/** Whether the process may touch the terminal's mode. */
	isForeground?: () => Promise<boolean>;
	/** Aborting ends the query at once, grace window and all. */
	signal?: AbortSignal;
	/**
	 * Called once stdin is back as it was: the reply came, the grace window
	 * passed, the query was aborted, or it never touched the terminal. Until
	 * then another program reading the terminal could get the late reply.
	 */
	onSettled?: () => void;
};

/**
 * Asks the terminal for its background with OSC 11. Resolves undefined when it
 * has not answered in `timeoutMs`, so callers never wait longer than that.
 * It never asks from a background job, and any error resolves undefined.
 *
 * A late reply must not reach the shell, so after that limit stdin stays raw
 * and swallowed until the reply ends or a grace window passes. Raw mode and
 * the pause are undone only then, or when `signal` aborts. The grace timer
 * does not keep the process alive.
 *
 * Raw mode turns Ctrl-C into a byte instead of SIGINT, so a 0x03 seen at any
 * point puts stdin back at once and calls `interrupt`, which raises SIGINT.
 */
export async function queryBackground(
	stdin: NodeJS.ReadStream,
	stderr: NodeJS.WriteStream,
	timeoutMs = 100,
	interrupt: () => void = () => {
		process.kill(process.pid, 'SIGINT');
	},
	options: QueryOptions = {},
): Promise<Rgb | undefined> {
	const {isForeground = async () => inForeground(), signal} = options;
	let settled = false;
	const settle = () => {
		if (!settled) {
			settled = true;
			options.onSettled?.();
		}
	};

	try {
		if (signal?.aborted || !(await isForeground()) || signal?.aborted) {
			settle();
			return undefined;
		}

		return await ask(stdin, stderr, timeoutMs, interrupt, signal, settle);
	} catch {
		settle();
		return undefined;
	}
}

async function ask(
	stdin: NodeJS.ReadStream,
	stderr: NodeJS.WriteStream,
	timeoutMs: number,
	interrupt: () => void,
	signal: AbortSignal | undefined,
	settle: () => void,
): Promise<Rgb | undefined> {
	return new Promise(resolve => {
		const wasRaw = stdin.isRaw;
		let received = '';
		let limitTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined;
		let done = false;

		const cleanup = () => {
			if (done) {
				return;
			}

			done = true;
			clearTimeout(limitTimer);
			clearTimeout(graceTimer);
			stdin.off('data', onData);
			signal?.removeEventListener('abort', onAbort);
			try {
				stdin.setRawMode(wasRaw);
			} catch {
				// The terminal went away. There is no mode left to put back.
			}

			stdin.pause();
			settle();
		};

		const onData = (chunk: Buffer | string) => {
			const text = chunk.toString();
			if (text.includes('\u0003')) {
				resolve(undefined);
				cleanup();
				interrupt();
				return;
			}

			received += text;
			if (replyEnded(received)) {
				resolve(parseOscBackground(received));
				cleanup();
			}
		};

		const onAbort = () => {
			resolve(undefined);
			cleanup();
		};

		// Throws, before anything changed, when stdin is not a terminal.
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on('data', onData);
		signal?.addEventListener('abort', onAbort);
		limitTimer = setTimeout(() => {
			resolve(undefined);
			graceTimer = setTimeout(cleanup, GRACE_MS);
			graceTimer.unref?.();
		}, timeoutMs);
		stderr.write('\u001B]11;?\u001B\\');
	});
}

/**
 * The theme, in order: CHAMOJI_THEME, the terminal's own answer, COLORFGBG,
 * then dark. The caller decides whether the terminal may be asked.
 */
export async function detectTheme(
	env: Record<string, string | undefined>,
	query: () => Promise<Rgb | undefined>,
): Promise<Theme> {
	const named = themeFromEnv({CHAMOJI_THEME: env['CHAMOJI_THEME']});
	if (named) {
		return named;
	}

	const background = await query();
	if (background) {
		return isLight(background) ? 'light' : 'dark';
	}

	return themeFromEnv({COLORFGBG: env['COLORFGBG']}) ?? 'dark';
}
