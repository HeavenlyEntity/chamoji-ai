import {access, constants, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {HookError, installHook, uninstallHook} from '../src/hook.js';
import {run} from '../src/run.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const hookFile = (dir: string) =>
	path.join(dir, '.git', 'hooks', 'prepare-commit-msg');

const GITMOJI_CLI_HOOK = `#!/bin/sh
# gitmoji as a commit hook
if npx -v >&/dev/null
then
  exec < /dev/tty
  npx -c "gitmoji --hook $1 $2"
else
  exec < /dev/tty
  gitmoji --hook $1 $2
fi
`;

async function chamoji(argv: string[], cwd: string) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
	});
	return {code, stdout, stderr};
}

test('install writes an executable prepare-commit-msg hook', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const result = await installHook(repo.dir);
	expect(result).toMatchObject({status: 'installed', replaced: null});
	const script = await readFile(hookFile(repo.dir), 'utf8');
	expect(script).toContain('# chamoji');
	expect(script).toContain('chamoji hook run "$@"');
	expect(script.trimEnd().endsWith('exit 0')).toBe(true);
	if (process.platform !== 'win32') {
		await access(hookFile(repo.dir), constants.X_OK);
	}
});

test('installing twice keeps one hook', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installHook(repo.dir);
	const first = await readFile(hookFile(repo.dir), 'utf8');
	expect(await installHook(repo.dir)).toMatchObject({replaced: 'chamoji'});
	expect(await readFile(hookFile(repo.dir), 'utf8')).toBe(first);
});

test('install replaces gitmoji-cli’s hook, so switching is one command', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(hookFile(repo.dir), GITMOJI_CLI_HOOK);
	expect(await installHook(repo.dir)).toMatchObject({replaced: 'gitmoji'});
	const script = await readFile(hookFile(repo.dir), 'utf8');
	expect(script).toContain('# chamoji');
	expect(script).not.toContain('gitmoji --hook');
});

test('install refuses to overwrite someone else’s hook', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const theirs = '#!/bin/sh\n./scripts/check-ticket.sh "$1"\n';
	await writeFile(hookFile(repo.dir), theirs);
	await expect(installHook(repo.dir)).rejects.toBeInstanceOf(HookError);
	expect(await readFile(hookFile(repo.dir), 'utf8')).toBe(theirs);

	const {code, stderr} = await chamoji(['hook', 'install'], repo.dir);
	expect(code).toBe(2);
	expect(stderr).toContain('already has a prepare-commit-msg hook');
	expect(stderr).toContain('chamoji hook run "$@"');
});

test('a lefthook hook gets lefthook’s snippet', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(
		hookFile(repo.dir),
		'#!/bin/sh\n# lefthook\ncall_lefthook run "prepare-commit-msg" "$@"\n',
	);
	const {code, stderr} = await chamoji(['hook', 'install'], repo.dir);
	expect(code).toBe(2);
	expect(stderr).toContain('lefthook.yml');
	expect(stderr).toContain('chamoji hook run {1} {2} {3}');
});

test('with core.hooksPath (husky), install writes nothing and prints the line', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await mkdir(path.join(repo.dir, '.husky', '_'), {recursive: true});
	await gitOutput(repo.dir, ['config', 'core.hooksPath', '.husky/_']);
	const result = await installHook(repo.dir);
	expect(result).toMatchObject({status: 'snippet', hooksPath: '.husky/_'});
	await expect(access(hookFile(repo.dir))).rejects.toThrow();

	const {code, stdout} = await chamoji(['hook', 'install'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('.husky/prepare-commit-msg');
	expect(stdout).toContain('chamoji hook run "$@"');
});

test('uninstall removes only chamoji’s hook', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	expect(await uninstallHook(repo.dir)).toBe(false);
	await installHook(repo.dir);
	expect(await uninstallHook(repo.dir)).toBe(true);
	await expect(access(hookFile(repo.dir))).rejects.toThrow();

	await writeFile(hookFile(repo.dir), GITMOJI_CLI_HOOK);
	expect(await uninstallHook(repo.dir)).toBe(false);
	expect(await readFile(hookFile(repo.dir), 'utf8')).toBe(GITMOJI_CLI_HOOK);
});

test('hook with no subcommand explains the choices', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const {code, stderr} = await chamoji(['hook'], repo.dir);
	expect(code).toBe(2);
	expect(stderr).toContain('install, uninstall or run');
});
