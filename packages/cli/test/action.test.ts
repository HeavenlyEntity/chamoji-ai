import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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

// Copies FAKE_CURL_BODY (a file) to the path after --output, as the renderer's
// answer, or fails like curl --fail does when FAKE_CURL_FAIL=1.
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/curl-calls"
[ "\${FAKE_CURL_FAIL:-}" = 1 ] && exit 22
previous=
for arg in "$@"; do
	if [ "$previous" = --output ]; then cp "$FAKE_CURL_BODY" "$arg"; fi
	previous=$arg
done
`;

// A small buffer that starts with the PNG signature.
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from('fake card'),
]);

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
	await writeFile(path.join(fake, 'curl'), FAKE_CURL);
	await chmod(path.join(fake, 'curl'), 0o755);
	await writeFile(path.join(fake, 'card.png'), PNG);
	await writeFile(path.join(fake, 'summary'), '');
	await writeFile(path.join(fake, 'output'), '');

	// A bare repository to be the checkout's origin, where card mode pushes.
	const origin = `${repo.dir}-origin.git`;
	cleanups.push(async () => rm(origin, {recursive: true, force: true}));
	await execFileAsync('git', ['init', '-q', '--bare', origin]);
	await execFileAsync('git', ['remote', 'add', 'origin', origin], {
		cwd: repo.dir,
	});

	const action = async (env: Record<string, string>) => {
		try {
			const {stdout, stderr} = await execFileAsync('bash', [script], {
				cwd: repo.dir,
				env: {
					...process.env,
					PATH: `${fake}${path.delimiter}${process.env.PATH}`,
					FAKE_GH_DIR: fake,
					FAKE_CURL_BODY: path.join(fake, 'card.png'),
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
	const git = async (...args: string[]) =>
		(await gitOutput(repo.dir, args)).trim();
	const originGit = async (...args: string[]) =>
		(await gitOutput(origin, args)).trim();
	const originBlob = async (spec: string) => {
		const {stdout} = await execFileAsync('git', ['cat-file', 'blob', spec], {
			cwd: origin,
			encoding: 'buffer',
		});
		return stdout;
	};
	// What the renderer answers with on the next run.
	const answer = async (body: Buffer | string) =>
		writeFile(path.join(fake, 'card.png'), body);
	return {
		action,
		read,
		rev,
		git,
		originGit,
		originBlob,
		answer,
		dir: repo.dir,
		origin,
		fake,
	};
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
		const {action, read} = await setup(tagged);
		const result = await action({GITHUB_EVENT_NAME: 'schedule'});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'set mode to notes, comment, release or card',
		);
		// card pushes to a branch, so no event ever picks it.
		expect(await read('curl-calls')).toBe('');
		expect(await read('output')).not.toContain('card-url');
	});

	describe('card mode', () => {
		const card = {CHAMOJI_MODE: 'card'};
		const cardUrl =
			'https://raw.githubusercontent.com/acme/widgets/chamoji-card/card.png';

		test('card mode saves the image alone on the card branch', async () => {
			const {action, read, originGit, originBlob} = await setup(tagged);
			const result = await action(card);
			expect(result.code).toBe(0);
			expect(await originGit('rev-list', '--count', 'chamoji-card')).toBe('1');
			expect(
				await originGit('ls-tree', '-r', '--name-only', 'chamoji-card'),
			).toBe('card.png');
			expect((await originBlob('chamoji-card:card.png')).equals(PNG)).toBe(
				true,
			);
			expect(await read('output')).toContain(`card-url=${cardUrl}`);
			expect(await read('curl-calls')).toContain(
				'https://chamoji.dev/api/card',
			);
		});

		test('card mode pushes nothing when the image has not changed', async () => {
			const {action, read, originGit} = await setup(tagged);
			await action(card);
			const tip = await originGit('rev-parse', 'chamoji-card');
			const result = await action(card);
			expect(result.code).toBe(0);
			expect(await originGit('rev-parse', 'chamoji-card')).toBe(tip);
			expect(await read('output')).toContain(`card-url=${cardUrl}`);
		});

		test('card mode replaces the branch and keeps one commit', async () => {
			const {action, answer, originGit} = await setup(tagged);
			await action(card);
			await answer(Buffer.concat([PNG, Buffer.from(' changed')]));
			const result = await action(card);
			expect(result.code).toBe(0);
			expect(await originGit('rev-list', '--count', 'chamoji-card')).toBe('1');
			expect(await originGit('log', '--format=%s', 'chamoji-card')).toBe(
				'🍱 Update the chamoji card [skip ci]',
			);
			expect(await originGit('log', '--format=%an', 'chamoji-card')).toBe(
				'github-actions[bot]',
			);
		});

		test('card mode refuses a branch that holds anything else', async () => {
			const {action, git, originGit} = await setup(tagged);
			await git('push', '--quiet', 'origin', 'main');
			const before = await originGit('rev-parse', 'main');
			const result = await action({...card, CHAMOJI_CARD_BRANCH: 'main'});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('main');
			expect(await originGit('rev-parse', 'main')).toBe(before);
		});

		test('card mode refuses a branch name git would reject', async () => {
			const {action, read} = await setup(tagged);
			const result = await action({...card, CHAMOJI_CARD_BRANCH: '../x'});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('../x');
			expect(await read('curl-calls')).toBe('');
		});

		test('card mode keeps the last card when the renderer fails', async () => {
			const {action, originGit} = await setup(tagged);
			await action(card);
			const tip = await originGit('rev-parse', 'chamoji-card');
			const result = await action({...card, FAKE_CURL_FAIL: '1'});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('::warning::');
			expect(await originGit('rev-parse', 'chamoji-card')).toBe(tip);
		});

		test('card mode keeps the last card when the answer is not a PNG', async () => {
			const {action, answer, originGit} = await setup(tagged);
			await action(card);
			const tip = await originGit('rev-parse', 'chamoji-card');
			await answer('<html>');
			const result = await action(card);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('::warning::');
			expect(await originGit('rev-parse', 'chamoji-card')).toBe(tip);
		});

		test('card mode leaves the checkout alone', async () => {
			const {action, git, dir} = await setup(tagged);
			await git('checkout', '--quiet', '--detach', 'v1.0.0');
			await writeFile(path.join(dir, 'scratch.txt'), 'untracked');
			const head = await git('rev-parse', 'HEAD');
			const status = await git('status', '--porcelain');
			const result = await action(card);
			expect(result.code).toBe(0);
			expect(await git('rev-parse', 'HEAD')).toBe(head);
			expect(await git('status', '--porcelain')).toBe(status);
			expect(await git('rev-parse', '--is-shallow-repository')).toBe('false');
			expect(await git('config', '--local', '--get-all', 'user.name')).toBe(
				'Fixture Bot',
			);
		});

		test('card mode never asks Jev', async () => {
			const {action} = await setup(tagged);
			const result = await action({
				...card,
				CHAMOJI_AI: 'true',
				TYPESAFE_API_KEY: '',
			});
			expect(result.code).toBe(0);
		});

		test('card mode explains a push it could not make', async () => {
			const {action, origin} = await setup(tagged);
			const hook = path.join(origin, 'hooks', 'pre-receive');
			await writeFile(hook, '#!/bin/sh\necho no >&2\nexit 1\n');
			await chmod(hook, 0o755);
			const result = await action(card);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('push to chamoji-card');
			expect(result.stderr).toContain('contents: write');
		});

		test('card mode does not overwrite a branch that changed during the run', async () => {
			const {action, answer, originGit, origin, fake} = await setup(tagged);
			await action(card);
			await answer(Buffer.concat([PNG, Buffer.from(' changed')]));
			// A git that, before pushing, lets someone else commit to the branch.
			const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
			const shimDir = path.join(fake, 'shim');
			await mkdir(shimDir);
			await writeFile(
				path.join(shimDir, 'git'),
				`#!/usr/bin/env bash
if [ "$1" = push ]; then
	tree=$("${realGit}" -C "${origin}" rev-parse chamoji-card^{tree})
	other=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x "${realGit}" -C "${origin}" commit-tree "$tree" -p chamoji-card -m 'someone else')
	"${realGit}" -C "${origin}" update-ref refs/heads/chamoji-card "$other"
fi
exec "${realGit}" "$@"
`,
			);
			await chmod(path.join(shimDir, 'git'), 0o755);
			const result = await action({
				...card,
				PATH: `${shimDir}${path.delimiter}${fake}${path.delimiter}${process.env.PATH}`,
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('contents: write');
			expect(await originGit('log', '--format=%s', '-1', 'chamoji-card')).toBe(
				'someone else',
			);
		});

		test('card mode stores the image byte for byte whatever .gitattributes says', async () => {
			const {action, git, dir, originBlob} = await setup(tagged);
			await writeFile(path.join(dir, '.gitattributes'), '* text eol=lf\n');
			await git('add', '.gitattributes');
			await git('commit', '--quiet', '-m', '🔧 Normalise line endings');
			const result = await action(card);
			expect(result.code).toBe(0);
			expect((await originBlob('chamoji-card:card.png')).equals(PNG)).toBe(
				true,
			);
		});
	});
});
