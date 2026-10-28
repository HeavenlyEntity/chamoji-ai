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

// --- hook run and chamoji commit, with a fake terminal ---

function fakeTerminal(message: string | null) {
	const calls: string[] = [];
	return {
		calls,
		terminal: () => ({
			async compose() {
				calls.push('compose');
				return message;
			},
			close() {
				calls.push('close');
			},
		}),
	};
}

async function withTerminal(
	argv: string[],
	cwd: string,
	terminal: () => {compose(): Promise<string | null>; close(): void} | null,
	env: Record<string, string | undefined> = {},
) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		terminal,
		env,
	});
	return {code, stdout, stderr};
}

const TEMPLATE =
	'\n# Please enter the commit message for your changes.\n#\n# Changes to be committed:\n#\tmodified:   app.ts\n';

async function messageFile(dir: string, text = TEMPLATE) {
	const file = path.join(dir, '.git', 'COMMIT_EDITMSG');
	await writeFile(file, text);
	return file;
}

test('hook run writes the composed message above git’s comments', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const file = await messageFile(repo.dir);
	const fake = fakeTerminal('🐛 (api): Fix timeout');
	const {code} = await withTerminal(
		['hook', 'run', file],
		repo.dir,
		fake.terminal,
	);
	expect(code).toBe(0);
	const written = await readFile(file, 'utf8');
	expect(written.startsWith('🐛 (api): Fix timeout\n\n# Please enter')).toBe(
		true,
	);
	expect(written).toContain('#\tmodified:   app.ts');
	expect(fake.calls).toEqual(['compose', 'close']);
});

test('hook run leaves -m, cancelled and terminal-less commits alone', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const file = await messageFile(repo.dir);

	const fromM = fakeTerminal('🐛 Nope');
	await withTerminal(
		['hook', 'run', file, 'message'],
		repo.dir,
		fromM.terminal,
	);
	expect(fromM.calls).toEqual(['close']);

	const cancelled = fakeTerminal(null);
	await withTerminal(['hook', 'run', file], repo.dir, cancelled.terminal);
	expect(cancelled.calls).toEqual(['compose', 'close']);

	const none = await withTerminal(['hook', 'run', file], repo.dir, () => null);
	expect(none.code).toBe(0);

	const ci = fakeTerminal('🐛 Nope');
	await withTerminal(['hook', 'run', file], repo.dir, ci.terminal, {
		CI: 'true',
	});
	expect(ci.calls).toEqual(['close']);

	expect(await readFile(file, 'utf8')).toBe(TEMPLATE);
});

test('hook run exits 0 and changes nothing when something goes wrong', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const file = await messageFile(repo.dir);
	const {code, stderr} = await withTerminal(
		['hook', 'run', file],
		repo.dir,
		() => ({
			async compose(): Promise<string | null> {
				throw new Error('terminal went away');
			},
			close() {},
		}),
	);
	expect(code).toBe(0);
	expect(stderr).toContain('hook skipped (terminal went away)');
	expect(await readFile(file, 'utf8')).toBe(TEMPLATE);
});

test('chamoji commit commits the composed message', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(path.join(repo.dir, 'app.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'app.ts']);
	const fake = fakeTerminal('✨ (app): Add the entry point\n\nWhy: so it runs');
	const {code} = await withTerminal(['commit'], repo.dir, fake.terminal);
	expect(code).toBe(0);
	expect(await gitOutput(repo.dir, ['log', '-1', '--format=%B'])).toBe(
		'✨ (app): Add the entry point\n\nWhy: so it runs\n\n',
	);
});

test('chamoji commit -a picks up tracked changes, and autoAdd stages everything', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(path.join(repo.dir, 'tracked.txt'), 'one\n');
	await gitOutput(repo.dir, ['add', 'tracked.txt']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Track it']);
	await writeFile(path.join(repo.dir, 'tracked.txt'), 'two\n');
	const first = await withTerminal(
		['commit', '-a'],
		repo.dir,
		fakeTerminal('🐛 Fix the count').terminal,
	);
	expect(first.code).toBe(0);
	expect(await gitOutput(repo.dir, ['status', '--porcelain'])).toBe('');

	await writeFile(path.join(repo.dir, 'new.txt'), 'new\n');
	await writeFile(path.join(repo.dir, '.gitmojirc.json'), '{"autoAdd": true}');
	const second = await withTerminal(
		['commit'],
		repo.dir,
		fakeTerminal('✨ Add the new file').terminal,
	);
	expect(second.code).toBe(0);
	expect(
		await gitOutput(repo.dir, ['show', '--name-only', '--format=', 'HEAD']),
	).toContain('new.txt');
});

test('chamoji commit needs a terminal, and cancelling commits nothing', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const none = await withTerminal(['commit'], repo.dir, () => null);
	expect(none.code).toBe(2);
	expect(none.stderr).toContain('needs a terminal');

	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	const cancelled = await withTerminal(
		['commit'],
		repo.dir,
		fakeTerminal(null).terminal,
	);
	expect(cancelled.code).toBe(1);
	expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);
});
