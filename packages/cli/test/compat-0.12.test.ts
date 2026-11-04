import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import {
	buildCompatRepo,
	COMPAT_COMMANDS,
	COMPAT_REPOS,
	runCompat,
} from './helpers/compat-0.12.js';

/**
 * A repo with no `release` section must behave exactly as chamoji 0.12.0 did.
 * The golden files hold what `npx @chamoji/cli@0.12.0` printed for the same
 * repos and commands. They were captured once, with the network, by:
 *
 *   CHAMOJI_COMPAT_CAPTURE=1 npx vitest run packages/cli/test/compat-0.12.test.ts
 *
 * The test itself never touches the network.
 */
const goldenDir = fileURLToPath(
	new URL('fixtures/compat-0.12/', import.meta.url),
);
const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const capture = process.env['CHAMOJI_COMPAT_CAPTURE'] === '1';
const cli = capture
	? ['npx', '--yes', '@chamoji/cli@0.12.0']
	: [process.execPath, cliJs];

for (const repoName of Object.keys(COMPAT_REPOS)) {
	for (const [commandName, args] of Object.entries(COMPAT_COMMANDS)) {
		test(`${repoName}: ${args.join(' ')} gives what 0.12.0 gave`, async () => {
			const repo = await buildCompatRepo(repoName);
			try {
				const got = await runCompat(cli, repo, args);
				const base = path.join(goldenDir, repoName, commandName);
				if (capture) {
					await mkdir(path.dirname(base), {recursive: true});
					await writeFile(`${base}.stdout`, got.stdout);
					await writeFile(`${base}.stderr`, got.stderr);
					await writeFile(`${base}.code`, `${got.code}\n`);
					return;
				}

				expect(got.stdout).toBe(await readFile(`${base}.stdout`, 'utf8'));
				expect(got.stderr).toBe(await readFile(`${base}.stderr`, 'utf8'));
				expect(`${got.code}\n`).toBe(await readFile(`${base}.code`, 'utf8'));
			} finally {
				await repo.cleanup();
			}
		}, 60_000);
	}
}
