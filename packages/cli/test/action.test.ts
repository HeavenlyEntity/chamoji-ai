import {execFile} from 'node:child_process';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, describe, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type RepoStep,
} from '../../core/test/helpers/fixture-repo.js';

// Runs action/run.sh, the GitHub Action's logic, against fixture repos with a
// fake gh that records what it was asked to do. The Action runs on Linux and
// macOS runners, so these tests skip Windows.
const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const script = path.join(root, 'action', 'run.sh');
const cli = `${process.execPath} ${path.join(root, 'packages/cli/dist/cli.js')}`;

const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls"
previous=
for arg in "$@"; do
	case "$arg" in body=@*) cp "\${arg#body=@}" "$FAKE_GH_DIR/body" ;; esac
	if [ "$previous" = --notes-file ]; then cp "$arg" "$FAKE_GH_DIR/notes"; fi
	previous=$arg
done
case "$1 $2" in
	"release view") [ "\${FAKE_RELEASE_EXISTS:-}" = 1 ] ;;
	"release create" | "release edit") exit 0 ;;
	api*)
		[ "\${FAKE_API_FAIL:-}" = 1 ] && exit 1
		case "$*" in *--paginate*) echo "\${FAKE_COMMENT_ID:-}" ;; esac
		exit 0
		;;
esac
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

async function setup(steps: RepoStep[]) {
	const repo = await createRepo(steps);
	const fake = await mkdtemp(path.join(tmpdir(), 'chamoji-gh-'));
	cleanups.push(
		async () => repo.cleanup(),
		async () => rm(fake, {recursive: true, force: true}),
	);
	await writeFile(path.join(fake, 'gh'), FAKE_GH);
	await chmod(path.join(fake, 'gh'), 0o755);
	await writeFile(path.join(fake, 'summary'), '');
	await writeFile(path.join(fake, 'output'), '');

	const action = async (env: Record<string, string>) => {
		try {
			const {stdout, stderr} = await execFileAsync('bash', [script], {
				cwd: repo.dir,
				env: {
					...process.env,
					PATH: `${fake}${path.delimiter}${process.env.PATH}`,
					FAKE_GH_DIR: fake,
					CHAMOJI_CLI: cli,
					GITHUB_STEP_SUMMARY: path.join(fake, 'summary'),
					GITHUB_OUTPUT: path.join(fake, 'output'),
					RUNNER_TEMP: fake,
					GH_REPO: 'acme/widgets',
					...env,
				},
			});
			return {code: 0, stdout, stderr};
		} catch (error) {
			const {code, stdout, stderr} = error as {
				code: number;
				stdout: string;
				stderr: string;
			};
			return {code, stdout, stderr};
		}
	};

	const read = async (name: string) =>
		readFile(path.join(fake, name), 'utf8').catch(() => '');
	const rev = async (ref: string) =>
		(await gitOutput(repo.dir, ['rev-parse', ref])).trim();
	return {action, read, rev};
}

const tagged: RepoStep[] = [
	{commit: '🎉 Init'},
	{tag: 'v1.0.0', annotated: true},
	{commit: '✨ Add search'},
	{tag: 'v1.1.0', annotated: true},
];

const pr: RepoStep[] = [
	{commit: '🎉 Init'},
	{tag: 'v1.0.0', annotated: true},
	{commit: '✨ Add search'},
	{commit: '🐛 Fix search on empty input'},
];

describe.skipIf(process.platform === 'win32')('the GitHub Action', () => {
	test('notes mode creates the release with only that tag’s notes', async () => {
		const {action, read} = await setup(tagged);
		const result = await action({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v1.1.0',
		});
		expect(result.code).toBe(0);
		expect(await read('calls')).toContain(
			'release create v1.1.0 --title v1.1.0 --notes-file',
		);
		const notes = await read('notes');
		expect(notes).toContain('Add search');
		expect(notes).not.toContain('# Changelog');
		expect(notes).not.toContain('Init');
		expect(await read('output')).toContain('version=v1.1.0');
	});

	test('notes mode edits a release that already exists', async () => {
		const {action, read} = await setup(tagged);
		await action({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v1.1.0',
			FAKE_RELEASE_EXISTS: '1',
		});
		const calls = await read('calls');
		expect(calls).toContain('release edit v1.1.0 --notes-file');
		expect(calls).not.toContain('release create');
	});

	test('comment mode posts a preview of the PR’s lines and the next version', async () => {
		const {action, read, rev} = await setup(pr);
		const result = await action({
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		expect(result.code).toBe(0);
		expect(await read('calls')).toContain(
			'api -X POST repos/acme/widgets/issues/7/comments',
		);
		const body = await read('body');
		expect(body).toContain('<!-- chamoji-changelog -->');
		expect(body).toContain('**v1.1.0** (minor)');
		expect(body).toContain('Fix search on empty input');
		expect(body).not.toContain('Add search');
		expect(body).not.toContain('## Unreleased');
	});

	test('comment mode updates its earlier comment instead of adding one', async () => {
		const {action, read, rev} = await setup(pr);
		await action({
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
			FAKE_COMMENT_ID: '42',
		});
		const calls = await read('calls');
		// Only the Action's own account counts, so a pasted marker can't redirect it.
		expect(calls).toContain('.user.login == "github-actions[bot]"');
		expect(calls).toContain(
			'api -X PATCH repos/acme/widgets/issues/comments/42',
		);
		expect(calls).not.toContain('-X POST');
	});

	test('comment mode refuses a comment-author that is not a login', async () => {
		const {action, rev} = await setup(pr);
		const result = await action({
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
			CHAMOJI_COMMENT_AUTHOR: 'x") or true or ("',
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('comment-author must be a GitHub login');
	});

	test('comment mode falls back to the job summary when it cannot comment', async () => {
		const {action, read, rev} = await setup(pr);
		const result = await action({
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
			FAKE_API_FAIL: '1',
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('::warning::');
		expect(await read('summary')).toContain('Fix search on empty input');
	});

	test('comment mode on a repo with no tags says it is the first release', async () => {
		const {action, read, rev} = await setup([
			{commit: '🎉 Init'},
			{commit: '✨ Add search'},
		]);
		await action({
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '1',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		expect(await read('body')).toContain('first release');
	});

	test('auto mode needs a tag push or a pull request', async () => {
		const {action} = await setup(tagged);
		const result = await action({GITHUB_EVENT_NAME: 'schedule'});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('set mode to notes, comment or release');
	});
});
