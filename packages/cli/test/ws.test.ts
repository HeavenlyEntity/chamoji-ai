import {execFile} from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {readMemory} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const FILE = '.chamoji/workstreams.yml';
const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

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

/** The installed hook, running the built CLI, so a real `git commit` goes through it. */
async function installBuiltHook(dir: string) {
	const file = path.join(dir, '.git', 'hooks', 'prepare-commit-msg');
	const quote = (value: string) => `"${value.replaceAll('\\', '/')}"`;
	await writeFile(
		file,
		`#!/bin/sh\n${quote(process.execPath)} ${quote(cliJs)} hook run "$@"\nexit 0\n`,
	);
	await chmod(file, 0o755);
}

const message = (dir: string, revision = 'HEAD') =>
	gitOutput(dir, ['log', '-1', '--format=%B', revision]);

async function commitFile(dir: string, name: string, ...messages: string[]) {
	await writeFile(path.join(dir, name), `${name}\n`);
	await gitOutput(dir, ['add', '--', name]);
	await gitOutput(dir, [
		'commit',
		'-q',
		...messages.flatMap(text => ['-m', text]),
	]);
}

test('ws start adds the workstream, stages the file and makes it active', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const {code, stdout} = await chamoji(
		['ws', 'start', 'Auth revamp', '🔐'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toContain(
		'Started auth-revamp. Staged .chamoji/workstreams.yml; your next commit records it.',
	);
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		`${FILE}\n`,
	);
	expect(await readFile(path.join(repo.dir, FILE), 'utf8')).toContain('🔐');
	expect(
		await readFile(path.join(repo.dir, '.git', 'chamoji', 'active'), 'utf8'),
	).toBe('auth-revamp\n');
	// ws never commits.
	expect(await gitOutput(repo.dir, ['rev-list', '--count', 'HEAD'])).toBe(
		'1\n',
	);
});

test('ws start with the hook installed says new commits get the trailer', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['hook', 'install'], repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['ws', 'start', 'Auth revamp'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toContain(
		'New commits in this worktree get "Workstream: auth-revamp".',
	);
	expect(stderr).toBe('');
});

test('ws start with no hook says git commit won’t stamp, and that holds', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const {code, stdout, stderr} = await chamoji(
		['ws', 'start', 'Auth revamp'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toContain('Started auth-revamp.');
	expect(stdout).not.toContain('New commits');
	expect(stderr).toContain('`git commit` won\'t add "Workstream: auth-revamp"');
	expect(stderr).toContain('chamoji hook install');
	expect(stderr).toContain('chamoji commit');
	// It warns rather than installing a hook unasked.
	expect(await readdir(path.join(repo.dir, '.git', 'hooks'))).not.toContain(
		'prepare-commit-msg',
	);

	await commitFile(repo.dir, 'a.ts', '✨ Add sign-in');
	expect(await message(repo.dir)).toBe('✨ Add sign-in\n\n');
});

test('ws start under another tool’s hook neither promises nor warns outright', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const hook = path.join(repo.dir, '.git', 'hooks', 'prepare-commit-msg');
	await writeFile(hook, '#!/bin/sh\n./scripts/check-ticket.sh "$1"\n');
	await chmod(hook, 0o755);
	const {code, stdout, stderr} = await chamoji(
		['ws', 'start', 'Auth revamp'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).not.toContain('New commits');
	expect(stderr).not.toContain("won't add");
	expect(stderr).toContain(
		'`git commit` adds "Workstream: auth-revamp" only if it does',
	);
	expect(stderr).toContain('chamoji hook install');
});

test('ws switch with the hook installed says new commits get the trailer', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['hook', 'install'], repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'switch', '--none'], repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['ws', 'switch', 'auth-revamp'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe(
		'Switched to auth-revamp.\nNew commits in this worktree get "Workstream: auth-revamp".\n',
	);
	expect(stderr).toBe('');
});

