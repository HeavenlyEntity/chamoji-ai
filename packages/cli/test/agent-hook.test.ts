import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough, Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {parseCommit, readCommits} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {createRepo, gitOutput} from '../../core/test/helpers/fixture-repo.js';
import {DENY_REASON, decideCommit, runAgentHook} from '../src/agent-hook.js';

const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

const heredoc = (card: string) =>
	[
		`git commit -m "$(cat <<'EOF'`,
		'✨ Add login',
		'',
		'The old form said "no" to everyone (see #12).',
		'',
		card,
		'EOF',
		')"',
	].join('\n');

const ALLOWED: Array<[string, string]> = [
	['a Why line', 'git commit -m "x\n\nWhy: y"'],
	['a Why line in single quotes', "git commit -m 'x\n\nWhy: y'"],
	['a Why line in a second -m', 'git commit -m x -m "Why: y"'],
	['a Why line in a combined -am', 'git commit -am "x\n\nWhy: y"'],
	['a Why line after --message=', 'git commit --message="x\n\nWhy: y"'],
	['a Why trailer', 'git commit -m x --trailer "Why: y"'],
	['a Why trailer after =', 'git commit -m x --trailer="Why: y"'],
	['a lower-case key', 'git commit -m "x\n\nwhy: y"'],
	['a Why line with CRLF line endings', 'git commit -m "x\r\n\r\nWhy: y"'],
	[
		'a Why line after a CRLF blank line with spaces',
		'git commit -m "x\r\n \r\nWhy: y"',
	],
	[
		'a no-space Why trailer with CRLF line endings',
		'git commit -m "x\r\n\r\nWhy:y"',
	],
	[
		'a Why trailer after other trailers with CRLF',
		'git commit -m "x\r\n\r\nSigned-off-by: A <a@b.example>\r\nWhy:y"',
	],
	[
		'an indented Why line, which the parser trims',
		'git commit -m "x\n\n  Why: y"',
	],
	[
		'a Why trailer with no space, as git writes it',
		'git commit -m "x\n\nWhy:y"',
	],
	[
		'a Why trailer with no space after --trailer',
		'git commit -m x --trailer "Why:y"',
	],
	['a Follow-up line', 'git commit -m "x\n\nFollow-up: y"'],
	['a Gotcha line', 'git commit -m "x\n\nGotcha: y"'],
	['a heredoc holding Constraint', heredoc('Constraint: y')],
	[
		'a heredoc with quotes and parentheses',
		heredoc('Why: they said "no" (twice'),
	],
	['a heredoc fed to -F', "git commit -F - <<'EOF'\nx\n\nWhy: y\nEOF"],
	['a heredoc and a later command', `${heredoc('Why: y')}\ngit status`],
	['an escaped quote around Why', 'git commit -m "x\n\n\\"quoted\\"\nWhy: y"'],
	['--amend --no-edit', 'git commit --amend --no-edit'],
	['--no-edit alone', 'git commit --no-edit'],
	['-F with a file', 'git commit -F msg.txt'],
	['--file=', 'git commit --file=msg.txt'],
	['-C', 'git commit -C HEAD~1'],
	['--reuse-message', 'git commit --reuse-message=HEAD'],
	['--fixup', 'git commit --fixup HEAD'],
	['--fixup=amend:', 'git commit --fixup=amend:HEAD~2'],
	['--squash', 'git commit --squash HEAD'],
	['--dry-run', 'git commit --dry-run'],
	['--dry-run with a message', 'git commit -m x --dry-run'],
	['--help', 'git commit --help'],
	['-h', 'git commit -h'],
	['a different subcommand', 'git log --grep commit'],
	['another command that says git commit', 'echo git commit'],
	['a quoted mention', 'echo "git commit -m x"'],
	['a mention in a heredoc', "cat > hook.sh <<'EOF'\ngit commit -m x\nEOF"],
	['a mention after a comment mark', 'ls # git commit -m x'],
	['a command that is not git', 'gitk commit -m x'],
	['git with no subcommand', 'git'],
	['the opt-out', 'CHAMOJI_NO_CARD=1 git commit -m x'],
	[
		'the opt-out after other variables',
		'A=1 CHAMOJI_NO_CARD=1 B=2 git commit -m x',
	],
	['the opt-out through env', 'env CHAMOJI_NO_CARD=1 git commit -m x'],
	['the opt-out and git options', 'CHAMOJI_NO_CARD=1 git -C repo commit -m x'],
	['an empty command', ''],
	["a Why line in $'…' quotes", "git commit -m $'x\\n\\nWhy: y'"],
	[
		"a Why line with an escaped quote in $'…'",
		"git commit -m $'it\\'s\\n\\nWhy: y'",
	],
	[
		"a Why line with hex and octal escapes in $'…'",
		"git commit -m $'\\x78\\012\\012Why: \\171'",
	],
	['a Why line in $"…" quotes', 'git commit -m $"x\n\nWhy: y"'],
	// Known gap, pinned: shell keywords such as then and do are not skipped,
	// so a commit that follows one is not seen.
	['a commit after then (known gap)', 'if true; then git commit -m x; fi'],
];

