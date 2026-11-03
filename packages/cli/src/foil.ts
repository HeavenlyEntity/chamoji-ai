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
 * Asks the terminal for its background with OSC 11. Resolves undefined when it
 * has not answered in `timeoutMs`, so callers never wait longer than that.
 *
 * A late reply must not reach the shell, so after that limit stdin stays raw
 * and swallowed until the reply ends or a grace window passes. Raw mode and
 * the pause are undone only then.
 */
export function queryBackground(
	stdin: NodeJS.ReadStream,
	stderr: NodeJS.WriteStream,
	timeoutMs = 100,
): Promise<Rgb | undefined> {
	return new Promise(resolve => {
		const wasRaw = stdin.isRaw;
		let received = '';
		let limitTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			clearTimeout(limitTimer);
			clearTimeout(graceTimer);
			stdin.off('data', onData);
			stdin.setRawMode(wasRaw);
			stdin.pause();
		};

		const onData = (chunk: Buffer | string) => {
			received += chunk.toString();
			if (replyEnded(received)) {
				resolve(parseOscBackground(received));
				cleanup();
			}
		};

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on('data', onData);
		limitTimer = setTimeout(() => {
			resolve(undefined);
			graceTimer = setTimeout(cleanup, GRACE_MS);
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