test('ws switch with no hook warns, as a fresh clone has none', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'switch', '--none'], repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['ws', 'switch', 'auth-revamp'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe('Switched to auth-revamp.\n');
	expect(stderr).toContain('`git commit` won\'t add "Workstream: auth-revamp"');
	expect(stderr).toContain('chamoji hook install');
});

test('ws switch --none says nothing about the hook, as nothing is stamped', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['ws', 'switch', '--none'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe('No active workstream now.\n');
	expect(stderr).toBe('');
});

test('git commit -m through the installed hook gets the Workstream trailer', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp', '🔐'], repo.dir);
	await commitFile(repo.dir, 'a.ts', '✨ Add sign-in');
	expect(await message(repo.dir)).toBe(
		'✨ Add sign-in\n\nWorkstream: auth-revamp\n\n',
	);
	// The commit also recorded the staged workstreams file.
	expect(
		await gitOutput(repo.dir, ['show', '--name-only', '--format=', 'HEAD']),
	).toContain(FILE);
});

test('chamoji commit with no hook installed stamps it too', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	let stderr = '';
	const code = await run(['commit'], {
		cwd: repo.dir,
		stdout() {},
		stderr: text => (stderr += text),
		env: {},
		terminal: () => ({
			async compose() {
				return '✨ Add sign-in';
			},
			close() {},
		}),
	});
	expect(code, stderr).toBe(0);
	expect(await message(repo.dir)).toBe(
		'✨ Add sign-in\n\nWorkstream: auth-revamp\n\n',
	);
});

test('chamoji commit with the hook installed stamps once', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	const code = await run(['commit'], {
		cwd: repo.dir,
		stdout() {},
		stderr() {},
		env: {},
		terminal: () => ({
			async compose() {
				return '✨ Add sign-in';
			},
			close() {},
		}),
	});
	expect(code).toBe(0);
	expect(await message(repo.dir)).toBe(
		'✨ Add sign-in\n\nWorkstream: auth-revamp\n\n',
	);
});

test('-m with no active workstream leaves the message byte for byte', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	// No workstreams file at all.
	await commitFile(repo.dir, 'a.ts', '✨ Add a', 'Because.');
	expect(await message(repo.dir)).toBe('✨ Add a\n\nBecause.\n\n');

	// A file, but nothing active.
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'switch', '--none'], repo.dir);
	await commitFile(repo.dir, 'b.ts', '✨ Add b', 'Because.');
	expect(await message(repo.dir)).toBe('✨ Add b\n\nBecause.\n\n');
});

test('ws outside a repo says so, as the other commands do', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-nogit-'));
	try {
		for (const argv of [['ws'], ['ws', 'list'], ['ws', 'start', 'Auth']]) {
			const {code, stdout, stderr} = await chamoji(argv, dir);
			expect(code).toBe(1);
			expect(stdout).toBe('');
			expect(stderr).toBe(`chamoji: Not a git repository: ${dir}\n`);
		}
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test('ws start under a git-ignored .chamoji names the rule and leaves no file behind', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(path.join(repo.dir, '.gitignore'), '.chamoji/\n');
	const {code, stdout, stderr} = await chamoji(
		['ws', 'start', 'Auth revamp'],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stdout).toBe('');
	expect(stderr).toContain('.chamoji/workstreams.yml is ignored by git');
	expect(stderr).toContain('.gitignore:1:.chamoji/');
	expect(stderr).not.toContain('Command failed');
	await expect(readdir(path.join(repo.dir, '.chamoji'))).rejects.toThrow();
	await expect(
		readFile(path.join(repo.dir, '.git', 'chamoji', 'active'), 'utf8'),
	).rejects.toThrow();
});

test('git commit -m with a leading # is stamped under the default cleanup', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await commitFile(repo.dir, 'a.ts', '#123 fix the login');
	expect(await message(repo.dir)).toBe(
		'#123 fix the login\n\nWorkstream: auth-revamp\n\n',
	);
});

