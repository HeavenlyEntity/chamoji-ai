import {
	access,
	chmod,
	constants,
	mkdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {
	HookError,
	installHook,
	readHookState,
	uninstallHook,
} from '../src/hook.js';
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

async function writeExecutable(file: string, script: string) {
	await writeFile(file, script);
	await chmod(file, 0o755);
}

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

test('hook state: no hook is missing, and chamoji’s own is installed', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	expect(await readHookState(repo.dir)).toBe('missing');
	await installHook(repo.dir);
	expect(await readHookState(repo.dir)).toBe('installed');
});

test('hook state follows the hook git runs from a subdirectory too', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installHook(repo.dir);
	const sub = path.join(repo.dir, 'packages', 'app');
	await mkdir(sub, {recursive: true});
	expect(await readHookState(sub)).toBe('installed');
});

test('hook state: a hook git would skip for not being executable is missing', async () => {
	if (process.platform === 'win32') return;
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installHook(repo.dir);
	await chmod(hookFile(repo.dir), 0o644);
	expect(await readHookState(repo.dir)).toBe('missing');
});

test('hook state: gitmoji-cli’s hook never stamps, so it is missing', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeExecutable(hookFile(repo.dir), GITMOJI_CLI_HOOK);
	expect(await readHookState(repo.dir)).toBe('missing');
});

test('hook state: a hook that doesn’t show chamoji is unknown, as it may call it', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeExecutable(
		hookFile(repo.dir),
		'#!/bin/sh\n./scripts/check-ticket.sh "$1"\n',
	);
	expect(await readHookState(repo.dir)).toBe('unknown');
});

test('hook state: npx and package-name calls of chamoji count as installed', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeExecutable(
		hookFile(repo.dir),
		'#!/bin/sh\nnpx --yes @chamoji/cli hook run "$@"\n',
	);
	expect(await readHookState(repo.dir)).toBe('installed');
});

test('hook state with husky v9 reads the script in .husky, not the stub in .husky/_', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await mkdir(path.join(repo.dir, '.husky', '_'), {recursive: true});
	await gitOutput(repo.dir, ['config', 'core.hooksPath', '.husky/_']);
	await writeExecutable(
		path.join(repo.dir, '.husky', '_', 'prepare-commit-msg'),
		'#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
	);
	expect(await readHookState(repo.dir)).toBe('missing');

	await writeFile(
		path.join(repo.dir, '.husky', 'prepare-commit-msg'),
		'chamoji hook run "$@"\n',
	);
	expect(await readHookState(repo.dir)).toBe('installed');
});

test('hook state with an older husky reads the script core.hooksPath points at', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await mkdir(path.join(repo.dir, '.husky'));
	await gitOutput(repo.dir, ['config', 'core.hooksPath', '.husky']);
	expect(await readHookState(repo.dir)).toBe('missing');

	await writeExecutable(
		path.join(repo.dir, '.husky', 'prepare-commit-msg'),
		'#!/bin/sh\nchamoji hook run "$@"\n',
	);
	expect(await readHookState(repo.dir)).toBe('installed');
});

