import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export type RepoStep =
	| {commit: string; body?: string; date?: string}
	| {tag: string; annotated?: boolean}
	| {mergeBranch: string; commits: string[]};

export type FixtureRepo = {dir: string; cleanup(): Promise<void>};

const BASE_DATE = Date.parse('2026-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * Creates a throwaway git repository in the OS temp dir and replays `steps`.
 * Commit dates advance one day per commit so output is deterministic.
 */
export async function createRepo(steps: RepoStep[]): Promise<FixtureRepo> {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-fixture-'));
	let commitCount = 0;

	const git = async (args: string[], date?: string) => {
		const when = date ?? new Date(BASE_DATE + commitCount * DAY).toISOString();
		await execFileAsync('git', args, {
			cwd: dir,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: when,
				GIT_COMMITTER_DATE: when,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_SYSTEM: '/dev/null',
			},
		});
	};

	const commit = async (message: string, body?: string, date?: string) => {
		const args = ['commit', '--allow-empty', '-q', '-m', message];
		if (body) {
			args.push('-m', body);
		}

		await git(args, date);
		commitCount++;
	};

	await git(['init', '-q', '-b', 'main']);
	await git(['config', 'user.name', 'Fixture Bot']);
	await git(['config', 'user.email', 'fixture@example.com']);
	await git(['config', 'commit.gpgsign', 'false']);
	await git(['config', 'tag.gpgsign', 'false']);

	for (const step of steps) {
		if ('commit' in step) {
			await commit(step.commit, step.body, step.date);
		} else if ('tag' in step) {
			await git(
				step.annotated
					? ['tag', '-a', step.tag, '-m', step.tag]
					: ['tag', step.tag],
			);
		} else {
			await git(['switch', '-q', '-c', step.mergeBranch]);
			for (const message of step.commits) {
				await commit(message);
			}

			await git(['switch', '-q', 'main']);
			await git([
				'merge',
				'--no-ff',
				'-q',
				'-m',
				`Merge branch '${step.mergeBranch}'`,
				step.mergeBranch,
			]);
			commitCount++;
		}
	}

	return {
		dir,
		cleanup: async () => rm(dir, {recursive: true, force: true}),
	};
}

export async function gitOutput(dir: string, args: string[]): Promise<string> {
	const {stdout} = await execFileAsync('git', args, {cwd: dir});
	return stdout;
}