test('git commit -m with a leading # is left alone, and aborts, under commit.cleanup=strip', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await gitOutput(repo.dir, ['config', 'commit.cleanup', 'strip']);
	await writeFile(path.join(repo.dir, 'a.ts'), 'a\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	await expect(
		gitOutput(repo.dir, ['commit', '-q', '-m', '#123 fix the login']),
	).rejects.toThrow(/empty commit message/i);
	expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);

	// A real line beside the comment is a message, and is stamped.
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ Add a', '-m', '#123']);
	expect(await message(repo.dir)).toBe(
		'✨ Add a\n\nWorkstream: auth-revamp\n\n',
	);
});

test('a message that already has a Workstream trailer keeps it', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await commitFile(repo.dir, 'a.ts', '✨ Add a', 'Workstream: other');
	expect(await message(repo.dir)).toBe('✨ Add a\n\nWorkstream: other\n\n');
});

test('a merge commit is not stamped', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await commitFile(repo.dir, 'a.ts', '✨ Add a');
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	await commitFile(repo.dir, 'side.ts', '✨ Add side');
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await commitFile(repo.dir, 'main.ts', '✨ Add main');
	await gitOutput(repo.dir, ['merge', '--no-ff', '--no-edit', '-q', 'side']);
	expect(await message(repo.dir)).toBe("Merge branch 'side'\n\n");
});

test('an amend is not stamped and keeps the trailer it had', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await commitFile(repo.dir, 'a.ts', '✨ Add a');
	await chamoji(['ws', 'start', 'Billing'], repo.dir);

	// Billing is active now, but amending a commit leaves its message alone.
	await gitOutput(repo.dir, ['commit', '-q', '--amend', '--no-edit']);
	expect(await message(repo.dir)).toBe(
		'✨ Add a\n\nWorkstream: auth-revamp\n\n',
	);

	await gitOutput(repo.dir, ['switch', '-q', '-c', 'plain', 'HEAD~0']);
	await chamoji(['ws', 'switch', '--none'], repo.dir);
	await commitFile(repo.dir, 'b.ts', '✨ Add b');
	await chamoji(['ws', 'switch', 'billing'], repo.dir);
	await gitOutput(repo.dir, ['commit', '-q', '--amend', '--no-edit']);
	expect(await message(repo.dir)).toBe('✨ Add b\n\n');
});

test('a workstream shipped or deleted elsewhere commits unstamped without an error', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await commitFile(repo.dir, 'a.ts', '✨ Add a');

	// Another branch shipped it: the working-tree file now says so.
	await writeFile(
		path.join(repo.dir, FILE),
		(await readFile(path.join(repo.dir, FILE), 'utf8')).replace(
			'status: active',
			'status: shipped',
		),
	);
	await gitOutput(repo.dir, ['add', FILE]);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Ship it']);
	expect(await message(repo.dir)).toBe('🔧 Ship it\n\n');

	// Or the entry is gone.
	await writeFile(path.join(repo.dir, FILE), 'workstreams: {}\n');
	await commitFile(repo.dir, 'b.ts', '✨ Add b');
	expect(await message(repo.dir)).toBe('✨ Add b\n\n');
});

test('a corrupt workstreams file never blocks git commit -m', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(
		path.join(repo.dir, FILE),
		'<<<<<<< HEAD\nworkstreams: {\n=======\n>>>>>>> other\n',
	);
	await writeFile(path.join(repo.dir, 'a.ts'), 'a\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ Add a']);
	expect(await message(repo.dir)).toBe('✨ Add a\n\n');
});

test('ws switch moves the active workstream, and --none clears it', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'start', 'Billing'], repo.dir);
	const active = () =>
		readFile(path.join(repo!.dir, '.git', 'chamoji', 'active'), 'utf8');
	expect(await active()).toBe('billing\n');

	const back = await chamoji(['ws', 'switch', 'auth-revamp'], repo.dir);
	expect(back.code).toBe(0);
	expect(back.stdout).toBe('Switched to auth-revamp.\n');
	expect(await active()).toBe('auth-revamp\n');

	const none = await chamoji(['ws', 'switch', '--none'], repo.dir);
	expect(none.code).toBe(0);
	expect(none.stdout).toBe('No active workstream now.\n');
	await expect(active()).rejects.toThrow();
});

