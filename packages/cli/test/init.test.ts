import {spawnSync} from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	MEMORY_FETCH_REFSPEC,
	MEMORY_REF,
	MEMORY_REMOTE_REF,
	listMemory,
	snapshotWorkstream,
	syncMemory,
} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

async function chamoji(
	argv: string[],
	cwd: string,
	env?: Record<string, string | undefined>,
) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		...(env ? {env} : {}),
	});
	return {code, stdout, stderr};
}

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-init-'));
	cleanups.push(async () => rm(dir, {recursive: true, force: true}));
	return dir;
}

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    status: shipped',
		'  billing:',
		'    title: Billing',
		'    status: shipped',
		'',
	].join('\n'),
};

async function repoFrom(
	steps: Parameters<typeof createRepo>[0],
): Promise<FixtureRepo> {
	const repo = await createRepo(steps);
	cleanups.push(async () => repo.cleanup());
	return repo;
}

/** A repo with main on a bare origin that has no memory, and a clone of it. */
async function withOrigin() {
	const remote = await tempDir();
	await gitOutput(remote, ['init', '-q', '--bare', '-b', 'main']);
	const {dir} = await repoFrom([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked\nWorkstream: auth',
		},
	]);
	await gitOutput(dir, ['remote', 'add', 'origin', remote]);
	await gitOutput(dir, ['push', '-q', '-u', 'origin', 'main']);
	const clone = path.join(await tempDir(), 'clone');
	await gitOutput(path.dirname(clone), ['clone', '-q', remote, clone]);
	await gitOutput(clone, ['config', 'user.name', 'Dev']);
	await gitOutput(clone, ['config', 'user.email', 'dev@example.com']);
	return {remote, dir, clone};
}

const fetchLines = async (dir: string) =>
	(await gitOutput(dir, ['config', '--get-all', 'remote.origin.fetch']))
		.trim()
		.split('\n');

test('init adds the wildcard fetch refspec once', async () => {
	const {clone} = await withOrigin();
	const first = await chamoji(['init'], clone);
	expect(first.stderr).toBe('');
	expect(first.code).toBe(0);
	expect(first.stdout).toContain('origin now fetches chamoji memory');
	const again = await chamoji(['init'], clone);
	expect(again.code).toBe(0);
	expect(again.stdout).toContain('origin already fetches chamoji memory');
	expect(await fetchLines(clone)).toEqual([
		'+refs/heads/*:refs/remotes/origin/*',
		MEMORY_FETCH_REFSPEC,
	]);
	expect(MEMORY_FETCH_REFSPEC).toBe(
		'+refs/chamoji/*:refs/chamoji/remotes/origin/*',
	);
});

test('init leaves remote.origin.push unset', async () => {
	const {clone} = await withOrigin();
	await chamoji(['init'], clone);
	await expect(
		gitOutput(clone, ['config', '--get-all', 'remote.origin.push']),
	).rejects.toThrow();
});

test('plain git fetch and git pull work after init on a remote with no memory', async () => {
	const {remote, dir, clone} = await withOrigin();
	await chamoji(['init'], clone);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', '🐛 Next']);
	await gitOutput(dir, ['push', '-q', 'origin', 'main']);

	await gitOutput(clone, ['fetch']);
	await gitOutput(clone, ['pull', '-q']);
	expect(await gitOutput(clone, ['rev-parse', 'HEAD'])).toBe(
		await gitOutput(remote, ['rev-parse', 'main']),
	);
});

