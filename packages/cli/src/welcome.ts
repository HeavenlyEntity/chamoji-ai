import {ASCII_FACES, FACES} from './faces.js';
import {paintFoil, type Theme} from './foil.js';
import {LOGO_FRAMES, LOGO_HEIGHT, type LogoFace} from './logo-frames.js';

/** Shown under the wordmark and at the top of `--help`. */
export const TAGLINE =
	'Changelogs, workstreams and project memory, all kept in your git history.';

const row = (group: string, command: string, text: string) =>
	`${group.padEnd(14)}${command.padEnd(23)}${text}`;

/** The help under the wordmark: one line per command, in five groups. */
export const SHORT_HELP = [
	row('Release', 'changelog', 'Write a changelog from git history'),
	row('', 'next-version', 'Print the next version'),
	row('', 'release', 'Cut a release: notes, bump, tag'),
	'',
	row('Workstreams', 'ws', 'List workstreams'),
	row('', 'ws start <title>', 'Start one and make it active'),
	row('', 'ws switch <slug>', 'Make one active'),
	row('', 'ws ship [slug]', 'Mark one shipped'),
	row('', 'ws drop [slug]', 'Mark one dropped'),
	'',
	row('Memory', 'why <file:line>', 'Why a line is there'),
	row('', 'memory', 'What past workstreams left behind'),
	row('', 'memory search <query>', 'Find commits and workstreams'),
	row('', 'memory sync', 'Merge memory with origin'),
	'',
	row('Commit', 'commit', 'Write a commit with the composer'),
	row('', 'hook install', 'Offer the composer on git commit'),
	'',
	row('Setup', 'init', 'Share memory in this clone'),
	row('', 'init --agents', 'The same, and set up Claude Code'),
	row('', 'card', "Print the URL of the repo's card"),
	row('', 'mcp', 'Serve project memory to AI agents'),
	'',
	'Every option: chamoji --help',
]
	.map(line => line.trimEnd())
	.join('\n');

/** The intro, played in order: the face to draw and how long to hold it. */
export const INTRO: readonly {face: LogoFace; ms: number}[] = [
	{face: 'rest', ms: 400},
	{face: 'left', ms: 350},
	{face: 'right', ms: 350},
	{face: 'rest', ms: 200},
	{face: 'blink', ms: 120},
	{face: 'rest', ms: 200},
	{face: 'wink', ms: 400},
	{face: 'drop1', ms: 70},
	{face: 'drop2', ms: 70},
	{face: 'drop3', ms: 70},
	{face: 'shades', ms: 200},
];

/** Below this many columns the wordmark gives way to the one-line logo. */
const MIN_COLUMNS = 70;
/** The foil runs this far along the wordmark, and along the one-line logo. */
const WORDMARK_SPREAD = 90;
const LINE_SPREAD = 30;
/** Each row starts this many columns further along, so the foil runs diagonally. */
const ROW_WEIGHT = 2.2;
/** The foil moves this far along its length on each frame. */
const FOIL_STEP = 1 / 60;

const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';
const CURSOR_UP = `\u001B[${LOGO_HEIGHT}A\r`;
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type WelcomeSignal = 'SIGINT' | 'SIGTERM' | 'SIGTSTP' | 'SIGCONT';

type Level = 0 | 1 | 2 | 3;

/** The one-line logo: the face and `chamoji`, in the foil unless it is off. */
export function oneLineLogo({
	ascii,
	level,
	theme,
}: {
	ascii: boolean;
	level: Level;
	theme: Theme;
}): string {
	const text = `${(ascii ? ASCII_FACES : FACES).done} chamoji`;
	return paintFoil(text, {
		offset: 0,
		spread: LINE_SPREAD,
		level: theme === 'light' ? 0 : level,
	});
}

export type WelcomeOptions = {
	write: (text: string) => void;
	animate: boolean;
	level: Level;
	theme: Theme;
	ascii: boolean;
	columns: number;
	/** Waits between frames; tests pass one that returns at once. */
	sleep?: (ms: number) => Promise<void>;
	signals?: {
		once(event: WelcomeSignal, fn: () => void): void;
		removeListener(event: string, fn: () => void): void;
		kill(signal: string): void;
	};
	/** Decides whether Ctrl-Z is watched: Windows has no job control. */
	platform?: NodeJS.Platform;
};

/**
 * Draws the wordmark. Animated, it plays INTRO in place and settles on the
 * shades. Not animated, it writes the shades once. Narrow or ASCII, it writes
 * the one-line logo instead. On the light theme there is no foil.
 */
export async function playWelcome(options: WelcomeOptions): Promise<void> {
	const {write, ascii, columns} = options;
	const level = options.theme === 'light' ? 0 : options.level;
	if (ascii || columns < MIN_COLUMNS) {
		write(`${oneLineLogo(options)}\n`);
		return;
	}

	const draw = (face: LogoFace, frame: number) =>
		`${LOGO_FRAMES[face]
			.map((text, index) =>
				paintFoil(text, {
					offset: frame * FOIL_STEP + (index * ROW_WEIGHT) / WORDMARK_SPREAD,
					spread: WORDMARK_SPREAD,
					level,
				}),
			)
			.join('\n')}\n`;

	if (!options.animate) {
		write(draw('shades', INTRO.length - 1));
		return;
	}

	const sleep =
		options.sleep ??
		(async (ms: number) =>
			new Promise<void>(resolve => {
				setTimeout(resolve, ms);
			}));
	const signals = options.signals ?? {
		once: (event: WelcomeSignal, fn: () => void) => {
			process.once(event, fn);
		},
		removeListener: (event: string, fn: () => void) => {
			process.removeListener(event, fn);
		},
		kill: (signal: string) => {
			process.kill(process.pid, signal);
		},
	};
	// The cursor must come back even when the user interrupts the intro.
	const handlers = new Map<string, () => void>();
	const listen = (signal: WelcomeSignal, handler: () => void) => {
		handlers.set(signal, handler);
		signals.once(signal, handler);
	};

	for (const signal of SIGNALS) {
		listen(signal, () => {
			write(SHOW_CURSOR);
			signals.kill(signal);
		});
	}

	// Whether the last frame is still right above the cursor, so the next one
	// can draw over it.
	let drawn = false;
	let finished = false;
	/**
	 * Ctrl-Z would stop the intro with the cursor hidden. So the cursor is
	 * shown first, then the process stops for real: the handler is gone, so
	 * SIGTSTP does what it always does. The shell prints below the wordmark
	 * while it is stopped, so when it carries on, the next frame starts fresh.
	 */
	const suspend = () => {
		handlers.delete('SIGTSTP');
		write(SHOW_CURSOR);
		listen('SIGCONT', () => {
			handlers.delete('SIGCONT');
			if (finished) {
				return;
			}

			drawn = false;
			write(HIDE_CURSOR);
			listen('SIGTSTP', suspend);
		});
		signals.kill('SIGTSTP');
	};

	if ((options.platform ?? process.platform) !== 'win32') {
		listen('SIGTSTP', suspend);
	}

	write(HIDE_CURSOR);
	try {
		for (const [index, step] of INTRO.entries()) {
			write((drawn ? CURSOR_UP : '') + draw(step.face, index));
			drawn = true;
			// eslint-disable-next-line no-await-in-loop
			await sleep(step.ms);
		}
	} finally {
		finished = true;
		for (const [signal, handler] of handlers) {
			signals.removeListener(signal, handler);
		}

		write(SHOW_CURSOR);
	}
}