test('hook state with lefthook reads lefthook’s config, since its hook is generated', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeExecutable(
		hookFile(repo.dir),
		'#!/bin/sh\n# lefthook\ncall_lefthook run "prepare-commit-msg" "$@"\n',
	);
	// Lefthook writes this hook for its own use even when no config asks for it.
	expect(await readHookState(repo.dir)).toBe('unknown');

	await writeFile(
		path.join(repo.dir, 'lefthook.yml'),
		'pre-commit:\n  commands:\n    lint:\n      run: pnpm lint\n',
	);
	expect(await readHookState(repo.dir)).toBe('unknown');

	await mkdir(path.join(repo.dir, '.config'));
	await writeFile(
		path.join(repo.dir, '.config', 'lefthook.yml'),
		'prepare-commit-msg:\n  commands:\n    chamoji:\n      run: chamoji hook run {1} {2} {3}\n      interactive: true\n',
	);
	expect(await readHookState(repo.dir)).toBe('installed');
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

// --- Jev's advice, wired into commit and hook run ---

function capturingTerminal(message: string | null) {
	const seen: Array<Promise<unknown> | undefined> = [];
	return {
		seen,
		terminal: () => ({
			async compose(_config: unknown, advice?: Promise<unknown>) {
				seen.push(advice);
				return message;
			},
			close() {},
		}),
	};
}

const ADVICE = {
	gitmojis: [{code: 'sparkles', probability: 0.9}],
	breaking: 0.1,
	split: 0.1,
};

async function withAdvisor(
	argv: string[],
	cwd: string,
	terminal: () => unknown,
	advise: (input: unknown) => Promise<unknown>,
) {
	return run(argv, {
		cwd,
		stdout() {},
		stderr() {},
		terminal: terminal as never,
		env: {},
		advise: advise as never,
	});
}

test('with chamoji.composer on in git config, the composer gets advice on the staged change', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await gitOutput(repo.dir, ['config', 'chamoji.composer', 'true']);
	await writeFile(path.join(repo.dir, 'export.ts'), 'export {};\n');
	await writeFile(path.join(repo.dir, '.env'), 'TOKEN=shh\n');
	await gitOutput(repo.dir, ['add', '-A']);
	const inputs: unknown[] = [];
	const capture = capturingTerminal('✨ Add export');
	const code = await withAdvisor(
		['commit'],
		repo.dir,
		capture.terminal,
		async input => {
			inputs.push(input);
			return ADVICE;
		},
	);
	expect(code).toBe(0);
	expect(await capture.seen[0]).toEqual(ADVICE);
	const {staged} = inputs[0] as {
		staged: {files: Array<{path: string}>; withheld: number};
	};
	expect(staged.files.map(file => file.path)).toEqual(['export.ts']);
	expect(staged.withheld).toBe(1);
	expect(JSON.stringify(inputs)).not.toContain('shh');
});

test('hook run passes the draft title to the advisor', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await gitOutput(repo.dir, ['config', 'chamoji.composer', 'true']);
	await writeFile(path.join(repo.dir, 'export.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', '-A']);
	const file = await messageFile(repo.dir, `add the export\n${TEMPLATE}`);
	const inputs: unknown[] = [];
	const capture = capturingTerminal(null);
	await withAdvisor(
		['hook', 'run', file],
		repo.dir,
		capture.terminal,
		async input => {
			inputs.push(input);
			return ADVICE;
		},
	);
	await capture.seen[0];
	expect(inputs[0]).toMatchObject({draft: 'add the export'});
});

test('without the git config there is no advice, and a failing advisor means none', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', '-A']);
	const off = capturingTerminal(null);
	const advise = vi.fn(async () => ADVICE);
	await withAdvisor(['commit'], repo.dir, off.terminal, advise);
	expect(off.seen[0]).toBeUndefined();
	expect(advise).not.toHaveBeenCalled();

	await gitOutput(repo.dir, ['config', 'chamoji.composer', 'true']);
	await gitOutput(repo.dir, ['add', '-A']);
	const failing = capturingTerminal(null);
	await withAdvisor(['commit'], repo.dir, failing.terminal, async () => {
		throw new Error('offline');
	});
	expect(await failing.seen[0]).toBeNull();
});

test('a repository can’t switch the advice on from its own files', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(
		path.join(repo.dir, 'chamoji.config.json'),
		'{"ai": {"composer": true, "sendDiffs": true}}',
	);
	await gitOutput(repo.dir, ['add', '-A']);
	const capture = capturingTerminal(null);
	const advise = vi.fn(async () => ADVICE);
	await withAdvisor(['commit'], repo.dir, capture.terminal, advise);
	expect(capture.seen[0]).toBeUndefined();
	expect(advise).not.toHaveBeenCalled();
});

