#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import process from 'node:process';
import {supportsColor, supportsColorStderr} from 'chalk';
import {createFace} from './face.js';
import {shouldAnimate} from './face-settings.js';
import {useAscii} from './faces.js';
import {detectTheme, queryBackground, themeFromEnv} from './foil.js';
import {run, showsLogo, wantsFace, type WelcomeSettings} from './run.js';
import {terminalSetupScreen} from './setup/screen.js';
import {openTerminal} from './tty.js';
import {createUpdateCheck} from './update-check.js';

const {version} = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string};

const argv = process.argv.slice(2);
const stdout = (text: string) => {
	process.stdout.write(text);
};

const stderr = (text: string) => {
	process.stderr.write(text);
};

// A face only for a command that can wait, and only where it may animate.
// CHAMOJI_THEME settles the theme at once. Otherwise the terminal is asked
// only when a step first draws, past its 200 ms delay, since the question
// takes over stdin for a moment. A fast command never touches stdin, and
// nothing waits on the answer: the face draws uncoloured until it comes.
const named = themeFromEnv({CHAMOJI_THEME: process.env['CHAMOJI_THEME']});
const face =
	shouldAnimate({
		env: process.env,
		stderrIsTTY: Boolean(process.stderr.isTTY),
		argv,
	}) && wantsFace(argv)
		? createFace({
				write: stderr,
				level: supportsColorStderr ? supportsColorStderr.level : 0,
				theme:
					named ??
					(async (signal, settled) =>
						detectTheme(process.env, async () => {
							if (!process.stdin.isTTY) {
								settled();
								return undefined;
							}

							return queryBackground(
								process.stdin,
								process.stderr,
								undefined,
								undefined,
								{signal, onSettled: settled},
							);
						})),
				ascii: useAscii(process.env, process.platform),
				columns: () => process.stderr.columns || 80,
			})
		: undefined;

// How the wordmark and the logo draw. They go to stdout, so the colour comes
// from stdout, and the intro plays only when stdout is a terminal and none of
// the "nothing animates" conditions hold (shouldAnimate wants a stream flag,
// and here that is stdout's). A bare `chamoji` is the only command that plays
// it, and the terminal is asked for its background only then, up front, as
// the intro starts at once. With nothing to play, as for the `--help` header,
// nothing asks, so the foil shows only where the environment says the
// background is dark.
const stdoutIsTTY = Boolean(process.stdout.isTTY);
const welcome: WelcomeSettings | undefined = showsLogo(argv)
	? await (async () => {
			const animate =
				argv.length === 0 &&
				shouldAnimate({env: process.env, stderrIsTTY: stdoutIsTTY, argv});
			const level = supportsColor ? supportsColor.level : 0;
			const settings = {
				animate,
				ascii: useAscii(process.env, process.platform),
				columns: process.stdout.columns || 80,
			};
			if (!animate) {
				const known = themeFromEnv(process.env);
				return {
					...settings,
					level: known === 'dark' ? level : 0,
					theme: known ?? 'dark',
				};
			}

			return {
				...settings,
				level,
				theme: await detectTheme(process.env, async () =>
					process.stdin.isTTY
						? queryBackground(process.stdin, process.stdout)
						: undefined,
				),
			};
		})()
	: undefined;

process.exitCode = await run(argv, {
	cwd: process.cwd(),
	// The face owns the line it draws, so every write goes through it.
	stdout: face ? face.wrap(stdout) : stdout,
	stderr: face ? face.wrap(stderr) : stderr,
	face,
	welcome,
	updateCheck: createUpdateCheck({
		current: version,
		env: process.env,
		stderrIsTTY: Boolean(process.stderr.isTTY),
		scriptPath: process.argv[1] ?? '',
	}),
	setupScreen: terminalSetupScreen({
		env: process.env,
		argv,
		stderr: process.stderr,
		level: supportsColorStderr ? supportsColorStderr.level : 0,
		platform: process.platform,
		openTerminal,
	}),
});