test('ws switch refuses a workstream that is not active, naming its status', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'ship'], repo.dir);
	const shipped = await chamoji(['ws', 'switch', 'auth-revamp'], repo.dir);
	expect(shipped.code).toBe(1);
	expect(shipped.stderr).toBe(
		"chamoji: auth-revamp is shipped, so it can't be made active\n",
	);

	const missing = await chamoji(['ws', 'switch', 'nope'], repo.dir);
	expect(missing.code).toBe(1);
	expect(missing.stderr).toContain('No workstream named "nope"');
});

test('ws switch needs a slug or --none, and not both', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	const neither = await chamoji(['ws', 'switch'], repo.dir);
	expect(neither.code).toBe(2);
	expect(neither.stderr).toContain('switch needs a slug or --none');

	const both = await chamoji(
		['ws', 'switch', 'auth-revamp', '--none'],
		repo.dir,
	);
	expect(both.code).toBe(2);
	expect(both.stderr).toContain('switch needs a slug or --none');
});

test('ws ship and drop set the status, stage the file and clear the active one', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Track workstreams']);

	const shipped = await chamoji(['ws', 'ship'], repo.dir);
	expect(shipped.code).toBe(0);
	expect(shipped.stdout).toContain(
		'Shipped auth-revamp. Staged .chamoji/workstreams.yml; your next commit records it.',
	);
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		`${FILE}\n`,
	);
	expect(await readFile(path.join(repo.dir, FILE), 'utf8')).toContain(
		'status: shipped',
	);
	await expect(
		readFile(path.join(repo.dir, '.git', 'chamoji', 'active'), 'utf8'),
	).rejects.toThrow();

	await chamoji(['ws', 'start', 'Billing'], repo.dir);
	await chamoji(['ws', 'start', 'Search'], repo.dir);
	const dropped = await chamoji(['ws', 'drop', 'billing'], repo.dir);
	expect(dropped.code).toBe(0);
	expect(dropped.stdout).toContain(
		'Dropped billing. Staged .chamoji/workstreams.yml; your next commit records it.',
	);
	const text = await readFile(path.join(repo.dir, FILE), 'utf8');
	expect(text).toContain('status: dropped');
	// Dropping another workstream leaves the active one alone.
	expect(
		await readFile(path.join(repo.dir, '.git', 'chamoji', 'active'), 'utf8'),
	).toBe('search\n');
});

test('ws ship with no slug and no active workstream exits 1 and says so', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'switch', '--none'], repo.dir);
	for (const command of ['ship', 'drop']) {
		const {code, stdout, stderr} = await chamoji(['ws', command], repo.dir);
		expect(code).toBe(1);
		expect(stdout).toBe('');
		expect(stderr).toBe(
			`chamoji: no active workstream; name one: chamoji ws ${command} <slug>\n`,
		);
	}
});

test('ws ship of an unknown slug exits 1', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const {code, stderr} = await chamoji(['ws', 'ship', 'nope'], repo.dir);
	expect(code).toBe(1);
	expect(stderr).toContain('No workstream named "nope"');
});

