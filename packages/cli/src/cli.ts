#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import process from 'node:process';
import {supportsColorStderr} from 'chalk';
import {createFace} from './face.js';
import {shouldAnimate} from './face-settings.js';
import {useAscii} from './faces.js';
import {detectTheme, queryBackground} from './foil.js';
import {run, wantsFace} from './run.js';
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
// The terminal is asked for its background only then, since the question
// takes over stdin for a moment.
const face =
	shouldAnimate({
		env: process.env,
		stderrIsTTY: Boolean(process.stderr.isTTY),
		argv,
	}) && wantsFace(argv)
		? createFace({
				write: stderr,
				level: supportsColorStderr ? supportsColorStderr.level : 0,
				theme: await detectTheme(process.env, async () =>
					process.stdin.isTTY
						? queryBackground(process.stdin, process.stderr)
						: undefined,
				),
				ascii: useAscii(process.env, process.platform),
				columns: () => process.stderr.columns || 80,
			})
		: undefined;

process.exitCode = await run(argv, {
	cwd: process.cwd(),
	// The face owns the line it draws, so every write goes through it.
	stdout: face ? face.wrap(stdout) : stdout,
	stderr: face ? face.wrap(stderr) : stderr,
	face,
	updateCheck: createUpdateCheck({
		current: version,
		env: process.env,
		stderrIsTTY: Boolean(process.stderr.isTTY),
		scriptPath: process.argv[1] ?? '',
	}),
});