const DENIED: Array<[string, string]> = [
	['no card', 'git commit -m "x"'],
	['no card, single quotes', "git commit -m 'x'"],
	['a card line as the subject', 'git commit -m "Why: because"'],
	[
		'a card line as the subject with CRLF',
		'git commit -m "Why: a\r\n\r\nmore"',
	],
	[
		'a Why line in the subject paragraph with CRLF',
		'git commit -m "x\r\nWhy: y"',
	],
	['CRLF line endings and no card', 'git commit -m "x\r\n\r\nmore words"'],
	[
		'a card line as the subject in single quotes',
		"git commit -m 'Why: because'",
	],
	['a card line as the subject, then no card', 'git commit -m "Why: a" -m b'],
	['a card line as the subject with a body', 'git commit -m "Why: a\n\nmore"'],
	['a Why line in the subject paragraph', 'git commit -m "x\nWhy: y"'],
	['a no-space Why in the subject paragraph', 'git commit -m "x\nWhy:y"'],
	['a no-space Why among prose', 'git commit -m "x\n\nsome prose\nWhy:y"'],
	['a no-space Why before more prose', 'git commit -m "x\n\nWhy:y\n\nmore"'],
	['a lone -m without a message', 'git commit -m'],
	['add then commit', 'git add . && git commit -m x'],
	['commit after a semicolon', 'git add .; git commit -m x'],
	['commit after a newline', 'git add .\ngit commit -m x'],
	['commit after a pipe', 'echo | git commit -m x'],
	['commit in a substitution', 'echo $(git commit -m x)'],
	['-C to another repo', 'git -C repo commit -m x'],
	['-c config', 'git -c user.name=Bot commit -m x'],
	['--no-pager', 'git --no-pager commit -m x'],
	['a path to git', '/usr/bin/git commit -m x'],
	['a bare commit', 'git commit'],
	['a bare commit -a', 'git commit -a'],
	['--amend with a message', 'git commit --amend -m "x"'],
	['--no-edit with a message', 'git commit -m x --no-edit'],
	['a heredoc with no card', heredoc('Just some words')],
	['a card line with no text', 'git commit -m "x\n\nWhy:"'],
	['Why in the middle of a line', 'git commit -m "I wonder Why: this"'],
	['a card in another command', "cat <<'EOF'\nWhy: y\nEOF\ngit commit -m x"],
	['a card in an echo', 'echo "Why: y" && git commit -m x'],
	[
		'the opt-out for another command',
		'CHAMOJI_NO_CARD=1 git add . && git commit -m x',
	],
	['the opt-out spelled otherwise', 'CHAMOJI_NO_CARD=0 git commit -m x'],
	[
		'a second commit that has none',
		'git commit -m "a\n\nWhy: b" && git commit -m c',
	],
	['-m "-F"', 'git commit -m "-F"'],
	['an unterminated quote', 'git commit -m "x'],
	['a here-string', 'git commit -m x <<< "Why: y"'],
	["no card in $'…' quotes", "git commit -m $'x'"],
	['a quoted newline escape that is not a line', "git commit -m 'x\\nWhy: y'"],
	["an escaped backslash before n in $'…'", "git commit -m $'x\\\\nWhy: y'"],
	["$'…' that hides a semicolon", "git add $'a;b' && git commit -m $'x'"],
];

test.each(ALLOWED)('decideCommit allows %s', (_name, command) => {
	expect(decideCommit(command)).toBe('allow');
});