test('ws list shows slug, status, title and unreleased commits, with * on the active one', async () => {
	repo = await createRepo([
		{commit: '🎉 Init'},
		{commit: '✨ Old', body: 'Workstream: auth-revamp'},
		{tag: 'v1.0.0'},
		{commit: '✨ One', body: 'Workstream: auth-revamp'},
		{commit: '✨ Two', body: 'Workstream: auth-revamp'},
		{commit: '🐛 Three', body: 'Workstream: billing'},
		{commit: '♻️ Loose'},
	]);
	await chamoji(['ws', 'start', 'Auth revamp', '🔐'], repo.dir);
	await chamoji(['ws', 'start', 'Billing'], repo.dir);
	await chamoji(['ws', 'drop', 'billing'], repo.dir);
	await chamoji(['ws', 'switch', 'auth-revamp'], repo.dir);

	for (const argv of [['ws', 'list'], ['ws']]) {
		const {code, stdout} = await chamoji(argv, repo.dir);
		expect(code).toBe(0);
		expect(stdout.split('\n').filter(Boolean)).toEqual([
			'* auth-revamp  active   🔐 Auth revamp  2 commits',
			'  billing      dropped  Billing         1 commit',
		]);
	}
});

test('ws list lines up the commit counts however wide the emoji are', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Cleanup', '♻️'], repo.dir);
	await chamoji(['ws', 'start', 'Dev', '👩‍💻'], repo.dir);
	await chamoji(['ws', 'start', 'Plain title'], repo.dir);
	const {stdout} = await chamoji(['ws', 'list'], repo.dir);
	// Each emoji takes two columns, so the labels fill 11 columns.
	expect(stdout.split('\n').filter(Boolean)).toEqual([
		'  cleanup      active  ♻️ Cleanup   0 commits',
		'  dev          active  👩‍💻 Dev       0 commits',
		'* plain-title  active  Plain title  0 commits',
	]);
});

test('ws list --json counts a workstream’s unreleased commits on this branch only', async () => {
	repo = await createRepo([
		{commit: '🎉 Init'},
		{commit: '✨ Old', body: 'Workstream: auth-revamp'},
		{tag: 'v1.0.0'},
		{commit: '✨ One', body: 'Workstream: auth-revamp'},
		{commit: '✨ Two', body: 'Workstream: auth-revamp'},
	]);
	await chamoji(['ws', 'start', 'Auth revamp', '🔐'], repo.dir);
	await chamoji(['ws', 'start', 'Billing'], repo.dir);
	await chamoji(['ws', 'switch', 'auth-revamp'], repo.dir);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Track workstreams']);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'feature']);
	await gitOutput(repo.dir, [
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'✨ Elsewhere',
		'-m',
		'Workstream: billing',
	]);
	await gitOutput(repo.dir, ['switch', '-q', 'main']);

	const {code, stdout} = await chamoji(['ws', 'list', '--json'], repo.dir);
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toEqual([
		{
			slug: 'auth-revamp',
			title: 'Auth revamp',
			emoji: '🔐',
			status: 'active',
			active: true,
			commits: 2,
		},
		{
			slug: 'billing',
			title: 'Billing',
			status: 'active',
			active: false,
			commits: 0,
		},
	]);
});

test('ws list copes with no workstreams, no commits and no tag', async () => {
	repo = await createRepo([]);
	const human = await chamoji(['ws', 'list'], repo.dir);
	expect(human.code).toBe(0);
	expect(human.stdout).toBe(
		'No workstreams yet. Start one with: chamoji ws start <title> [emoji]\n',
	);
	const json = await chamoji(['ws', 'list', '--json'], repo.dir);
	expect(json.stdout).toBe('[]\n');

	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	expect(
		JSON.parse((await chamoji(['ws', '--json'], repo.dir)).stdout),
	).toEqual([
		{
			slug: 'auth-revamp',
			title: 'Auth revamp',
			status: 'active',
			active: true,
			commits: 0,
		},
	]);
});

test('a corrupt workstreams file makes ws start exit 1 and leaves it unchanged', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const broken = 'workstreams: [unclosed\n';
	const file = path.join(repo.dir, FILE);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, broken);

	const {code, stdout, stderr} = await chamoji(
		['ws', 'start', 'Auth revamp'],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stdout).toBe('');
	expect(stderr).toContain(
		'chamoji: .chamoji/workstreams.yml is not valid YAML',
	);
	expect(await readFile(file, 'utf8')).toBe(broken);
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		'',
	);
	await expect(
		readFile(path.join(repo.dir, '.git', 'chamoji', 'active'), 'utf8'),
	).rejects.toThrow();
});