// --- stamping the active workstream ---

async function startWorkstream(dir: string) {
	const {code, stderr} = await chamoji(
		['ws', 'start', 'Auth revamp', '🔐'],
		dir,
	);
	expect(code, stderr).toBe(0);
}

test('hook run stamps a -m commit, where it never prompts', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	const file = await messageFile(repo.dir, '✨ Add sign-in\n');
	const fake = fakeTerminal('🐛 Nope');
	const {code} = await withTerminal(
		['hook', 'run', file, 'message'],
		repo.dir,
		fake.terminal,
	);
	expect(code).toBe(0);
	expect(fake.calls).toEqual(['close']);
	expect(await readFile(file, 'utf8')).toBe(
		'✨ Add sign-in\n\nWorkstream: auth-revamp\n',
	);
});

test('hook run puts the trailer under the composed message and above git’s comments', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	const file = await messageFile(repo.dir);
	await withTerminal(
		['hook', 'run', file],
		repo.dir,
		fakeTerminal('🐛 (api): Fix timeout').terminal,
	);
	const written = await readFile(file, 'utf8');
	expect(
		written.startsWith(
			'🐛 (api): Fix timeout\n\nWorkstream: auth-revamp\n\n# Please enter',
		),
	).toBe(true);
	expect(written).toContain('#\tmodified:   app.ts');
});

test('hook run never turns an empty message into one, so a cancelled commit still aborts', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	const file = await messageFile(repo.dir);
	await withTerminal(['hook', 'run', file], repo.dir, () => null);
	await withTerminal(['hook', 'run', file, 'template'], repo.dir, () => null);
	await withTerminal(
		['hook', 'run', file],
		repo.dir,
		fakeTerminal(null).terminal,
	);
	expect(await readFile(file, 'utf8')).toBe(TEMPLATE);
});

test('hook run stamps nothing for a merge, squash or amend', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	for (const source of ['merge', 'squash', 'commit']) {
		const file = await messageFile(repo.dir, `Some message\n${TEMPLATE}`);
		const {stderr} = await withTerminal(
			['hook', 'run', file, source],
			repo.dir,
			() => null,
		);
		expect(stderr).toBe('');
		expect(await readFile(file, 'utf8')).toBe(`Some message\n${TEMPLATE}`);
	}
});

const NOTICE =
	'chamoji: editor commits aren\'t stamped; add "Workstream: auth-revamp" to the message, or use -m or chamoji commit.\n';

test('hook run says so when an editor commit goes unstamped for want of a message', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);

	// No terminal, and a cancelled composer: the editor starts on an empty message.
	const file = await messageFile(repo.dir);
	const none = await withTerminal(['hook', 'run', file], repo.dir, () => null);
	expect(none.stderr).toBe(NOTICE);
	const cancelled = await withTerminal(
		['hook', 'run', file],
		repo.dir,
		fakeTerminal(null).terminal,
	);
	expect(cancelled.stderr).toBe(NOTICE);
	expect(await readFile(file, 'utf8')).toBe(TEMPLATE);

	// A template is never stamped, even one with text in it.
	const withText = await messageFile(repo.dir, `Describe it\n${TEMPLATE}`);
	const template = await withTerminal(
		['hook', 'run', withText, 'template'],
		repo.dir,
		() => null,
	);
	expect(template.stderr).toBe(NOTICE);
	expect(await readFile(withText, 'utf8')).toBe(`Describe it\n${TEMPLATE}`);
});

