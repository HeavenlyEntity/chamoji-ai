import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

/**
 * A stand-in for ssh that refuses with git's "Permission denied (publickey)"
 * when GIT_TERMINAL_PROMPT=0, as a key that needs its passphrase would under
 * the quiet env, and otherwise runs the remote command on this machine. Point
 * a remote at `ssh://localhost/<absolute path>` and set the returned
 * variables in the environment. POSIX only: the command runs through `sh`.
 */
export async function fakeSsh(): Promise<{
	env: Record<string, string>;
	cleanup: () => Promise<void>;
}> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-ssh-'));
	const script = path.join(dir, 'ssh.mjs');
	await writeFile(
		script,
		[
			"import {spawn} from 'node:child_process';",
			"if (process.env.GIT_TERMINAL_PROMPT === '0') {",
			"\tprocess.stderr.write('Permission denied (publickey).\\n');",
			'\tprocess.exit(255);',
			'}',
			"const child = spawn('sh', ['-c', process.argv.at(-1)], {stdio: 'inherit'});",
			"child.on('exit', code => process.exit(code ?? 1));",
			'',
		].join('\n'),
	);
	return {
		env: {
			GIT_SSH_COMMAND: `"${process.execPath}" "${script}"`,
			GIT_SSH_VARIANT: 'simple',
		},
		cleanup: async () => rm(dir, {recursive: true, force: true}),
	};
}
