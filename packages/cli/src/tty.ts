import {closeSync, openSync} from 'node:fs';
import process from 'node:process';
import tty from 'node:tty';
import type {ComposeStreams} from './composer.js';

export type Terminal = ComposeStreams & {close(): void};

/**
 * The terminal to run the composer on. A git hook's stdin is not the
 * terminal, so this opens it directly: /dev/tty, or CONIN$ and CONOUT$ on
 * Windows. Null when there is none, as in CI or an editor's commit UI.
 */
export function openTerminal(): Terminal | null {
	if (process.stdin.isTTY && process.stdout.isTTY) {
		return {stdin: process.stdin, stdout: process.stdout, close() {}};
	}

	return openTty();
}

export function openTty(): Terminal | null {
	const [input, output] =
		process.platform === 'win32'
			? ['CONIN$', 'CONOUT$']
			: ['/dev/tty', '/dev/tty'];
	const opened: number[] = [];
	try {
		const inFd = openSync(input, 'r');
		opened.push(inFd);
		const outFd = openSync(output, 'w');
		opened.push(outFd);
		if (!tty.isatty(inFd) || !tty.isatty(outFd)) {
			throw new Error('not a terminal');
		}

		const stdin = new tty.ReadStream(inFd);
		const stdout = new tty.WriteStream(outFd);
		return {
			stdin,
			stdout,
			close() {
				stdin.destroy();
				stdout.destroy();
			},
		};
	} catch {
		for (const fd of opened) {
			try {
				closeSync(fd);
			} catch {}
		}

		return null;
	}
}