test('hook run stays quiet when nothing is active, on -m, and during a merge', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	const file = await messageFile(repo.dir);
	const message = await withTerminal(
		['hook', 'run', file, 'message'],
		repo.dir,
		() => null,
	);
	expect(message.stderr).toBe('');

	await writeFile(path.join(repo.dir, '.git', 'MERGE_HEAD'), 'x\n');
	const merging = await withTerminal(
		['hook', 'run', file],
		repo.dir,
		() => null,
	);
	expect(merging.stderr).toBe('');
	await rm(path.join(repo.dir, '.git', 'MERGE_HEAD'));

	await chamoji(['ws', 'switch', '--none'], repo.dir);
	const idle = await withTerminal(['hook', 'run', file], repo.dir, () => null);
	expect(idle.stderr).toBe('');
	const idleTemplate = await withTerminal(
		['hook', 'run', file, 'template'],
		repo.dir,
		() => null,
	);
	expect(idleTemplate.stderr).toBe('');
});

test('a message the composer wrote is stamped even when git called it a template', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	const file = await messageFile(repo.dir);
	const {stderr} = await withTerminal(
		['hook', 'run', file, 'template'],
		repo.dir,
		fakeTerminal('🐛 Composed').terminal,
	);
	expect(stderr).toBe('');
	expect(await readFile(file, 'utf8')).toContain(
		'🐛 Composed\n\nWorkstream: auth-revamp\n',
	);
});

test('hook run stamps nothing during a rebase, cherry-pick, revert or merge', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	const gitDir = path.join(repo.dir, '.git');
	const markers: Array<[string, () => Promise<void>]> = [
		[
			'rebase-merge',
			async () => void (await mkdir(path.join(gitDir, 'rebase-merge'))),
		],
		[
			'rebase-apply',
			async () => void (await mkdir(path.join(gitDir, 'rebase-apply'))),
		],
		[
			'CHERRY_PICK_HEAD',
			async () => writeFile(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'x\n'),
		],
		[
			'REVERT_HEAD',
			async () => writeFile(path.join(gitDir, 'REVERT_HEAD'), 'x\n'),
		],
		[
			'MERGE_HEAD',
			async () => writeFile(path.join(gitDir, 'MERGE_HEAD'), 'x\n'),
		],
	];
	for (const [name, create] of markers) {
		await create();
		const file = await messageFile(repo.dir, '✨ Picked\n');
		await withTerminal(['hook', 'run', file, 'message'], repo.dir, () => null);
		expect(await readFile(file, 'utf8'), name).toBe('✨ Picked\n');
		await rm(path.join(gitDir, name), {recursive: true});
	}

	// With the markers gone it stamps again, so they were what held it back.
	const file = await messageFile(repo.dir, '✨ Picked\n');
	await withTerminal(['hook', 'run', file, 'message'], repo.dir, () => null);
	expect(await readFile(file, 'utf8')).toContain('Workstream: auth-revamp');
});

test('hook run still reaches the composer during a cherry-pick, as before', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	await writeFile(path.join(repo.dir, '.git', 'CHERRY_PICK_HEAD'), 'x\n');
	const file = await messageFile(repo.dir);
	const fake = fakeTerminal('🐛 Composed');
	await withTerminal(['hook', 'run', file], repo.dir, fake.terminal);
	// shouldPrompt's input doesn't know about CHERRY_PICK_HEAD, so it prompts;
	// only the stamp is held back.
	expect(fake.calls).toEqual(['compose', 'close']);
	expect(await readFile(file, 'utf8')).toContain('🐛 Composed');
	expect(await readFile(file, 'utf8')).not.toContain('Workstream:');
});

test('hook run swallows a corrupt workstreams file and leaves the message alone', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	await writeFile(
		path.join(repo.dir, '.chamoji', 'workstreams.yml'),
		'<<<<<<< HEAD\nworkstreams: {\n=======\n>>>>>>> other\n',
	);
	const file = await messageFile(repo.dir, '✨ Add sign-in\n');
	const {code, stderr} = await withTerminal(
		['hook', 'run', file, 'message'],
		repo.dir,
		() => null,
	);
	expect(code).toBe(0);
	expect(stderr).toContain('chamoji: hook skipped (.chamoji/workstreams.yml');
	expect(await readFile(file, 'utf8')).toBe('✨ Add sign-in\n');
});

