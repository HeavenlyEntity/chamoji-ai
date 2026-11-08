import {execFile} from 'node:child_process';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {createRepo} from '../../core/test/helpers/fixture-repo.js';

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

test.skipIf(process.platform === 'win32')(
	"the repo's git hooks never see the npm token or the OIDC request",
	async () => {
		const repo = await createRepo([
			{
				commit: '🎉 Init',
				files: {
					'package.json': `${JSON.stringify({name: 'acme-lib', version: '1.0.0'})}\n`,
				},
			},
			{tag: 'v1.0.0', annotated: true},
			{commit: '✨ Add search', files: {'search.js': 'export {};\n'}},
		]);
		const hooks = await mkdtemp(path.join(tmpdir(), 'chamoji-hooks-'));
		try {
			const saw = path.join(hooks, 'saw');
			await writeFile(
				path.join(hooks, 'pre-commit'),
				[
					'#!/bin/sh',
					`printf '%s %s %s' "\${CHAMOJI_NPM_TOKEN:-none}" "\${ACTIONS_ID_TOKEN_REQUEST_URL:-none}" "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-none}" > '${saw}'`,
					'',
				].join('\n'),
			);
			await chmod(path.join(hooks, 'pre-commit'), 0o755);
			const git = async (...args: string[]) =>
				execFileAsync('git', args, {cwd: repo.dir});
			await git('config', 'core.hooksPath', hooks);
			await git('config', 'user.name', 'Dev');
			await git('config', 'user.email', 'dev@example.com');

			await execFileAsync(
				process.execPath,
				[cliJs, 'release', '--no-update-check'],
				{
					cwd: repo.dir,
					env: {
						...process.env,
						CHAMOJI_NPM_TOKEN: 'npm_hookSecret321',
						ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/token',
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
					},
				},
			);

			expect((await git('tag', '--list', 'v1.1.0')).stdout.trim()).toBe(
				'v1.1.0',
			);
			expect(await readFile(saw, 'utf8')).toBe('none none none');
		} finally {
			await repo.cleanup();
			await rm(hooks, {recursive: true, force: true});
		}
	},
);