test('plain git fetch and git pull work after init on a remote with memory', async () => {
	const {remote, dir, clone} = await withOrigin();
	await chamoji(['init'], clone);
	await snapshotWorkstream(dir, 'auth');
	await syncMemory(dir);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', '🐛 Next']);
	await gitOutput(dir, ['push', '-q', 'origin', 'main']);

	await gitOutput(clone, ['fetch']);
	await gitOutput(clone, ['pull', '-q']);
	expect(await gitOutput(clone, ['rev-parse', 'HEAD'])).toBe(
		await gitOutput(remote, ['rev-parse', 'main']),
	);
	// Plain fetch keeps the remote's copy beside the local ref, not on it.
	expect(await gitOutput(clone, ['rev-parse', MEMORY_REMOTE_REF])).toBe(
		await gitOutput(remote, ['rev-parse', MEMORY_REF]),
	);
	await expect(
		gitOutput(clone, ['rev-parse', '--verify', MEMORY_REF]),
	).rejects.toThrow();
});

test('plain git push still pushes the branch after init', async () => {
	const {remote, dir} = await withOrigin();
	await chamoji(['init'], dir);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', '🐛 Next']);
	await gitOutput(dir, ['push', '-q']);
	expect(await gitOutput(remote, ['rev-parse', 'main'])).toBe(
		await gitOutput(dir, ['rev-parse', 'HEAD']),
	);
});

test('plain git push leaves memory behind after init', async () => {
	const {remote, dir} = await withOrigin();
	await chamoji(['init'], dir);
	await snapshotWorkstream(dir, 'auth');
	await gitOutput(dir, ['push', '-q']);
	await expect(
		gitOutput(remote, ['rev-parse', '--verify', MEMORY_REF]),
	).rejects.toThrow();
});