test('chamoji commit survives a corrupt workstreams file and commits unstamped', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Track workstreams']);
	await writeFile(
		path.join(repo.dir, '.chamoji', 'workstreams.yml'),
		'workstreams: [unclosed\n',
	);
	await writeFile(path.join(repo.dir, 'app.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'app.ts']);
	const {code, stderr} = await withTerminal(
		['commit'],
		repo.dir,
		fakeTerminal('✨ Add the entry point').terminal,
	);
	expect(code).toBe(0);
	expect(stderr).toContain('chamoji: not stamped with a workstream (');
	expect(await gitOutput(repo.dir, ['log', '-1', '--format=%B'])).toBe(
		'✨ Add the entry point\n\n',
	);
});

test('chamoji commit does not stamp mid cherry-pick', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	await writeFile(path.join(repo.dir, '.git', 'CHERRY_PICK_HEAD'), 'x\n');
	await writeFile(path.join(repo.dir, 'app.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'app.ts']);
	const {code} = await withTerminal(
		['commit'],
		repo.dir,
		fakeTerminal('✨ Add the entry point').terminal,
	);
	expect(code).toBe(0);
	expect(await gitOutput(repo.dir, ['log', '-1', '--format=%B'])).toBe(
		'✨ Add the entry point\n\n',
	);
});

test('hook run stamps nothing on the message of a clean git revert', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await startWorkstream(repo.dir);
	// A clean revert leaves no REVERT_HEAD and reaches the hook as a -m message.
	const text = 'Revert "✨ Add sign-in"\n\nThis reverts commit abc123.\n';
	const file = await messageFile(repo.dir, text);
	await withTerminal(['hook', 'run', file, 'message'], repo.dir, () => null);
	expect(await readFile(file, 'utf8')).toBe(text);
});

test('hook run hands the composer which units the staged change touches', async () => {
	const json = (value: unknown) => `${JSON.stringify(value)}\n`;
	const uses = {'@gearz/supabase': 'workspace:*'};
	repo = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'package.json': json({name: 'gearz', private: true}),
				'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
				'chamoji.config.json': json({
					release: {
						schema: 1,
						shape: 'apps',
						units: {
							web: {path: 'apps/web', tag: 'web/v{version}'},
							mobile: {path: 'apps/mobile', tag: 'mobile/v{version}'},
						},
					},
				}),
				'apps/web/package.json': json({name: '@gearz/web', dependencies: uses}),
				'apps/mobile/package.json': json({
					name: '@gearz/mobile',
					dependencies: uses,
				}),
				'packages/supabase/package.json': json({name: '@gearz/supabase'}),
			},
		},
	]);
	await mkdir(path.join(repo.dir, 'apps/web'), {recursive: true});
	await writeFile(path.join(repo.dir, 'apps/web/a.ts'), 'a\n');
	await writeFile(path.join(repo.dir, 'packages/supabase/s.ts'), 's\n');
	await gitOutput(repo.dir, ['add', '--all']);
	const file = await messageFile(repo.dir);
	const seen: unknown[] = [];
	await withTerminal(
		['hook', 'run', file],
		repo.dir,
		() =>
			({
				async compose(_config: unknown, _advice: unknown, impact: unknown) {
					seen.push(impact);
					return '🐛 Fix';
				},
				close() {},
			}) as never,
	);
	expect(seen).toEqual([{own: ['web'], rides: ['mobile']}]);

	// A repo with no release section gets none.
	const plain = await createRepo([{commit: '🎉 Init'}]);
	try {
		const plainFile = await messageFile(plain.dir);
		const none: unknown[] = [];
		await withTerminal(
			['hook', 'run', plainFile],
			plain.dir,
			() =>
				({
					async compose(_config: unknown, _advice: unknown, impact: unknown) {
						none.push(impact);
						return '🐛 Fix';
					},
					close() {},
				}) as never,
		);
		expect(none).toEqual([undefined]);
	} finally {
		await plain.cleanup();
	}
});