test('ws start needs a title, an emoji that is one, and a known subcommand', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const bare = await chamoji(['ws', 'start'], repo.dir);
	expect(bare.code).toBe(2);
	expect(bare.stderr).toContain('ws start needs a title');

	// An unquoted multi-word title would otherwise turn "revamp" into the emoji.
	const unquoted = await chamoji(['ws', 'start', 'Auth', 'revamp'], repo.dir);
	expect(unquoted.code).toBe(2);
	expect(unquoted.stderr).toContain('quote');

	const dup = await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	expect(dup.code).toBe(0);
	const again = await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	expect(again.code).toBe(1);
	expect(again.stderr).toContain('already exists');

	const unknown = await chamoji(['ws', 'frobnicate'], repo.dir);
	expect(unknown.code).toBe(2);
	expect(unknown.stderr).toContain(
		'ws needs start, switch, list, ship or drop, not "frobnicate"',
	);
});

/**
 * Runs git with its editor set, as `gitOutput` can't. CI keeps the hook from
 * opening the composer on the developer's own terminal.
 */
async function gitWithEditor(dir: string, args: string[], editor = 'true') {
	const {stdout} = await promisify(execFile)('git', args, {
		cwd: dir,
		env: {...process.env, GIT_EDITOR: editor, CI: 'true'},
	});
	return stdout;
}

test('quitting the editor on an empty message still aborts the commit', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'a\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	await expect(gitWithEditor(repo.dir, ['commit', '-q'])).rejects.toThrow();
	expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);
});

test('cherry-picks and reverts are not stamped', async () => {
	repo = await createRepo([{commit: '🎉 Init', files: {'x.ts': 'one\n'}}]);
	await installBuiltHook(repo.dir);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'other']);
	await commitFile(repo.dir, 'y.ts', '✨ Add y');
	await writeFile(path.join(repo.dir, 'x.ts'), 'theirs\n');
	await gitOutput(repo.dir, ['commit', '-q', '-a', '-m', '🐛 Change x']);
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'x.ts'), 'ours\n');
	await gitOutput(repo.dir, ['commit', '-q', '-a', '-m', '🐛 Change x here']);
	expect(await message(repo.dir)).toContain('Workstream: auth-revamp');

	// A clean pick.
	await gitOutput(repo.dir, ['cherry-pick', 'other~1']);
	expect(await message(repo.dir)).toBe('✨ Add y\n\n');

	// A conflicting pick, resolved and continued.
	await expect(gitOutput(repo.dir, ['cherry-pick', 'other'])).rejects.toThrow();
	await writeFile(path.join(repo.dir, 'x.ts'), 'resolved\n');
	await gitOutput(repo.dir, ['add', 'x.ts']);
	await gitWithEditor(repo.dir, ['cherry-pick', '--continue']);
	expect(await message(repo.dir)).not.toContain('Workstream:');
	expect(await message(repo.dir)).toContain('🐛 Change x');

	// A revert.
	await gitWithEditor(repo.dir, ['revert', 'HEAD']);
	expect(await message(repo.dir)).toContain('Revert');
	expect(await message(repo.dir)).not.toContain('Workstream:');
});

const NOTICE = (slug: string) =>
	`chamoji: editor commits aren't stamped; add "Workstream: ${slug}" to the message, or use -m or chamoji commit.`;

test('git commit -v and commit.verbose still abort on an empty message', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	for (const args of [
		['commit', '-q', '-v'],
		['-c', 'commit.verbose=true', 'commit', '-q'],
	]) {
		await expect(gitWithEditor(repo.dir, args)).rejects.toThrow(
			/empty commit message/i,
		);
		expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);
	}
});

