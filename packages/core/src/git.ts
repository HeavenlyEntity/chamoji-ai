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

export async function assertGitRepo(cwd: string): Promise<void> {
	try {
		await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
	} catch {
		throw new Error(`Not a git repository: ${cwd}`);
	}
}

export async function assertRevision(cwd: string, ref: string): Promise<void> {
	try {
		await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
	} catch {
		throw new Error(
			ref === 'HEAD' ? 'Repository has no commits yet' : `Unknown revision: ${ref}`,
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
		['log', '--no-merges', `--format=${format}%x1e`, range, '--'],
		cwd,
	);

	return stdout
		.split(RECORD)
		.map(record => record.replace(/^\n/, ''))
		.filter(record => record.length > 0)
		.map(record => {
			const [hash, shortHash, authorName, authorEmail, date, subject, body, trailers] =
				record.split(FIELD);
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
 * commit's committer date, so annotated and lightweight tags agree.
 */
export async function listReleaseTags(
	cwd: string,
	to: string,
): Promise<ReleaseTag[]> {
	const stdout = await runGit(
		[
			'tag',
			'--merged',
			to,
			'--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(*committerdate:iso-strict)',
		],
		cwd,
	);

	return stdout
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [name, direct, dereferenced] = line.split(FIELD);
			return {name: name!, date: dereferenced || direct || ''};
		})
		.filter(tag => semver.valid(tag.name) !== null)
		.sort((a, b) => semver.rcompare(a.name, b.name));
}

/** `origin` as an https web URL, or undefined when there is none. */
export async function getRemoteWebUrl(cwd: string): Promise<string | undefined> {
	try {
		return toWebUrl((await runGit(['remote', 'get-url', 'origin'], cwd)).trim());
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
	const host = url.protocol === 'https:' || url.protocol === 'http:' ? url.host : url.hostname;
	return `${protocol}://${host}/${stripGitSuffix(url.pathname.replace(/^\/+/, ''))}`;
}

function stripGitSuffix(repoPath: string): string {
	return repoPath.replace(/\/+$/, '').replace(/\.git$/, '');
}
