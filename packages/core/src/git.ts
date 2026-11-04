import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import semver from 'semver';
import type {RawCommit} from './types.js';

const execFileAsync = promisify(execFile);

// Tag lines are framed with this; commit text is not, see `readCommits`.
const FIELD = '\u001F';

export type ReleaseTag = {name: string; date: string};

/**
 * Runs git without a shell and returns stdout. `env` adds to the process
 * environment; it's for the commands that talk to a remote.
 */
export async function runGit(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<string> {
	const {stdout} = await execFileAsync('git', args, {
		cwd,
		...(env ? {env: {...process.env, ...env}} : {}),
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

/**
 * The environment that keeps a network git command from asking anything, so a
 * redrawing line can't overwrite a prompt. A missing password then fails the
 * command, which `isAuthFailure` recognises. A configured ssh command is left
 * alone, and so is one in the environment (GIT_SSH_COMMAND or GIT_SSH).
 */
export async function quietGitEnv(
	cwd: string,
): Promise<Record<string, string>> {
	const env: Record<string, string> = {GIT_TERMINAL_PROMPT: '0'};
	// GIT_SSH is the older way to name an ssh program; GIT_SSH_COMMAND would
	// override it, so either one being set leaves ssh alone.
	if (
		process.env.GIT_SSH_COMMAND !== undefined ||
		process.env.GIT_SSH !== undefined
	) {
		return env;
	}

	// Exit 1 means no value at all.
	const configured = await runGit(['config', '--get', 'core.sshCommand'], cwd)
		.then(stdout => stdout.trim())
		.catch(() => '');
	if (configured === '') env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
	return env;
}

const AUTH_FAILURES = [
	'terminal prompts disabled',
	'could not read Username',
	'could not read Password',
	'Authentication failed',
	// ssh's refusal, whatever it tried: publickey, password, keyboard-interactive.
	'Permission denied (',
	'Host key verification failed',
];

/**
 * Whether a git failure was a credential or key problem. Core wraps git's
 * stderr into its own messages, so the message is searched as well as `stderr`.
 */
export function isAuthFailure(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const {message, stderr} = error as {message?: unknown; stderr?: unknown};
	const text = [message, stderr]
		.filter((part): part is string => typeof part === 'string')
		.join('\n');
	return AUTH_FAILURES.some(phrase => text.includes(phrase));
}

/**
 * `runGit` for the plumbing that reads stdin. `env` adds to the environment
 * for commands whose result must not depend on it.
 */
export async function runGitWithInput(
	args: string[],
	cwd: string,
	input: string,
	env?: Record<string, string>,
): Promise<string> {
	const running = execFileAsync('git', args, {
		cwd,
		env: {...process.env, ...env},
		maxBuffer: 64 * 1024 * 1024,
	});
	// Git can exit before reading it all; its exit code is what gets reported.
	running.child.stdin?.on('error', () => {});
	running.child.stdin?.end(input);
	const {stdout} = await running;
	return stdout;
}

export async function assertGitRepo(cwd: string): Promise<void> {
	try {
		await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
	} catch (error) {
		const {code, stderr} = error as NodeJS.ErrnoException & {stderr?: string};
		if (code === 'ENOENT') {
			throw new Error('git is not installed or not on PATH');
		}

		if (stderr?.includes('not a git repository')) {
			throw new Error(`Not a git repository: ${cwd}`);
		}

		throw new Error(stderr?.trim() || (error as Error).message);
	}
}

export async function assertRevision(cwd: string, ref: string): Promise<void> {
	try {
		await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
	} catch {
		throw new Error(
			ref === 'HEAD'
				? 'Repository has no commits yet'
				: `Unknown revision: ${ref}`,
		);
	}
}

const COMMIT_FIELDS = [
	'%H',
	'%h',
	'%an',
	'%ae',
	'%aI',
	'%s',
	'%b',
	'%(trailers:only,unfold)',
];

/**
 * Non-merge commits in `range` (anything `git log` accepts), newest first.
 * Fields are framed with NUL, which a commit message can't hold, so no commit
 * text can forge or split a record. `-z` ends each record with a NUL too, so
 * the output is a flat list of fields, read one record's worth at a time.
 */
export async function readCommits(
	cwd: string,
	range: string,
): Promise<RawCommit[]> {
	const stdout = await runGit(
		[
			'log',
			'-z',
			'--no-merges',
			'--no-show-signature',
			`--format=${COMMIT_FIELDS.join('%x00')}`,
			'--end-of-options',
			range,
			'--',
		],
		cwd,
	);

	const fields = stdout.split('\0');
	fields.pop(); // Empty: the last record's NUL ends the output.
	const size = COMMIT_FIELDS.length;
	const commits: RawCommit[] = [];
	for (let i = 0; i + size <= fields.length; i += size) {
		const [
			hash,
			shortHash,
			authorName,
			authorEmail,
			date,
			subject,
			body,
			trailers,
		] = fields.slice(i, i + size);
		commits.push({
			hash: hash!,
			shortHash: shortHash!,
			authorName: authorName!,
			authorEmail: authorEmail!,
			date: date!,
			subject: subject!,
			body: body!,
			trailers: trailers!,
		});
	}

	return commits;
}

/**
 * Semver tags reachable from `to`, newest first. `date` is the tagged
 * commit's committer date, so annotated and lightweight tags agree, in UTC
 * so it matches the date `--release` writes.
 */
export async function listReleaseTags(
	cwd: string,
	to: string,
): Promise<ReleaseTag[]> {
	const stdout = await runGit(
		[
			'tag',
			`--merged=${to}`,
			'--format=%(refname:strip=2)%1f%(committerdate:iso-strict)%1f%(*committerdate:iso-strict)',
		],
		cwd,
	);

	return stdout
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [name, direct, dereferenced] = line.split(FIELD);
			const date = dereferenced || direct;
			return {
				name: name!,
				date: date ? new Date(date).toISOString() : '',
			};
		})
		.filter(tag => semver.valid(tag.name) !== null)
		.sort((a, b) => semver.rcompare(a.name, b.name));
}

/** `origin` as an https web URL, or undefined when there is none. */
export async function getRemoteWebUrl(
	cwd: string,
): Promise<string | undefined> {
	try {
		return toWebUrl(
			(await runGit(['remote', 'get-url', 'origin'], cwd)).trim(),
		);
	} catch {
		return undefined;
	}
}

/** Converts an ssh, scp-style or http(s) git remote to a browsable URL. */
export function toWebUrl(remote: string): string | undefined {
	const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(remote);
	if (scp && !/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
		return `https://${scp[1]}/${stripGitSuffix(scp[2]!)}`;
	}

	let url: URL;
	try {
		url = new URL(remote);
	} catch {
		return undefined;
	}

	if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) {
		return undefined;
	}

	const protocol = url.protocol === 'http:' ? 'http' : 'https';
	const host =
		url.protocol === 'https:' || url.protocol === 'http:'
			? url.host
			: url.hostname;
	return `${protocol}://${host}/${stripGitSuffix(url.pathname.replace(/^\/+/, ''))}`;
}

function stripGitSuffix(repoPath: string): string {
	return repoPath.replace(/\/+$/, '').replace(/\.git$/, '');
}