test('an unedited commit.template still aborts, and the hook says why it did not stamp', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await writeFile(
		path.join(repo.dir, '.git', 'template.txt'),
		'Describe the change here\n',
	);
	await gitOutput(repo.dir, ['config', 'commit.template', '.git/template.txt']);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	await expect(gitWithEditor(repo.dir, ['commit', '-q'])).rejects.toThrow(
		NOTICE('auth-revamp'),
	);
	expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);

	// -m ignores the template and is stamped as usual.
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ Add a']);
	expect(await message(repo.dir)).toBe(
		'✨ Add a\n\nWorkstream: auth-revamp\n\n',
	);
});

test('the editor notice names the workstream, and only shows when a stamp was skipped for that reason', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);

	// An editor that writes a message: the commit goes through, unstamped.
	const editor = path.join(repo.dir, 'editor.js');
	await writeFile(
		editor,
		"require('node:fs').writeFileSync(process.argv[2], '✨ Add a\\n');\n",
	);
	const quote = (value: string) => `"${value.replaceAll('\\', '/')}"`;
	const result = await promisify(execFile)('git', ['commit', '-q'], {
		cwd: repo.dir,
		env: {
			...process.env,
			GIT_EDITOR: `${quote(process.execPath)} ${quote(editor)}`,
			CI: 'true',
		},
	});
	expect(result.stderr).toContain(NOTICE('auth-revamp'));
	expect(await message(repo.dir)).toBe('✨ Add a\n\n');

	// No notice with -m, or with nothing active.
	await commitFile(repo.dir, 'b.ts', '✨ Add b');
	await chamoji(['ws', 'switch', '--none'], repo.dir);
	await writeFile(path.join(repo.dir, 'c.ts'), 'c\n');
	await gitOutput(repo.dir, ['add', 'c.ts']);
	const quiet = await promisify(execFile)('git', ['commit', '-q'], {
		cwd: repo.dir,
		env: {
			...process.env,
			GIT_EDITOR: `${quote(process.execPath)} ${quote(editor)}`,
			CI: 'true',
		},
	});
	expect(quiet.stderr).toBe('');
});

const CONFLICT_STEPS = async (dir: string) => {
	await gitOutput(dir, ['switch', '-q', '-c', 'side']);
	await writeFile(path.join(dir, 'x.ts'), 'theirs\n');
	await gitOutput(dir, ['commit', '-q', '-a', '-m', '🐛 Change x there']);
	await gitOutput(dir, ['switch', '-q', 'main']);
	await writeFile(path.join(dir, 'x.ts'), 'ours\n');
	await gitOutput(dir, ['commit', '-q', '-a', '-m', '🐛 Change x here']);
};