test.each(DENIED)('decideCommit denies %s', (_name, command) => {
	expect(decideCommit(command)).toBe('deny');
});

test('decideCommit agrees with the card parser on real commits', async () => {
	// Each message goes through a real `git commit` and the parser, then the
	// hook is asked about the same text. Single quotes keep the shell text plain.
	const messages = [
		'Why: because',
		'Why: because\n\nmore words',
		'x',
		'x\n\nWhy: y',
		'x\n\n  Why: y',
		'x\n\n\tWhy: y',
		'x\nWhy: y',
		'x\n\nWhy:y',
		'x\n\nGotcha:y\nFollow-up:\tz',
		'x\nWhy:y',
		'x\n\nsome prose\nWhy:y',
		'x\n\nWhy:y\n\nclosing prose',
		'x\n\nWhy:',
		'x\n\nWhy: y\nSigned-off-by: A <a@b.example>',
		'x\n\nSigned-off-by: A <a@b.example>\nWhy:y',
		'x\n\nI wonder Why: this',
		'x\n\nWhy y',
		'x\r\n\r\nWhy: y',
		'x\r\n\r\nWhy:y',
		'x\r\nWhy: y',
	];
	const repo = await createRepo([{commit: '🎉 Init'}]);
	cleanups.push(async () => repo.cleanup());
	for (const message of messages) {
		await gitOutput(repo.dir, [
			'commit',
			'-q',
			'--allow-empty',
			'--cleanup=verbatim',
			'-m',
			message,
		]);
		const [raw] = await readCommits(repo.dir, 'HEAD');
		const hasCard = parseCommit(raw!).card !== undefined;
		expect([message, decideCommit(`git commit -m '${message}'`)]).toEqual([
			message,
			hasCard ? 'allow' : 'deny',
		]);
	}
});

test('decideCommit does not choke on odd text', () => {
	for (const command of [
		"git commit -m $'x",
		"git commit -m $'x\\",
		"git commit -m $'\\x",
		'echo "$(echo $\'a)b\')" && git commit -m x',
		'git commit -m "$(',
		"git commit -m \"$(cat <<'EOF'",
		'git commit <<',
		'git commit -m \\',
		'`git commit',
		'git commit -m "`",',
		'(((((',
		')))))',
		'git commit -m $(git commit -m $(git commit -m x))',
	]) {
		expect(['allow', 'deny']).toContain(decideCommit(command));
	}
});

/** Runs the hook on `input` and gathers what it printed. */
async function hook(input: string | Buffer | Readable) {
	let stdout = '';
	let stderr = '';
	const code = await runAgentHook({
		cwd: process.cwd(),
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		stdin: input instanceof Readable ? input : Readable.from([input]),
	});
	return {code, stdout, stderr};
}

const bash = (command: unknown) =>
	JSON.stringify({
		hook_event_name: 'PreToolUse',
		tool_name: 'Bash',
		tool_input: {command},
	});

test('a commit with no card is denied with the reason', async () => {
	const {code, stdout, stderr} = await hook(bash('git commit -m x'));
	expect(code).toBe(0);
	expect(stderr).toBe('');
	expect(JSON.parse(stdout)).toEqual({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: DENY_REASON,
		},
	});
	expect(stdout.endsWith('\n')).toBe(true);
	expect(DENY_REASON).toBe(
		'Add why this change was made: put a "Why: <reason>" line at the end of the commit message, after a blank line. Constraint:, Gotcha: and Follow-up: lines are welcome too. Only if the user told you to skip this, prefix the command with CHAMOJI_NO_CARD=1.',
	);
});

test('a commit with a card prints nothing', async () => {
	expect(await hook(bash('git commit -m "x\n\nWhy: y"'))).toEqual({
		code: 0,
		stdout: '',
		stderr: '',
	});
});

test('bad JSON on stdin prints nothing and exits 0', async () => {
	for (const input of ['{not json', '', 'null', '[]', '"git commit"', '7']) {
		expect(await hook(input)).toEqual({code: 0, stdout: '', stderr: ''});
	}
});