test('init with no origin says so and exits 0', async () => {
	const {dir} = await repoFrom([{commit: '🎉 Init'}]);
	const {code, stdout, stderr} = await chamoji(['init'], dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toContain('No remote named origin');
	await expect(
		gitOutput(dir, ['config', '--get-all', 'remote.origin.fetch']),
	).rejects.toThrow();
});

test('init brings remote memory in and pushes nothing', async () => {
	const {remote, dir, clone} = await withOrigin();
	await snapshotWorkstream(dir, 'auth');
	await syncMemory(dir);
	await gitOutput(clone, ['pull', '-q']);
	await snapshotWorkstream(clone, 'billing');
	const before = await gitOutput(remote, ['rev-parse', MEMORY_REF]);

	const {code, stdout} = await chamoji(['init'], clone);
	expect(code).toBe(0);
	expect(stdout).toContain('Took in memory from origin: 2 entries.');
	expect((await listMemory(clone)).map(entry => entry.slug)).toEqual([
		'auth',
		'billing',
	]);
	expect(await gitOutput(remote, ['rev-parse', MEMORY_REF])).toBe(before);
});

test('init on a remote with no memory says there is none yet', async () => {
	const {clone} = await withOrigin();
	const {stdout} = await chamoji(['init'], clone);
	expect(stdout).toContain('No memory on origin yet.');
});

test('init keeps its setup when origin cannot be reached', async () => {
	const {dir} = await withOrigin();
	await gitOutput(dir, ['remote', 'set-url', 'origin', `${dir}-missing`]);
	const {code, stdout, stderr} = await chamoji(['init'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('origin now fetches chamoji memory');
	expect(stderr).toContain('chamoji: Could not fetch memory');
	expect(await fetchLines(dir)).toContain(MEMORY_FETCH_REFSPEC);
});

test('init after a local purge gives the force-push step', async () => {
	const {dir} = await withOrigin();
	await snapshotWorkstream(dir, 'auth');
	await snapshotWorkstream(dir, 'billing');
	await syncMemory(dir);
	await chamoji(['memory', 'archive', 'auth', '--purge'], dir);
	const {code, stdout} = await chamoji(['init'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('git push --force origin refs/chamoji/memory');
});

test('init works from a subdirectory', async () => {
	const {clone} = await withOrigin();
	const {code} = await chamoji(['init'], path.join(clone, '.chamoji'));
	expect(code).toBe(0);
	expect(await fetchLines(clone)).toContain(MEMORY_FETCH_REFSPEC);
});

test('init outside a repo reports it plainly', async () => {
	const {code, stderr} = await chamoji(['init'], await tempDir());
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: Not a git repository');
});

/** A folder holding an executable `chamoji`, for a PATH that has chamoji on it. */
async function withChamojiOnPath(): Promise<Record<string, string>> {
	const bin = await tempDir();
	await writeFile(path.join(bin, 'chamoji'), '#!/bin/sh\nexit 0\n');
	await chmod(path.join(bin, 'chamoji'), 0o755);
	return {PATH: bin};
}

const NO_CHAMOJI = {PATH: ''};

/** A byte order mark, built so that no invisible character sits in this source. */
const BOM = String.fromCharCode(0xfe_ff);

const read = async (dir: string, file: string) =>
	readFile(path.join(dir, file), 'utf8');

const missing = async (dir: string, file: string) =>
	(await stat(path.join(dir, file)).catch(() => null)) === null;

async function plainRepo(): Promise<string> {
	return (await repoFrom([{commit: '🎉 Init'}])).dir;
}

// The `|| true` keeps an older chamoji, which exits 2 on an unknown command,
// from blocking every commit.
const HOOK_COMMAND = 'chamoji agent-hook || true';
const NPX_HOOK_COMMAND = 'npx --yes @chamoji/cli agent-hook || true';

const hookEntry = (command: string) => ({
	matcher: 'Bash',
	hooks: [{type: 'command', if: 'Bash(git commit *)', command}],
});

test('init --agents writes both files in a repo that has neither', async () => {
	const dir = await plainRepo();
	const env = await withChamojiOnPath();
	const {code, stdout, stderr} = await chamoji(['init', '--agents'], dir, env);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toContain('.mcp.json: added the chamoji MCP server');
	expect(stdout).toContain('.claude/settings.json: added the commit hook');
	expect(stdout).toContain('meant to be committed');
	expect(stdout).not.toContain('npx');
	expect(await read(dir, '.mcp.json')).toBe(
		`${JSON.stringify({mcpServers: {chamoji: {command: 'chamoji', args: ['mcp']}}}, null, 2)}\n`,
	);
	expect(JSON.parse(await read(dir, '.claude/settings.json'))).toEqual({
		hooks: {PreToolUse: [hookEntry(HOOK_COMMAND)]},
	});
});

test('init --agents runs chamoji through npx when it is not on PATH', async () => {
	const dir = await plainRepo();
	const {stdout} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(stdout).toContain('start it with npx');
	expect(JSON.parse(await read(dir, '.mcp.json'))).toEqual({
		mcpServers: {
			chamoji: {command: 'npx', args: ['--yes', '@chamoji/cli', 'mcp']},
		},
	});
	expect(JSON.parse(await read(dir, '.claude/settings.json'))).toEqual({
		hooks: {PreToolUse: [hookEntry(NPX_HOOK_COMMAND)]},
	});
});

test('init --agents ignores a node_modules/.bin that npx put on PATH', async () => {
	const dir = await plainRepo();
	const bin = path.join(await tempDir(), 'node_modules', '.bin');
	await mkdir(bin, {recursive: true});
	await writeFile(path.join(bin, 'chamoji'), '#!/bin/sh\nexit 0\n');
	await chmod(path.join(bin, 'chamoji'), 0o755);
	await chamoji(['init', '--agents'], dir, {PATH: bin});
	expect(
		JSON.parse(await read(dir, '.mcp.json')).mcpServers.chamoji.command,
	).toBe('npx');
});

test('init --agents adds chamoji to an existing .mcp.json and keeps other servers', async () => {
	const dir = await plainRepo();
	const before = {
		mcpServers: {
			github: {command: 'gh-mcp', args: ['--readonly'], env: {A: '1'}},
		},
		other: [1, 2],
	};
	await writeFile(
		path.join(dir, '.mcp.json'),
		`${JSON.stringify(before, null, '\t')}\n`,
	);
	const env = await withChamojiOnPath();
	const {code, stdout} = await chamoji(['init', '--agents'], dir, env);
	expect(code).toBe(0);
	expect(stdout).toContain('.mcp.json: added the chamoji MCP server');
	const text = await read(dir, '.mcp.json');
	const after = JSON.parse(text);
	expect(after).toEqual({
		...before,
		mcpServers: {
			...before.mcpServers,
			chamoji: {command: 'chamoji', args: ['mcp']},
		},
	});
	// Their order and their tabs stay.
	expect(Object.keys(after)).toEqual(['mcpServers', 'other']);
	expect(Object.keys(after.mcpServers)).toEqual(['github', 'chamoji']);
	expect(text).toContain('\n\t"mcpServers": {\n\t\t"github"');
	expect(text.endsWith('}\n')).toBe(true);
});

test('init --agents keeps an mcp entry named chamoji that is already there', async () => {
	const dir = await plainRepo();
	const text = JSON.stringify({
		mcpServers: {chamoji: {command: '/opt/chamoji', args: ['mcp', '--ai']}},
	});
	await writeFile(path.join(dir, '.mcp.json'), text);
	const {stdout} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(stdout).toContain('.mcp.json: already has the chamoji MCP server');
	expect(await read(dir, '.mcp.json')).toBe(text);
});

test('init --agents keeps existing settings and hooks', async () => {
	const dir = await plainRepo();
	const before = {
		permissions: {allow: ['Bash(git status)']},
		hooks: {
			PostToolUse: [
				{matcher: 'Edit', hooks: [{type: 'command', command: 'fmt'}]},
			],
			PreToolUse: [
				{matcher: 'Bash', hooks: [{type: 'command', command: 'audit.sh'}]},
			],
		},
		model: 'opus',
	};
	await mkdir(path.join(dir, '.claude'));
	await writeFile(
		path.join(dir, '.claude', 'settings.json'),
		JSON.stringify(before, null, 4),
	);
	const env = await withChamojiOnPath();
	const {code, stdout} = await chamoji(['init', '--agents'], dir, env);
	expect(code).toBe(0);
	expect(stdout).toContain('.claude/settings.json: added the commit hook');
	const text = await read(dir, '.claude/settings.json');
	const after = JSON.parse(text);
	expect(after.permissions).toEqual(before.permissions);
	expect(after.model).toBe('opus');
	expect(after.hooks.PostToolUse).toEqual(before.hooks.PostToolUse);
	expect(after.hooks.PreToolUse).toEqual([
		...before.hooks.PreToolUse,
		hookEntry(HOOK_COMMAND),
	]);
	expect(Object.keys(after)).toEqual(['permissions', 'hooks', 'model']);
	expect(Object.keys(after.hooks)).toEqual(['PostToolUse', 'PreToolUse']);
	// Four spaces stay four spaces; no final newline stays none.
	expect(text).toContain('\n    "permissions"');
	expect(text.endsWith('\n')).toBe(false);
});

test('init --agents adds a hooks section to settings that have none', async () => {
	const dir = await plainRepo();
	await mkdir(path.join(dir, '.claude'));
	await writeFile(path.join(dir, '.claude', 'settings.json'), '{}\n');
	await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(JSON.parse(await read(dir, '.claude/settings.json'))).toEqual({
		hooks: {PreToolUse: [hookEntry(NPX_HOOK_COMMAND)]},
	});
});

test('init --agents keeps Windows line endings and a byte order mark', async () => {
	const dir = await plainRepo();
	await writeFile(
		path.join(dir, '.mcp.json'),
		`${BOM}${JSON.stringify({mcpServers: {}}, null, 2).replace(/\n/g, '\r\n')}\r\n`,
	);
	await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	const text = await read(dir, '.mcp.json');
	expect(text.startsWith(`${BOM}{\r\n  "mcpServers": {\r\n    "chamoji"`)).toBe(
		true,
	);
	expect(text.endsWith('}\r\n')).toBe(true);
	expect(text.replace(/\r\n/g, '')).not.toContain('\n');
});

test('init --agents twice adds nothing new', async () => {
	const dir = await plainRepo();
	const env = await withChamojiOnPath();
	await chamoji(['init', '--agents'], dir, env);
	const files = ['.mcp.json', '.claude/settings.json'];
	const texts = async () =>
		Promise.all(files.map(async file => read(dir, file)));
	const times = async () =>
		Promise.all(
			files.map(async file => (await stat(path.join(dir, file))).mtimeMs),
		);
	const [firstTexts, firstTimes] = [await texts(), await times()];
	await new Promise(resolve => {
		setTimeout(resolve, 20);
	});

	// Even after chamoji moves off PATH: what is there stays.
	const again = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(again.code).toBe(0);
	expect(again.stdout).toContain(
		'.mcp.json: already has the chamoji MCP server',
	);
	expect(again.stdout).toContain(
		'.claude/settings.json: already has the commit hook',
	);
	expect(again.stdout).not.toContain('meant to be committed');
	expect(await texts()).toEqual(firstTexts);
	expect(await times()).toEqual(firstTimes);
});

test('init --agents sees a hook that runs through a full path', async () => {
	const dir = await plainRepo();
	const text = JSON.stringify({
		hooks: {
			PreToolUse: [
				{hooks: [{type: 'command', command: '/opt/bin/chamoji agent-hook'}]},
			],
		},
	});
	await mkdir(path.join(dir, '.claude'));
	await writeFile(path.join(dir, '.claude', 'settings.json'), text);
	const {stdout} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(stdout).toContain(
		'.claude/settings.json: already has the commit hook',
	);
	expect(await read(dir, '.claude/settings.json')).toBe(text);
});

test('init --agents refuses a corrupt settings file', async () => {
	const dir = await plainRepo();
	await mkdir(path.join(dir, '.claude'));
	const corrupt = '{"hooks": {"PreToolUse": [,]}';
	await writeFile(path.join(dir, '.claude', 'settings.json'), corrupt);
	const {code, stdout, stderr} = await chamoji(
		['init', '--agents'],
		dir,
		NO_CHAMOJI,
	);
	expect(code).toBe(1);
	expect(stderr).toContain('.claude/settings.json is not valid JSON');
	expect(stderr).toContain('Nothing was changed');
	expect(stdout).toBe('');
	expect(await read(dir, '.claude/settings.json')).toBe(corrupt);
	// The other file waits too, so one run does all or none.
	expect(await missing(dir, '.mcp.json')).toBe(true);
});

test('init --agents refuses a corrupt .mcp.json and leaves it as it was', async () => {
	const dir = await plainRepo();
	await writeFile(path.join(dir, '.mcp.json'), '{"mcpServers": ');
	const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(1);
	expect(stderr).toContain('.mcp.json is not valid JSON');
	expect(await read(dir, '.mcp.json')).toBe('{"mcpServers": ');
	expect(await missing(dir, '.claude')).toBe(true);
});

test('init --agents refuses files that are not the shape it needs', async () => {
	for (const [file, text, what] of [
		['.mcp.json', '[]', 'is not a JSON object'],
		['.mcp.json', 'null', 'is not a JSON object'],
		['.mcp.json', '{"mcpServers": []}', 'a "mcpServers" that is not an object'],
		[
			'.mcp.json',
			'{"mcpServers": "x"}',
			'a "mcpServers" that is not an object',
		],
		[
			'.claude/settings.json',
			'{"hooks": []}',
			'a "hooks" that is not an object',
		],
		[
			'.claude/settings.json',
			'{"hooks": {"PreToolUse": {}}}',
			'a "hooks.PreToolUse" that is not a list',
		],
	] as const) {
		const dir = await plainRepo();
		await mkdir(path.join(dir, '.claude'));
		await writeFile(path.join(dir, file), text);
		const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
		expect(code).toBe(1);
		expect(stderr).toContain(what);
		expect(await read(dir, file)).toBe(text);
	}
});

test('init --agents refuses a symlinked file and writes through nothing', async () => {
	const dir = await plainRepo();
	const elsewhere = path.join(await tempDir(), 'shared.json');
	await writeFile(elsewhere, '{}\n');
	await symlink(elsewhere, path.join(dir, '.mcp.json'));
	const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(1);
	expect(stderr).toContain('.mcp.json is a symlink');
	expect(await readFile(elsewhere, 'utf8')).toBe('{}\n');
	expect(await missing(dir, '.claude')).toBe(true);
});

test('init --agents refuses a symlinked .claude folder', async () => {
	const dir = await plainRepo();
	const elsewhere = await tempDir();
	await symlink(elsewhere, path.join(dir, '.claude'));
	const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(1);
	expect(stderr).toContain(
		'.claude/settings.json is inside a symlinked folder',
	);
	expect(await missing(elsewhere, 'settings.json')).toBe(true);
	expect(await missing(dir, '.mcp.json')).toBe(true);
});

test('init --agents refuses a folder where a file should be', async () => {
	const dir = await plainRepo();
	await mkdir(path.join(dir, '.mcp.json'));
	const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(1);
	expect(stderr).toContain('.mcp.json is not a file');
});

test('init --agents refusing a file also leaves the fetch refspec alone', async () => {
	const {clone} = await withOrigin();
	await writeFile(path.join(clone, '.mcp.json'), '{');
	const {code} = await chamoji(['init', '--agents'], clone, NO_CHAMOJI);
	expect(code).toBe(1);
	expect(await fetchLines(clone)).toEqual([
		'+refs/heads/*:refs/remotes/origin/*',
	]);
});

test('init --agents keeps a __proto__ key as data and does not pollute', async () => {
	const dir = await plainRepo();
	await writeFile(
		path.join(dir, '.mcp.json'),
		'{"__proto__": {"chamoji": true}, "mcpServers": {"__proto__": {"x": 1}}}',
	);
	const {code} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(0);
	const after = JSON.parse(await read(dir, '.mcp.json'));
	expect(Object.hasOwn(after.mcpServers, 'chamoji')).toBe(true);
	expect(Object.hasOwn(after, '__proto__')).toBe(true);
	expect(({} as Record<string, unknown>).chamoji).toBeUndefined();
});

test('init --agents with no origin still sets up the agent files', async () => {
	const dir = await plainRepo();
	const {code, stdout} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(0);
	expect(stdout).toContain('.mcp.json: added');
	expect(stdout).toContain('No remote named origin');
});

test('init --agents on a clone also sets up memory sharing', async () => {
	const {clone} = await withOrigin();
	const {code, stdout} = await chamoji(['init', '--agents'], clone, NO_CHAMOJI);
	expect(code).toBe(0);
	expect(stdout).toContain('.claude/settings.json: added the commit hook');
	expect(stdout).toContain('origin now fetches chamoji memory');
	expect(await fetchLines(clone)).toContain(MEMORY_FETCH_REFSPEC);
});

test('init --agents from a subdirectory writes at the repo root', async () => {
	const dir = await plainRepo();
	const sub = path.join(dir, 'packages', 'app');
	await mkdir(sub, {recursive: true});
	const {code} = await chamoji(['init', '--agents'], sub, NO_CHAMOJI);
	expect(code).toBe(0);
	expect(await missing(dir, '.mcp.json')).toBe(false);
	expect(await missing(sub, '.mcp.json')).toBe(true);
	expect(await missing(sub, '.claude')).toBe(true);
});

test('plain init writes neither file', async () => {
	const {clone} = await withOrigin();
	const {code} = await chamoji(['init'], clone, NO_CHAMOJI);
	expect(code).toBe(0);
	expect(await missing(clone, '.mcp.json')).toBe(true);
	expect(await missing(clone, '.claude')).toBe(true);
	const none = await plainRepo();
	await chamoji(['init'], none, NO_CHAMOJI);
	expect(await missing(none, '.mcp.json')).toBe(true);
	expect(await missing(none, '.claude')).toBe(true);
});

test('the hook commands are exactly these, each ending in || true', async () => {
	expect(HOOK_COMMAND).toBe('chamoji agent-hook || true');
	expect(NPX_HOOK_COMMAND).toBe('npx --yes @chamoji/cli agent-hook || true');
	for (const [env, command] of [
		[await withChamojiOnPath(), 'chamoji agent-hook || true'],
		[NO_CHAMOJI, 'npx --yes @chamoji/cli agent-hook || true'],
	] as const) {
		const dir = await plainRepo();
		await chamoji(['init', '--agents'], dir, env);
		const settings = JSON.parse(await read(dir, '.claude/settings.json'));
		expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(command);
	}
});

test('the hook command exits 0 through a real shell when chamoji exits 2', async () => {
	for (const [name, env] of [
		['chamoji', undefined],
		['npx', NO_CHAMOJI],
	] as const) {
		const dir = await plainRepo();
		const bin = await tempDir();
		await chamoji(
			['init', '--agents'],
			dir,
			env ?? (await withChamojiOnPath()),
		);
		const {command} = JSON.parse(await read(dir, '.claude/settings.json')).hooks
			.PreToolUse[0].hooks[0];
		const stub = async (script: string) => {
			await writeFile(path.join(bin, name), `#!/bin/sh\n${script}\n`);
			await chmod(path.join(bin, name), 0o755);
			return spawnSync('/bin/sh', ['-c', command], {
				env: {PATH: bin},
				encoding: 'utf8',
			});
		};

		// An older chamoji prints its help and exits 2, which would block the commit.
		const old = await stub('echo usage >&2\nexit 2');
		expect(old.status).toBe(0);
		expect(old.stdout).toBe('');

		// A denial is JSON on stdout with exit 0, and gets through.
		const deny = await stub('echo \'{"deny":true}\'');
		expect(deny.status).toBe(0);
		expect(deny.stdout).toBe('{"deny":true}\n');
	}
});

test('init --agents refuses a number that would not be written back exactly', async () => {
	for (const number of [
		'12345678901234567890',
		'1e999',
		'0.1000000000000000055511',
	]) {
		const dir = await plainRepo();
		const text = `{"id": ${number}, "mcpServers": {}}`;
		await writeFile(path.join(dir, '.mcp.json'), text);
		const {code, stdout, stderr} = await chamoji(
			['init', '--agents'],
			dir,
			NO_CHAMOJI,
		);
		expect(code).toBe(1);
		expect(stderr).toContain(`.mcp.json has the number ${number}`);
		expect(stderr).toContain('Nothing was changed');
		expect(stdout).toBe('');
		expect(await read(dir, '.mcp.json')).toBe(text);
		expect(await missing(dir, '.claude')).toBe(true);
	}
});

test('init --agents keeps numbers that come back the same', async () => {
	const dir = await plainRepo();
	await writeFile(
		path.join(dir, '.mcp.json'),
		'{"a": 1.5e3, "b": 0.10, "c": -0, "d": 9007199254740991, "e": 1E2, "s": "12345678901234567890 1e999", "mcpServers": {}}',
	);
	const {code} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(0);
	const after = JSON.parse(await read(dir, '.mcp.json'));
	expect(after).toMatchObject({
		a: 1500,
		b: 0.1,
		d: 9_007_199_254_740_991,
		e: 100,
	});
	expect(after.s).toBe('12345678901234567890 1e999');
});

test('init --agents says the layout of a changed file may differ', async () => {
	const dir = await plainRepo();
	const {stdout} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(stdout).toContain('written back as plain JSON');
	expect(stdout).toContain('layout');
});

test('init --agents leaves no temp file and keeps the permissions of a file it replaces', async () => {
	const dir = await plainRepo();
	await writeFile(path.join(dir, '.mcp.json'), '{}\n');
	await chmod(path.join(dir, '.mcp.json'), 0o600);
	const {code} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(0);
	expect((await stat(path.join(dir, '.mcp.json'))).mode & 0o777).toBe(0o600);
	expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual(
		[],
	);
	expect(await readdir(path.join(dir, '.claude'))).toEqual(['settings.json']);
});

test.skipIf(process.getuid?.() === 0)(
	'init --agents says which file it already changed when the next cannot be written',
	async () => {
		const dir = await plainRepo();
		const claude = path.join(dir, '.claude');
		await mkdir(claude);
		const before = '{"model": "opus"}\n';
		await writeFile(path.join(claude, 'settings.json'), before);
		await chmod(claude, 0o555);
		let result;
		try {
			result = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
		} finally {
			// Back before the folder is removed.
			await chmod(claude, 0o755);
		}

		const {code, stdout, stderr} = result;
		expect(code).toBe(1);
		expect(stderr).toContain("chamoji: couldn't write .claude/settings.json");
		expect(stderr).toContain('.mcp.json was already changed');
		expect(stderr).not.toContain('Nothing was changed');
		expect(stdout).toContain('.mcp.json: added');
		expect(
			JSON.parse(await read(dir, '.mcp.json')).mcpServers.chamoji,
		).toBeDefined();
		// The file it could not replace is whole, and no temp file is left.
		expect(await read(dir, '.claude/settings.json')).toBe(before);
		expect(await readdir(claude)).toEqual(['settings.json']);
		expect(await readdir(dir)).not.toContain('.mcp.json.tmp');
		expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual(
			[],
		);
	},
);

test.skipIf(process.getuid?.() === 0)(
	'init --agents says nothing was changed when the first file cannot be written',
	async () => {
		const dir = await plainRepo();
		await chmod(dir, 0o555);
		let result;
		try {
			result = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
		} finally {
			await chmod(dir, 0o755);
		}

		const {code, stderr} = result;
		expect(code).toBe(1);
		expect(stderr).toContain("chamoji: couldn't write .mcp.json");
		expect(stderr).toContain('Nothing was changed');
	},
);

test('init --agents gives a plain refusal when .claude is a file', async () => {
	const dir = await plainRepo();
	await writeFile(path.join(dir, '.claude'), 'not a folder');
	const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
	expect(code).toBe(1);
	expect(stderr).toContain(
		'.claude/settings.json needs .claude to be a folder, but it is something else',
	);
	expect(stderr).toContain('Nothing was changed');
	expect(stderr).not.toContain('ENOTDIR');
	expect(await read(dir, '.claude')).toBe('not a folder');
	expect(await missing(dir, '.mcp.json')).toBe(true);
});

test('init --agents treats an empty or blank file as {}', async () => {
	for (const blank of ['', '   ', '\n\n', BOM, ' \t\r\n']) {
		const dir = await plainRepo();
		await mkdir(path.join(dir, '.claude'));
		await writeFile(path.join(dir, '.mcp.json'), blank);
		await writeFile(path.join(dir, '.claude', 'settings.json'), blank);
		const {code, stderr} = await chamoji(['init', '--agents'], dir, NO_CHAMOJI);
		expect(stderr).toBe('');
		expect(code).toBe(0);
		const json = async (file: string) =>
			JSON.parse((await read(dir, file)).replace(BOM, ''));
		expect((await json('.mcp.json')).mcpServers.chamoji).toBeDefined();
		expect((await json('.claude/settings.json')).hooks.PreToolUse).toHaveLength(
			1,
		);
	}
});
