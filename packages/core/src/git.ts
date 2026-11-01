import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import semver from 'semver';
import type {RawCommit} from './types.js';

const execFileAsync = promisify(execFile);

const FIELD = '\u001F';
const RECORD = '\u001E';

export type ReleaseTag = {name: string; date: string};

/** Runs git without a shell and returns stdout. */
export async function runGit(args: string[], cwd: string): Promise<string> {
	const {stdout} = await execFileAsync('git', args, {
		cwd,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
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

/** Non-merge commits in `range` (anything `git log` accepts), newest first. */
export async function readCommits(
	cwd: string,
	range: string,
): Promise<RawCommit[]> {
	const format = [
		'%H',
		'%h',
		'%an',
		'%ae',
		'%aI',
		'%s',
		'%b',
		'%(trailers:only,unfold)',
	].join('%x1f');
	const stdout = await runGit(
		[
			'log',
			'--no-merges',
			'--no-show-signature',
			`--format=${format}%x1e`,
			'--end-of-options',
			range,
			'--',
		],
		cwd,
	);

	return stdout
		.split(RECORD)
		.map(record => record.replace(/^\n/, ''))
		.filter(record => record.length > 0)
		.map(record => {
			const [
				hash,
				shortHash,
				authorName,
				authorEmail,
				date,
				subject,
				body,
				trailers,
			] = record.split(FIELD);
			return {
				hash: hash!,
				shortHash: shortHash!,
				authorName: authorName!,
				authorEmail: authorEmail!,
				date: date!,
				subject: subject!,
				body: body!,
				trailers: trailers ?? '',
			};
		});
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