test('a conflicted merge concluded with git commit -m is not stamped', async () => {
	repo = await createRepo([{commit: '🎉 Init', files: {'x.ts': 'one\n'}}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await CONFLICT_STEPS(repo.dir);
	await expect(gitOutput(repo.dir, ['merge', 'side'])).rejects.toThrow();
	await writeFile(path.join(repo.dir, 'x.ts'), 'resolved\n');
	await gitOutput(repo.dir, ['add', 'x.ts']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔀 Merge side']);
	expect(await message(repo.dir)).toBe('🔀 Merge side\n\n');
});

test('chamoji commit does not stamp the merge it concludes', async () => {
	repo = await createRepo([{commit: '🎉 Init', files: {'x.ts': 'one\n'}}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await CONFLICT_STEPS(repo.dir);
	await expect(gitOutput(repo.dir, ['merge', 'side'])).rejects.toThrow();
	await writeFile(path.join(repo.dir, 'x.ts'), 'resolved\n');
	await gitOutput(repo.dir, ['add', 'x.ts']);
	const code = await run(['commit'], {
		cwd: repo.dir,
		stdout() {},
		stderr() {},
		env: {},
		terminal: () => ({
			async compose() {
				return '🔀 Merge side';
			},
			close() {},
		}),
	});
	expect(code).toBe(0);
	expect(await message(repo.dir)).toBe('🔀 Merge side\n\n');
});

test('git commit -s still aborts on an empty message, and says why it did not stamp', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await installBuiltHook(repo.dir);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await writeFile(path.join(repo.dir, 'a.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', 'a.ts']);
	const before = await gitOutput(repo.dir, ['rev-parse', 'HEAD']);
	await expect(gitWithEditor(repo.dir, ['commit', '-q', '-s'])).rejects.toThrow(
		NOTICE('auth-revamp'),
	);
	expect(await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);

	// With a subject, the sign-off doesn't stop the stamp.
	await gitOutput(repo.dir, ['commit', '-q', '-s', '-m', '✨ Add a']);
	expect(await message(repo.dir)).toMatch(
		/^✨ Add a\n\nSigned-off-by: .+\nWorkstream: auth-revamp\n\n$/,
	);
});

test('ws ship writes a snapshot', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp', '🔐'], repo.dir);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Track workstreams']);
	await commitFile(
		repo.dir,
		'a.txt',
		'✨ Add a',
		'Why: because\nWorkstream: auth-revamp',
	);

	const {code, stderr} = await chamoji(['ws', 'ship'], repo.dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	const entry = await readMemory(repo.dir, 'auth-revamp');
	expect(entry).toMatchObject({
		title: 'Auth revamp',
		emoji: '🔐',
		status: 'shipped',
		archived: false,
	});
	expect(entry?.commits.map(commit => commit.subject)).toEqual(['✨ Add a']);
	expect(entry?.commits[0]?.card?.why).toEqual(['because']);
	// The status change stays staged, and only the ref moved.
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		`${FILE}\n`,
	);
});

test('ws drop writes a snapshot', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Billing'], repo.dir);
	const {code} = await chamoji(['ws', 'drop', 'billing'], repo.dir);
	expect(code).toBe(0);
	expect((await readMemory(repo.dir, 'billing'))?.status).toBe('dropped');
});

test('ws ship says how many commits it saved to memory', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Track workstreams']);
	await commitFile(
		repo.dir,
		'a.txt',
		'✨ Add a',
		'Why: because\nWorkstream: auth-revamp',
	);
	const {stdout, stderr} = await chamoji(['ws', 'ship'], repo.dir);
	expect(stdout).toContain('Saved 1 commit to memory.\n');
	expect(stderr).toBe('');
});

test('ws ship and drop warn when no commit names the workstream', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	await chamoji(['ws', 'start', 'Billing'], repo.dir);
	const shipped = await chamoji(['ws', 'ship', 'auth-revamp'], repo.dir);
	expect(shipped.code).toBe(0);
	expect(shipped.stdout).toContain('Saved 0 commits to memory.\n');
	expect(shipped.stderr).toContain(
		'chamoji: memory has no commits for auth-revamp',
	);
	expect(shipped.stderr).toContain('chamoji ws ship auth-revamp there');
	const dropped = await chamoji(['ws', 'drop', 'billing'], repo.dir);
	expect(dropped.code).toBe(0);
	expect(dropped.stdout).toContain('Saved 0 commits to memory.\n');
	expect(dropped.stderr).toContain('chamoji ws drop billing there');
});

test('a failed snapshot warns and ws ship still succeeds', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await chamoji(['ws', 'start', 'Auth revamp'], repo.dir);
	// A held lock is what a crashed git leaves behind: update-ref can't get in.
	const refs = path.join(repo.dir, '.git', 'refs', 'chamoji');
	await mkdir(refs);
	await writeFile(path.join(refs, 'memory.lock'), '');

	const {code, stdout, stderr} = await chamoji(['ws', 'ship'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('Shipped auth-revamp.');
	expect(stderr).toContain('chamoji: auth-revamp was not saved to memory (');
	expect(await readFile(path.join(repo.dir, FILE), 'utf8')).toContain(
		'status: shipped',
	);
	await rm(path.join(refs, 'memory.lock'));
	expect(await readMemory(repo.dir, 'auth-revamp')).toBeUndefined();
});
