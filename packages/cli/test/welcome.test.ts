import {expect, test} from 'vitest';
import {FACES, ASCII_FACES} from '../src/faces.js';
import {LOGO_FRAMES, LOGO_HEIGHT} from '../src/logo-frames.js';
import {INTRO, playWelcome, SHORT_HELP, TAGLINE} from '../src/welcome.js';

const HIDE = '\u001B[?25l';
const SHOW = '\u001B[?25h';
const UP = `\u001B[${LOGO_HEIGHT}A\r`;
// Any colour escape: SGR sequences end in "m".
// eslint-disable-next-line no-control-regex
const SGR = /\u001B\[[\d;]*m/;

const plain = (face: keyof typeof LOGO_FRAMES) =>
	`${LOGO_FRAMES[face].join('\n')}\n`;

async function play(
	options: Partial<Parameters<typeof playWelcome>[0]> = {},
): Promise<{out: string; sleeps: number[]}> {
	let out = '';
	const sleeps: number[] = [];
	await playWelcome({
		write: text => (out += text),
		animate: true,
		level: 0,
		theme: 'dark',
		ascii: false,
		columns: 100,
		sleep: async ms => {
			sleeps.push(ms);
		},
		...options,
	});
	return {out, sleeps};
}

test('INTRO plays the faces in order for about 2.4 seconds', () => {
	expect(INTRO.map(step => step.face)).toEqual([
		'rest',
		'left',
		'right',
		'rest',
		'blink',
		'rest',
		'wink',
		'drop1',
		'drop2',
		'drop3',
		'shades',
	]);
	expect(INTRO.map(step => step.ms)).toEqual([
		400, 350, 350, 200, 120, 200, 400, 70, 70, 70, 200,
	]);
});

test('playWelcome writes the frames in INTRO order and ends on shades', async () => {
	const {out, sleeps} = await play();
	expect(out.startsWith(HIDE)).toBe(true);
	expect(out.endsWith(SHOW)).toBe(true);
	const frames = out.slice(HIDE.length, -SHOW.length).split(UP);
	expect(frames).toEqual(INTRO.map(step => plain(step.face)));
	expect(frames.at(-1)).toBe(plain('shades'));
	expect(sleeps).toEqual(INTRO.map(step => step.ms));
});

test('playWelcome moves the cursor up 8 rows between frames, and hides then shows it', async () => {
	const {out} = await play();
	expect(out.split(UP)).toHaveLength(INTRO.length);
	expect(out.split(HIDE)).toHaveLength(2);
	expect(out.split(SHOW)).toHaveLength(2);
	expect(out.indexOf(HIDE)).toBeLessThan(out.indexOf(SHOW));
});

test('playWelcome paints the foil on a colour terminal and moves it per frame', async () => {
	const {out} = await play({level: 3});
	const frames = out.slice(HIDE.length, -SHOW.length).split(UP);
	expect(frames[0]).toMatch(SGR);
	expect(frames[0]).not.toBe(frames[1]);
	// Without the escapes, a frame is the plain frame.
	// eslint-disable-next-line no-control-regex
	expect(frames[0]!.replaceAll(/\u001B\[[\d;]*m/g, '')).toBe(plain('rest'));
});

test('playWelcome not animated writes the shades frame once', async () => {
	const {out, sleeps} = await play({animate: false});
	expect(out).toBe(plain('shades'));
	expect(sleeps).toEqual([]);
});

test('playWelcome shows the cursor again when drawing throws', async () => {
	let out = '';
	await expect(
		playWelcome({
			write: text => (out += text),
			animate: true,
			level: 0,
			theme: 'dark',
			ascii: false,
			columns: 100,
			sleep: async () => {
				throw new Error('boom');
			},
		}),
	).rejects.toThrow('boom');
	expect(out.endsWith(SHOW)).toBe(true);
});

test('playWelcome shows the cursor and passes the signal on when interrupted', async () => {
	let out = '';
	const handlers = new Map<string, () => void>();
	const killed: string[] = [];
	await playWelcome({
		write: text => (out += text),
		animate: true,
		level: 0,
		theme: 'dark',
		ascii: false,
		columns: 100,
		sleep: async () => {
			// Like process.once: the handler runs a single time.
			const handler = handlers.get('SIGINT');
			handlers.delete('SIGINT');
			handler?.();
		},
		signals: {
			once: (event, fn) => {
				handlers.set(event, fn);
			},
			removeListener: (event: string) => {
				handlers.delete(event);
			},
			kill: signal => {
				killed.push(signal);
			},
		},
	});
	expect(out).toContain(SHOW);
	expect(killed).toEqual(['SIGINT']);
	expect(handlers.size).toBe(0);
});

test('Ctrl-Z during the intro shows the cursor, stops, and draws afresh after fg', async () => {
	let out = '';
	const handlers = new Map<string, () => void>();
	const killed: string[] = [];
	const emit = (event: string) => {
		const handler = handlers.get(event);
		handlers.delete(event);
		handler?.();
	};

	let sleeps = 0;
	let atStop = '';
	let afterResume = '';
	await playWelcome({
		write: text => (out += text),
		animate: true,
		level: 0,
		theme: 'dark',
		ascii: false,
		columns: 100,
		platform: 'linux',
		async sleep() {
			sleeps++;
			if (sleeps === 2) {
				emit('SIGTSTP');
				atStop = out;
				emit('SIGCONT');
				afterResume = out.slice(atStop.length);
			}
		},
		signals: {
			once: (event, fn) => {
				handlers.set(event, fn);
			},
			removeListener: (event: string) => {
				handlers.delete(event);
			},
			kill: signal => {
				killed.push(signal);
			},
		},
	});
	expect(killed).toEqual(['SIGTSTP']);
	expect(atStop.endsWith(SHOW)).toBe(true);
	expect(afterResume).toBe(HIDE);
	// The frame after fg starts on a fresh line instead of drawing over the
	// shell's "suspended" message.
	const rest = out.slice(atStop.length + HIDE.length);
	expect(rest.startsWith(UP)).toBe(false);
	expect(rest.startsWith(plain(INTRO[2]!.face))).toBe(true);
	expect(out.endsWith(SHOW)).toBe(true);
	expect(handlers.size).toBe(0);
});

test('playWelcome does not watch Ctrl-Z on Windows', async () => {
	const events: string[] = [];
	await playWelcome({
		write() {},
		animate: true,
		level: 0,
		theme: 'dark',
		ascii: false,
		columns: 100,
		platform: 'win32',
		async sleep() {},
		signals: {
			once(event) {
				events.push(event);
			},
			removeListener() {},
			kill() {},
		},
	});
	expect(events).toEqual(['SIGINT', 'SIGTERM']);
});

test('playWelcome below 70 columns writes the one-line logo', async () => {
	const {out, sleeps} = await play({columns: 69});
	expect(out).toBe(`${FACES.done} chamoji\n`);
	expect(sleeps).toEqual([]);
	const wide = await play({columns: 70});
	expect(wide.out).toContain(HIDE);
});

test('playWelcome with the ASCII set writes the one-line logo', async () => {
	const {out} = await play({ascii: true});
	expect(out).toBe(`${ASCII_FACES.done} chamoji\n`);
});

test('the one-line logo is painted on a colour terminal', async () => {
	const {out} = await play({columns: 40, level: 3});
	expect(out).toMatch(SGR);
	// eslint-disable-next-line no-control-regex
	expect(out.replaceAll(/\u001B\[[\d;]*m/g, '')).toBe(
		`${FACES.done} chamoji\n`,
	);
});

test('playWelcome on the light theme writes no colour escapes', async () => {
	for (const options of [
		{animate: true},
		{animate: false},
		{animate: true, columns: 40},
	]) {
		const {out} = await play({...options, level: 3, theme: 'light'});
		expect(out).not.toMatch(SGR);
	}
});

test('SHORT_HELP fits in 24 rows below the 8-row logo', () => {
	const lines = SHORT_HELP.split('\n');
	expect(lines.length).toBeLessThanOrEqual(24);
	for (const line of lines) {
		expect([...line].length).toBeLessThanOrEqual(80);
	}
});

test('SHORT_HELP is grouped and ends by pointing to --help', () => {
	for (const group of ['Release', 'Workstreams', 'Memory', 'Commit', 'Setup']) {
		expect(SHORT_HELP).toContain(group);
	}

	for (const command of [
		'changelog',
		'next-version',
		'release',
		'ws',
		'ws start',
		'ws switch',
		'ws ship',
		'ws drop',
		'why',
		'memory',
		'memory search',
		'memory sync',
		'commit',
		'hook install',
		'init',
		'init --agents',
		'card',
		'mcp',
	]) {
		expect(SHORT_HELP, command).toMatch(
			new RegExp(`^.{14}${command.replaceAll('-', '\\-')}[ \\n]`, 'm'),
		);
	}

	expect(SHORT_HELP.endsWith('Every option: chamoji --help')).toBe(true);
	expect(SHORT_HELP).not.toMatch(SGR);
});

test('the tagline is one plain sentence', () => {
	expect(TAGLINE).toMatch(/changelog/i);
	expect(TAGLINE).toMatch(/workstream/i);
	expect(TAGLINE).toMatch(/memory/i);
	expect(TAGLINE).not.toContain('\n');
});