test('a tool other than Bash prints nothing', async () => {
	for (const input of [
		JSON.stringify({
			tool_name: 'Write',
			tool_input: {command: 'git commit -m x'},
		}),
		JSON.stringify({
			tool_name: 'bash',
			tool_input: {command: 'git commit -m x'},
		}),
		JSON.stringify({tool_input: {command: 'git commit -m x'}}),
	]) {
		expect(await hook(input)).toEqual({code: 0, stdout: '', stderr: ''});
	}
});

test('input without a command string prints nothing', async () => {
	for (const command of [undefined, null, 7, ['git', 'commit'], {a: 1}]) {
		expect(await hook(bash(command))).toEqual({
			code: 0,
			stdout: '',
			stderr: '',
		});
	}

	for (const input of [
		JSON.stringify({tool_name: 'Bash'}),
		JSON.stringify({tool_name: 'Bash', tool_input: 'git commit -m x'}),
		JSON.stringify({tool_name: 'Bash', tool_input: ['git commit -m x']}),
	]) {
		expect(await hook(input)).toEqual({code: 0, stdout: '', stderr: ''});
	}
});

test('keys that only the prototype has are not read', async () => {
	// A parsed `__proto__` key is an own property, and nothing inherited counts.
	const polluted =
		'{"__proto__": {"tool_name": "Bash", "tool_input": {"command": "git commit -m x"}}}';
	expect(await hook(polluted)).toEqual({code: 0, stdout: '', stderr: ''});
	const nested =
		'{"tool_name": "Bash", "tool_input": {"__proto__": {"command": "git commit -m x"}}}';
	expect(await hook(nested)).toEqual({code: 0, stdout: '', stderr: ''});
	// The real fields still work beside a `__proto__` one.
	const beside = `{"__proto__": {"x": 1}, "tool_name": "Bash", "tool_input": {"command": "git commit -m x"}}`;
	expect((await hook(beside)).stdout).toContain('"permissionDecision":"deny"');
});

test('input past the size cap prints nothing', async () => {
	const padding = 'a'.repeat(1024 * 1024);
	const huge = JSON.stringify({
		tool_name: 'Bash',
		tool_input: {command: `git commit -m x # ${padding}`},
	});
	expect(await hook(huge)).toEqual({code: 0, stdout: '', stderr: ''});
});

test('input in many chunks is read whole', async () => {
	const input = Buffer.from(bash('git commit -m "ünï ✨"'));
	// Split inside a multi-byte character.
	const at = input.indexOf(0xc3) + 1;
	const stdin = Readable.from([input.subarray(0, at), input.subarray(at)]);
	expect((await hook(stdin)).stdout).toContain('"permissionDecision":"deny"');
});

test('a stream that breaks prints nothing', async () => {
	const stdin = new PassThrough();
	stdin.write('{"tool_name":');
	setImmediate(() => stdin.destroy(new Error('closed')));
	expect(await hook(stdin)).toEqual({code: 0, stdout: '', stderr: ''});
});

test('a pathological command still ends in a decision or silence', async () => {
	const command = `git commit -m ${'"$('.repeat(20_000)}`;
	const result = await hook(bash(command));
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
});

/** Runs the built CLI the way Claude Code does. */
async function spawnHook(input: string, extra: string[] = []) {
	const cwd = await mkdtemp(path.join(tmpdir(), 'chamoji-agent-hook-'));
	try {
		const child = spawn(process.execPath, [cliJs, 'agent-hook', ...extra], {
			cwd,
			env: {...process.env, TYPESAFE_API_KEY: ''},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => (stdout += String(chunk)));
		child.stderr.on('data', chunk => (stderr += String(chunk)));
		const exited = new Promise<number | null>(resolve => {
			child.on('close', resolve);
		});
		child.stdin.end(input);
		return {code: await exited, stdout, stderr};
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
}

test('the CLI prints only the decision, with no update notice or error', async () => {
	const denied = await spawnHook(bash('git commit -m x'));
	expect(denied.code).toBe(0);
	expect(denied.stderr).toBe('');
	expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe(
		'deny',
	);

	const allowed = await spawnHook(bash('git commit -m "x\n\nWhy: y"'));
	expect(allowed).toEqual({code: 0, stdout: '', stderr: ''});

	// Not even --ai, or a bad input, may add output or change the exit code.
	expect(await spawnHook('{broken', ['--ai'])).toEqual({
		code: 0,
		stdout: '',
		stderr: '',
	});
});
