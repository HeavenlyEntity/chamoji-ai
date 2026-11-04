import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';

const execFileAsync = promisify(execFile);
const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
// Any colour escape: SGR sequences end in "m".
// eslint-disable-next-line no-control-regex
const SGR = /\u001B\[[\d;]*m/;

/** The `--help` header line, with colour forced on and `extra` in the env. */
async function header(extra: Record<string, string>): Promise<string> {
	const env: Record<string, string | undefined> = {
		...process.env,
		FORCE_COLOR: '3',
		...extra,
	};
	for (const name of ['COLORFGBG', 'CHAMOJI_THEME', 'NO_COLOR']) {
		if (!(name in extra)) delete env[name];
	}

	const {stdout} = await execFileAsync(process.execPath, [cliJs, '--help'], {
		env,
	});
	return stdout.split('\n')[0]!;
}

test('the --help header has no foil when nothing says the background is dark', async () => {
	// Nothing asks the terminal for --help, so it could be a light one.
	expect(await header({})).not.toMatch(SGR);
	expect(await header({COLORFGBG: '0;15'})).not.toMatch(SGR);
	expect(await header({CHAMOJI_THEME: 'light'})).not.toMatch(SGR);
});

test('the --help header has foil when CHAMOJI_THEME or COLORFGBG says dark', async () => {
	expect(await header({CHAMOJI_THEME: 'dark'})).toMatch(SGR);
	expect(await header({COLORFGBG: '15;0'})).toMatch(SGR);
});
