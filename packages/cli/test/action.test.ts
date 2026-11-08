import {execFile, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
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

// The real CLI, except that --version answers FAKE_CLI_VERSION (default
// 0.13.0): the build in this checkout still says 0.12.0, which the Action
// refuses for repos with release settings. A call that has CHAMOJI_NPM_TOKEN
// in its environment is listed in token-calls, and one with CHAMOJI_PROVENANCE
// in provenance-calls, after its value.
const FAKE_CLI = `#!/usr/bin/env bash
[ -z "\${CHAMOJI_NPM_TOKEN:-}" ] || printf '%s\\n' "$*" >> "$(dirname "$0")/token-calls"
[ -z "\${CHAMOJI_PROVENANCE:-}" ] || printf '%s %s\\n' "$CHAMOJI_PROVENANCE" "$*" >> "$(dirname "$0")/provenance-calls"
if [ "$1" = --version ]; then echo "\${FAKE_CLI_VERSION:-0.13.0}"; exit 0; fi
case "$(pwd)" in *chamoji-head) { pwd; env; } >> "$(dirname "$0")/worktree-env" ;; esac
exec "${process.execPath}" "${path.join(root, 'packages/cli/dist/cli.js')}" "$@"
`;

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

// Answers as the renderer: copies FAKE_CURL_BODY (a file) to the path after
// --output and exits 0. FAKE_CURL_STATUS sets the HTTP status (default 200);
// with --fail an error status exits 22 and saves nothing, as curl does.
// FAKE_CURL_FAIL=1 is a renderer that can't be reached: status 000, exit 7.
// A --write-out of %{http_code} prints the status, as curl does.
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/curl-calls"
status=\${FAKE_CURL_STATUS:-200}
[ "\${FAKE_CURL_FAIL:-}" = 1 ] && status=000
previous=
fail=
writeout=
for arg in "$@"; do
	[ "$arg" = --fail ] && fail=1
	[ "$previous" = --write-out ] && writeout=$arg
	previous=$arg
done
code=0
if [ "\${FAKE_CURL_FAIL:-}" = 1 ]; then
	code=7
elif [ -n "$fail" ] && [ "$status" -ge 400 ]; then
	code=22
else
	previous=
	for arg in "$@"; do
		if [ "$previous" = --output ]; then cp "$FAKE_CURL_BODY" "$arg"; fi
		previous=$arg
	done
fi
[ "$writeout" = '%{http_code}' ] && printf '%s' "$status"
exit "$code"
`;

// The real npm, which the fake below runs to pack a tarball. Windows skips
// these tests and may have no sh, so the lookup can't throw at import.
const realNpm = (() => {
	try {
		return execFileSync('sh', ['-c', 'command -v npm'], {
			encoding: 'utf8',
		}).trim();
	} catch {
		return 'npm';
	}
})();

// Records its argv to npm-calls in its own folder. --version answers the
// version file there (an `install -g npm@latest` writes 11.6.0 to it), else
// FAKE_NPM_VERSION (default 11.6.0). pack runs the real npm. view says the
// registry has FAKE_NPM_PUBLISHED, or E404 without it. publish fails for a
// tarball of version FAKE_NPM_FAIL. Everything else passes.
const fakeNpm = (dir: string) => `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/npm-calls"
case "$1" in
	--version)
		if [ -f "${dir}/npm-version" ]; then cat "${dir}/npm-version"; else echo "\${FAKE_NPM_VERSION:-11.6.0}"; fi
		;;
	install) [ "$2" = -g ] && echo 11.6.0 > "${dir}/npm-version" ;;
	pack) exec "${realNpm}" "$@" ;;
	view)
		if [ -z "\${FAKE_NPM_PUBLISHED:-}" ]; then echo 'npm error code E404' >&2; exit 1; fi
		printf '{"versions":["%s"],"dist-tags":{"latest":"%s"}}\\n' "$FAKE_NPM_PUBLISHED" "$FAKE_NPM_PUBLISHED"
		;;
	publish)
		for arg in "$@"; do
			case "$arg" in *-"\${FAKE_NPM_FAIL:-none}".tgz) echo 'npm error code E403' >&2; exit 1 ;; esac
		done
		;;
	whoami) echo dev ;;
esac
exit 0
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
	await writeFile(path.join(fake, 'chamoji'), FAKE_CLI);
	await chmod(path.join(fake, 'chamoji'), 0o755);
	// A package runner that would answer --version; the unit preview refuses it.
	// It lists its calls in npx-calls, and those with the token in token-calls.
	await writeFile(
		path.join(fake, 'npx'),
		[
			'#!/usr/bin/env bash',
			`printf '%s\\n' "$*" >> '${fake}/npx-calls'`,
			`[ -z "\${CHAMOJI_NPM_TOKEN:-}" ] || printf '%s\\n' "$*" >> '${fake}/token-calls'`,
			'echo "${FAKE_CLI_VERSION:-0.13.0}"',
			'',
		].join('\n'),
	);
	await chmod(path.join(fake, 'npx'), 0o755);
	await writeFile(path.join(fake, 'npm'), fakeNpm(fake));
	await chmod(path.join(fake, 'npm'), 0o755);
	// The webhook payload, which names the default branch.
	await writeFile(
		path.join(fake, 'event.json'),
		JSON.stringify({repository: {default_branch: 'main'}}),
	);
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

	// Runs the Action with a CLI whose version the repo's release settings accept.
	const unitCli = path.join(fake, 'chamoji');
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
					GITHUB_EVENT_PATH: path.join(fake, 'event.json'),
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
		unitCli,
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

const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;
const uses = {'@gearz/supabase': 'workspace:*'};

// An app monorepo: web and mobile on a shared supabase package.
const unitConfig = (release: unknown = unitRelease()) => ({
	'chamoji.config.json': json({release}),
});
const unitRelease = (webTag = 'web/v{version}') => ({
	schema: 1,
	shape: 'apps',
	units: {
		web: {path: 'apps/web', tag: webTag},
		mobile: {path: 'apps/mobile', tag: 'mobile/v{version}'},
	},
});
const unitFiles: Record<string, string> = {
	'package.json': json({name: 'gearz', private: true}),
	'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
	...unitConfig(),
	'apps/web/package.json': json({
		name: '@gearz/web',
		version: '0.1.0',
		private: true,
		dependencies: uses,
	}),
	'apps/mobile/package.json': json({
		name: '@gearz/mobile',
		version: '1.0.0',
		private: true,
		dependencies: uses,
	}),
	'packages/supabase/package.json': json({
		name: '@gearz/supabase',
		version: '0.0.0',
		private: true,
	}),
};

const unitStart: RepoStep[] = [
	{commit: '🎉 Start the gearz monorepo', files: unitFiles},
	{tag: 'web/v0.1.0', annotated: true},
	{tag: 'mobile/v1.0.0', annotated: true},
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

		test('card mode says a refused card has no card yet on a first run', async () => {
			const {action, read, originGit} = await setup(tagged);
			const result = await action({...card, FAKE_CURL_STATUS: '400'});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('::warning::');
			expect(result.stdout).toContain('refused');
			expect(result.stdout).toContain('v1.1.0');
			expect(result.stdout).toContain('no card yet');
			expect(result.stdout).not.toContain('keeps its last card');
			expect(result.stdout).not.toContain("didn't answer");
			expect(await read('summary')).toContain('refused');
			expect(await read('summary')).toContain('v1.1.0');
			expect(await read('output')).not.toContain('card-url');
			await expect(
				originGit('rev-parse', '--verify', 'chamoji-card'),
			).rejects.toThrow();
		});

		test('card mode keeps the last card when the renderer refuses the details', async () => {
			const {action, read, originGit} = await setup(tagged);
			await action(card);
			const tip = await originGit('rev-parse', 'chamoji-card');
			const result = await action({...card, FAKE_CURL_STATUS: '400'});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('::warning::');
			expect(result.stdout).toContain('refused');
			expect(result.stdout).toContain('v1.1.0');
			expect(result.stdout).toContain('keeps its last card');
			expect(result.stdout).not.toContain("didn't answer");
			expect(await read('summary')).toContain('refused');
			expect(await originGit('rev-parse', 'chamoji-card')).toBe(tip);
		});

		test('card mode reports an outage as an outage, with a summary line', async () => {
			const {action, read} = await setup(tagged);
			const result = await action({...card, FAKE_CURL_FAIL: '1'});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("didn't answer");
			expect(result.stdout).toContain('no card yet');
			expect(result.stdout).not.toContain('refused');
			expect(await read('summary')).toContain("didn't answer");
		});

		test('card mode treats a server error as an outage', async () => {
			const {action} = await setup(tagged);
			const result = await action({...card, FAKE_CURL_STATUS: '503'});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("didn't answer");
			expect(result.stdout).not.toContain('refused');
		});

		test('card mode ignores a longer branch that ends the same way', async () => {
			const {action, git, originGit} = await setup(tagged);
			await git('push', '--quiet', 'origin', 'main:refs/heads/team/card');
			const before = await originGit('rev-parse', 'team/card');
			const result = await action({...card, CHAMOJI_CARD_BRANCH: 'card'});
			expect(result.code).toBe(0);
			expect(await originGit('ls-tree', '-r', '--name-only', 'card')).toBe(
				'card.png',
			);
			expect(await originGit('rev-parse', 'team/card')).toBe(before);
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
	test('refuses an old CLI when release settings exist', async () => {
		const {action, unitCli, read} = await setup(unitStart);
		const result = await action({
			CHAMOJI_CLI: unitCli,
			FAKE_CLI_VERSION: '0.12.1',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/web/v0.1.0',
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"this repo's release settings need chamoji 0.13.0 or newer; set chamoji-version",
		);
		expect(await read('calls')).toBe('');
	});

	test('unit tags get their unit’s notes', async () => {
		const {action, unitCli, read} = await setup([
			...unitStart,
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{
				commit: '🐛 Fix the camera crash',
				files: {'apps/mobile/src/camera.ts': 'camera\n'},
			},
			{tag: 'web/v0.2.0', annotated: true},
		]);
		const result = await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/web/v0.2.0',
			FAKE_RELEASE_EXISTS: '1',
		});
		expect(result.code).toBe(0);
		expect(await read('calls')).toContain(
			'release edit web/v0.2.0 --notes-file',
		);
		const notes = await read('notes');
		expect(notes).toContain('Add the dashboard');
		expect(notes).not.toContain('camera');
		expect(notes).not.toContain('# Changelog');
		expect(await read('output')).toContain('version=web/v0.2.0');
	});

	test('without release settings, a non-version tag is left alone', async () => {
		const {action, read} = await setup([...tagged, {tag: 'wip/x'}]);
		const result = await action({
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/wip/x',
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"chamoji: wip/x isn't a whole-repo version tag; leaving its release alone",
		);
		expect(await read('calls')).toBe('');
	});

	test('the PR comment lists units', async () => {
		const {action, unitCli, read, rev} = await setup([
			...unitStart,
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{
				commit: '🐛 Fix the session refresh',
				files: {'packages/supabase/src/session.ts': 'refresh\n'},
			},
		]);
		const result = await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~2'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		expect(result.code).toBe(0);
		expect(await read('calls')).toContain(
			'api -X POST repos/acme/widgets/issues/7/comments',
		);
		const body = await read('body');
		expect(body).toContain('<!-- chamoji-changelog -->');
		expect(body).toContain('web → 0.2.0');
		expect(body).toContain('mobile: rides along');
		expect(body).toContain('Add the dashboard');
	});

	test('release mode passes the unit input to chamoji', async () => {
		const {action, unitCli, git} = await setup([
			...unitStart,
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{
				commit: '✨ Add the camera roll',
				files: {'apps/mobile/src/roll.ts': 'roll\n'},
			},
		]);
		await git('config', 'user.name', 'Dev');
		await git('config', 'user.email', 'dev@example.com');
		const result = await action({
			CHAMOJI_CLI: unitCli,
			CHAMOJI_MODE: 'release',
			CHAMOJI_UNIT: 'web',
		});
		expect(result.code).toBe(0);
		expect(await git('tag', '--list', 'web/v0.2.0')).toBe('web/v0.2.0');
		expect(await git('tag', '--list', 'mobile/v1.1.0')).toBe('');
	});
	test('release mode names a tag shared by a fixed group once', async () => {
		const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
		const {action, unitCli, git, read} = await setup([
			{
				commit: '🎉 Start payload-kit',
				files: {
					'package.json': json({name: 'payload-kit', private: true}),
					'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
					'chamoji.config.json': json({
						release: {
							schema: 1,
							shape: 'libraries',
							units: {
								core: {path: 'packages/core', tag: 'v{version}'},
								types: {path: 'packages/types', tag: 'v{version}'},
							},
							fixed: [['core', 'types']],
						},
					}),
					'packages/core/package.json': json({
						name: '@payload/core',
						version: '1.0.0',
					}),
					'packages/types/package.json': json({
						name: '@payload/types',
						version: '1.0.0',
					}),
				},
			},
			{tag: 'v1.0.0', annotated: true},
			{
				commit: '🐛 Fix the parser',
				files: {'packages/core/src/parse.ts': 'parse\n'},
			},
		]);
		await git('config', 'user.name', 'Dev');
		await git('config', 'user.email', 'dev@example.com');
		const result = await action({
			CHAMOJI_CLI: unitCli,
			CHAMOJI_MODE: 'release',
		});
		expect(result.code).toBe(0);
		expect(await read('output')).toBe('version=v1.0.1\n');
		const summary = await read('summary');
		expect(summary.match(/^## v1\.0\.1.*$/gm)).toEqual([
			'## v1.0.1 (core)',
			'## v1.0.1 (types)',
		]);
		expect(await read('calls')).toMatch(/^release create v1\.0\.1 /);
	});

	test('a hyphenated tag template is not a prerelease, a real suffix is', async () => {
		const files = {...unitFiles, ...unitConfig(unitRelease('web-v{version}'))};
		const hyphen = await setup([
			{commit: '🎉 Start the gearz monorepo', files},
			{tag: 'web-v0.1.0', annotated: true},
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{tag: 'web-v0.2.0', annotated: true},
		]);
		const first = await hyphen.action({
			CHAMOJI_CLI: hyphen.unitCli,
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/web-v0.2.0',
		});
		expect(first.code).toBe(0);
		const created = await hyphen.read('calls');
		expect(created).toContain('release create web-v0.2.0');
		expect(created).not.toContain('--prerelease');

		const beta = await setup([
			...unitStart,
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{tag: 'web/v0.2.0-beta.1', annotated: true},
		]);
		const second = await beta.action({
			CHAMOJI_CLI: beta.unitCli,
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/web/v0.2.0-beta.1',
		});
		expect(second.code).toBe(0);
		expect(await beta.read('calls')).toContain('--prerelease');
	});

	test('the PR comment shows only what the PR adds, not the base’s unreleased work', async () => {
		const {action, unitCli, read, rev} = await setup([
			...unitStart,
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{
				commit: '🐛 Fix the camera crash',
				files: {'apps/mobile/src/camera.ts': 'camera\n'},
			},
		]);
		const result = await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		expect(result.code).toBe(0);
		const body = await read('body');
		expect(body).toContain('- mobile → 1.0.1');
		expect(body).toContain('Fix the camera crash');
		expect(body).not.toContain('web');
		expect(body).not.toContain('dashboard');
	});

	test('the PR comment says when a unit only rides along', async () => {
		const {action, unitCli, read, rev} = await setup([
			...unitStart,
			{
				commit: '✨ Add the dashboard',
				files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
			},
			{
				commit: '🐛 Fix the session refresh',
				files: {'packages/supabase/src/session.ts': 'refresh\n'},
			},
		]);
		await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		const body = await read('body');
		expect(body).toContain('- web → 0.2.0 (rides along with its next release)');
		expect(body).toContain('- mobile: rides along');
		expect(body).toContain('Fix the session refresh');
		expect(body).not.toContain('dashboard');
	});

	test('the unit PR comment with nothing to release says so', async () => {
		const {action, unitCli, read, rev} = await setup([
			...unitStart,
			{commit: '📝 Mention the repo', files: {'NOTES.md': 'notes\n'}},
		]);
		const result = await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		expect(result.code).toBe(0);
		const body = await read('body');
		expect(body).toContain('adds nothing to any unit');
		expect(body).not.toContain('→');
	});

	test('the unit PR comment is updated in place', async () => {
		const {action, unitCli, read, rev} = await setup([
			...unitStart,
			{
				commit: '🐛 Fix the camera crash',
				files: {'apps/mobile/src/camera.ts': 'camera\n'},
			},
		]);
		await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: await rev('HEAD~1'),
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
			FAKE_COMMENT_ID: '42',
		});
		const calls = await read('calls');
		expect(calls).toContain(
			'api -X PATCH repos/acme/widgets/issues/comments/42',
		);
		expect(calls).not.toContain('-X POST');
	});

	test('shape single keeps the old behaviour but still needs a new CLI', async () => {
		const files = {
			...unitFiles,
			...unitConfig({schema: 1, shape: 'single'}),
		};
		const steps: RepoStep[] = [
			{commit: '🎉 Start the gearz monorepo', files},
			{tag: 'v1.0.0', annotated: true},
			{commit: '✨ Add search'},
			{tag: 'v1.1.0', annotated: true},
			{tag: 'wip/x'},
		];
		const old = await setup(steps);
		const refused = await old.action({
			CHAMOJI_CLI: old.unitCli,
			FAKE_CLI_VERSION: '0.12.1',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v1.1.0',
		});
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('need chamoji 0.13.0 or newer');

		const fresh = await setup(steps);
		const skipped = await fresh.action({
			CHAMOJI_CLI: fresh.unitCli,
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/wip/x',
		});
		expect(skipped.code).toBe(0);
		expect(await fresh.read('calls')).toBe('');
		const whole = await fresh.action({
			CHAMOJI_CLI: fresh.unitCli,
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/tags/v1.1.0',
		});
		expect(whole.code).toBe(0);
		expect(await fresh.read('calls')).toContain('release create v1.1.0');
		expect(await fresh.read('notes')).toContain('Add search');
	});
	// pull_request_target: the workspace is the base commit, with a trusted CLI
	// wrapper; the PR head carries a different file at the same path plus an
	// .npmrc. Returns the paths the assertions need.
	async function targetRepo(where: string) {
		const plantedMarker = path.join(
			tmpdir(),
			`chamoji-planted-${randomUUID()}`,
		);
		const real = path.join(root, 'packages/cli/dist/cli.js');
		const trusted = `const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'trusted-ran'), 'x');
if (process.argv.includes('--version')) { console.log('0.13.0'); process.exit(0); }
process.exit(spawnSync(process.execPath, [${JSON.stringify(real)}, ...process.argv.slice(2)], {stdio: 'inherit'}).status ?? 1);
`;
		const planted = `require('node:fs').writeFileSync(${JSON.stringify(plantedMarker)}, 'x');\n`;
		const repo = await setup([
			{
				commit: '🎉 Start the gearz monorepo',
				files: {...unitFiles, [where]: trusted},
			},
			{tag: 'web/v0.1.0', annotated: true},
			{tag: 'mobile/v1.0.0', annotated: true},
			{
				commit: '🐛 Fix the camera crash',
				files: {
					'apps/mobile/src/camera.ts': 'camera\n',
					[where]: planted,
					'.npmrc': 'registry=http://127.0.0.1:1/\nscript-shell=/bin/false\n',
				},
			},
		]);
		const head = await repo.rev('HEAD');
		const base = await repo.rev('HEAD~1');
		await repo.git('checkout', '--quiet', '--detach', base);
		const event = {
			GITHUB_EVENT_NAME: 'pull_request_target',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: base,
			CHAMOJI_HEAD_SHA: head,
		};
		return {
			...repo,
			event,
			plantedMarker,
			trustedMarker: path.join(repo.dir, path.dirname(where), 'trusted-ran'),
		};
	}

	test.each([
		['node packages/cli/dist/cli.js', 'packages/cli/dist/cli.js'],
		['node cli.js', 'cli.js'],
	])(
		'the unit preview runs the workspace’s CLI, not the PR’s: %s',
		async (command, where) => {
			const {action, read, event, plantedMarker, trustedMarker} =
				await targetRepo(where);
			const result = await action({CHAMOJI_CLI: command, ...event});
			expect(result.code).toBe(0);
			expect(await read('body')).toContain('- mobile → 1.0.1');
			expect(existsSync(trustedMarker)).toBe(true);
			expect(existsSync(plantedMarker)).toBe(false);
			await rm(plantedMarker, {force: true});
		},
	);

	test('a cli file that only the PR has fails closed', async () => {
		const {action, read, event, plantedMarker, dir} =
			await targetRepo('cli.js');
		await rm(path.join(dir, 'cli.js'));
		const result = await action({CHAMOJI_CLI: 'node cli.js', ...event});
		expect(result.code).not.toBe(0);
		expect(await read('body')).toBe('');
		expect(existsSync(plantedMarker)).toBe(false);
	});

	test('an option word in cli fails closed', async () => {
		const {action, read, event, plantedMarker} = await targetRepo('cli.js');
		const result = await action({
			CHAMOJI_CLI: 'node --no-warnings cli.js',
			...event,
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('the option --no-warnings');
		expect(await read('body')).toBe('');
		expect(existsSync(plantedMarker)).toBe(false);
	});

	test.each([
		['a package manager', 'npx chamoji'],
		['a bash wrapper', 'bash wrapper.sh'],
		['tsx', 'tsx cli.js'],
	])('%s as cli fails closed in the unit preview', async (_name, command) => {
		const {action, read, event, plantedMarker, fake, dir} =
			await targetRepo('cli.js');
		// Both answer the version probe, so only the rule can refuse them.
		const answers = '#!/usr/bin/env bash\necho 0.13.0\n';
		await writeFile(path.join(fake, 'tsx'), answers);
		await chmod(path.join(fake, 'tsx'), 0o755);
		await writeFile(path.join(dir, 'wrapper.sh'), answers);
		const result = await action({CHAMOJI_CLI: command, ...event});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'::error::chamoji: unit-mode PR previews run only node with a built CLI file, or chamoji itself; unset cli or use node packages/cli/dist/cli.js',
		);
		expect(await read('body')).toBe('');
		expect(existsSync(plantedMarker)).toBe(false);
	});

	test('node with no CLI file fails closed in the unit preview', async () => {
		const {action, read, event, plantedMarker} = await targetRepo('cli.js');
		const result = await action({CHAMOJI_CLI: 'node', ...event});
		expect(result.code).toBe(1);
		expect(await read('body')).toBe('');
		expect(existsSync(plantedMarker)).toBe(false);
	});

	test('the CLI in the worktree sees only allowlisted environment', async () => {
		const {action, unitCli, read, event} = await targetRepo('cli.js');
		const result = await action({
			CHAMOJI_CLI: unitCli,
			GH_TOKEN: 'ghs_leak',
			TYPESAFE_API_KEY: 'tsk_leak',
			INPUT_SOMETHING: 'input_leak',
			MY_SECRET_VALUE: 'secret_leak',
			DB_PASSWORD: 'password_leak',
			CHAMOJI_AI: 'true',
			...event,
		});
		expect(result.code).toBe(0);
		const lines = (await read('worktree-env')).split('\n').filter(Boolean);
		expect(lines.some(line => line.endsWith('chamoji-head'))).toBe(true);
		const allowed = new Set([
			'PATH',
			'HOME',
			'LANG',
			'LC_ALL',
			'TMPDIR',
			'TZ',
			'CI',
			'GIT_CONFIG_NOSYSTEM',
			'GIT_TERMINAL_PROMPT',
			// Set by bash itself.
			'PWD',
			'OLDPWD',
			'SHLVL',
			'_',
		]);
		const names = lines
			.filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
			.map(line => line.split('=')[0]!);
		expect(names.filter(name => !allowed.has(name))).toEqual([]);
		expect(lines.join('\n')).not.toContain('_leak');
	});

	test('the unit PR comment fails loudly when the base is missing', async () => {
		const {action, unitCli, read, rev} = await setup([
			...unitStart,
			{
				commit: '🐛 Fix the camera crash',
				files: {'apps/mobile/src/camera.ts': 'camera\n'},
			},
		]);
		const result = await action({
			CHAMOJI_CLI: unitCli,
			GITHUB_EVENT_NAME: 'pull_request',
			CHAMOJI_PR: '7',
			CHAMOJI_BASE_SHA: '0123456789abcdef0123456789abcdef01234567',
			CHAMOJI_HEAD_SHA: await rev('HEAD'),
		});
		expect(result.code).not.toBe(0);
		expect(await read('body')).toBe('');
		expect(await read('calls')).toBe('');
	});
	describe('release on merge', () => {
		// A public library, released as v1.0.0, with a feature since.
		const library = (release: object): RepoStep[] => [
			{
				commit: '🎉 Init',
				files: {
					'package.json': json({
						name: 'acme-lib',
						version: '1.0.0',
						main: 'index.js',
					}),
					'index.js': 'export {};\n',
					'chamoji.config.json': json({
						release: {schema: 2, shape: 'single', ...release},
					}),
				},
			},
			{tag: 'v1.0.0', annotated: true},
			{commit: '✨ Add search', files: {'search.js': 'export {};\n'}},
		];
		const TOKEN = 'npm_actionSecretToken456';
		const merged = {
			FAKE_CLI_VERSION: '0.15.0',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/heads/main',
		};

		test('auto mode on a push to the default branch releases when trigger is merge', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'merge'}),
			);
			const result = await action({CHAMOJI_CLI: unitCli, ...merged});
			expect(result.code).toBe(0);
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
			expect(await read('output')).toBe('version=v1.1.0\n');
			expect(await read('summary')).toContain('Add search');
			// Nothing is published without release.publish.
			expect(await read('npm-calls')).toBe('');
		});

		test('auto mode on a push to the default branch passes when releases are manual', async () => {
			const {action, unitCli, read, git} = await setup(
				library({trigger: 'manual'}),
			);
			const result = await action({CHAMOJI_CLI: unitCli, ...merged});
			expect(result.code).toBe(0);
			expect(await read('summary')).toContain(
				'chamoji: releases are manual here (release.trigger)',
			);
			expect(await git('tag', '--list')).toBe('v1.0.0');
		});

		test('auto mode on a push to another branch still fails', async () => {
			const {action, unitCli, git} = await setup(library({trigger: 'merge'}));
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				GITHUB_REF: 'refs/heads/feature',
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"can't pick a mode for the push event; set mode to notes, comment, release or card",
			);
			expect(await git('tag', '--list')).toBe('v1.0.0');
		});

		test('merge mode needs a CLI that knows --on-merge', async () => {
			const {action, unitCli, git} = await setup(tagged);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				FAKE_CLI_VERSION: '0.14.0',
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				'releasing on merge needs chamoji 0.15.0 or newer; set chamoji-version',
			);
			expect(await git('tag', '--list')).toBe('v1.0.0\nv1.1.0');
		});

		test('auto mode on workflow_dispatch releases', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'manual'}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				GITHUB_EVENT_NAME: 'workflow_dispatch',
				GITHUB_REF: 'refs/heads/main',
			});
			expect(result.code).toBe(0);
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
			expect(await read('output')).toBe('version=v1.1.0\n');
		});

		test('merge mode publishes when release.publish is set', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_PUBLISHED: '1.0.0',
			});
			expect(result.code).toBe(0);
			const npm = await read('npm-calls');
			expect(npm).toMatch(/^publish \.\/acme-lib-1\.1\.0\.tgz /m);
			expect(npm).not.toContain('install -g');
			expect(result.stdout).toContain('npm 11.6.0');
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
			expect(await read('calls')).toContain('release create v1.1.0');
		});

		test('an old npm is replaced before publishing', async () => {
			const {action, unitCli, read} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_PUBLISHED: '1.0.0',
				FAKE_NPM_VERSION: '10.9.0',
			});
			expect(result.code).toBe(0);
			const npm = await read('npm-calls');
			expect(npm).toContain('install -g npm@latest');
			expect(npm).toMatch(/^publish \.\/acme-lib-1\.1\.0\.tgz /m);
			expect(result.stdout).toContain('npm 11.6.0');
		});

		test('publish input false skips publishing', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_PUBLISH: 'false',
			});
			expect(result.code).toBe(0);
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
			expect(await read('npm-calls')).toBe('');
			// No publish follows, so the release job makes the GitHub release.
			expect(await read('calls')).toContain('release create v1.1.0');
		});

		test('the npm token is masked and never printed', async () => {
			const {action, unitCli, read} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				// The catch-up fails, so there is error output too.
				FAKE_NPM_FAIL: '1.0.0',
			});
			expect(result.code).toBe(1);
			expect(result.stdout.startsWith(`::add-mask::${TOKEN}\n`)).toBe(true);
			const printed = result.stdout + result.stderr;
			expect(printed.split('::add-mask::').length).toBe(2);
			expect(printed.split(TOKEN).length).toBe(2);
			for (const file of ['summary', 'output', 'npm-calls', 'calls']) {
				// eslint-disable-next-line no-await-in-loop
				expect(await read(file)).not.toContain(TOKEN);
			}
		});

		test('notes mode leaves release creation to the publish', async () => {
			const {action, unitCli, read} = await setup([
				...library({trigger: 'merge', publish: true}),
				{tag: 'v1.1.0', annotated: true},
			]);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				GITHUB_EVENT_NAME: 'push',
				GITHUB_REF: 'refs/tags/v1.1.0',
			});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(
				'the GitHub release is created when the publish finishes',
			);
			expect(await read('calls')).not.toContain('release create');

			const existing = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				GITHUB_EVENT_NAME: 'push',
				GITHUB_REF: 'refs/tags/v1.1.0',
				FAKE_RELEASE_EXISTS: '1',
			});
			expect(existing.code).toBe(0);
			expect(await read('calls')).toContain('release edit v1.1.0 --notes-file');
			expect(await read('calls')).not.toContain('release create');

			// With publish false nothing publishes, so notes mode makes it.
			const off = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				GITHUB_EVENT_NAME: 'push',
				GITHUB_REF: 'refs/tags/v1.1.0',
				CHAMOJI_PUBLISH: 'false',
			});
			expect(off.code).toBe(0);
			expect(await read('calls')).toContain('release create v1.1.0');
		});

		test('catch-up failure fails the job after the release', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_FAIL: '1.0.0',
			});
			expect(result.code).toBe(1);
			const npm = await read('npm-calls');
			expect(npm).toMatch(/^publish \.\/acme-lib-1\.0\.0\.tgz /m);
			expect(npm).toMatch(/^publish \.\/acme-lib-1\.1\.0\.tgz /m);
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
			// v1.1.0 is now the latest tag, so a re-run's catch-up wouldn't see
			// v1.0.0: the advice leaves the re-run out.
			const advice =
				"catching up didn't finish for v1.0.0; run chamoji publish --from v1.0.0, or start a workflow with mode: publish on v1.0.0";
			expect(result.stderr).toContain(advice);
			expect(await read('summary')).toContain(advice);
			expect(result.stdout + result.stderr).not.toContain('re-run');
		});

		test('catch-up failure suggests a re-run when nothing was released', async () => {
			const {action, unitCli, read, git} = await setup(
				library({trigger: 'manual', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_FAIL: '1.0.0',
			});
			expect(result.code).toBe(1);
			expect(await git('tag', '--list')).toBe('v1.0.0');
			const advice =
				"catching up didn't finish for v1.0.0; re-run this job, run chamoji publish --from v1.0.0, or start a workflow with mode: publish on v1.0.0";
			expect(result.stderr).toContain(advice);
			expect(await read('summary')).toContain(advice);
		});

		test('in merge mode only the publishing calls get the npm token', async () => {
			const {action, unitCli, read} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_PUBLISHED: '1.0.0',
			});
			expect(result.code).toBe(0);
			const calls = (await read('token-calls')).split('\n').filter(Boolean);
			expect(calls).toHaveLength(2);
			expect(calls[0]).toMatch(/^publish --catch-up --json /);
			expect(calls[1]).toMatch(/^release --on-merge --push --publish --json /);
			expect(calls.join('\n')).not.toContain(TOKEN);
		});

		test('release mode catches up before it releases', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'manual', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				GITHUB_EVENT_NAME: 'workflow_dispatch',
				GITHUB_REF: 'refs/heads/main',
				CHAMOJI_NPM_TOKEN: TOKEN,
			});
			expect(result.code).toBe(0);
			const calls = (await read('token-calls')).split('\n').filter(Boolean);
			expect(calls[0]).toMatch(/^publish --catch-up --json /);
			expect(calls[1]).toMatch(/^release --push --publish --json /);
			const npm = await read('npm-calls');
			expect(npm).toMatch(/^publish \.\/acme-lib-1\.0\.0\.tgz /m);
			expect(npm).toMatch(/^publish \.\/acme-lib-1\.1\.0\.tgz /m);
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
		});

		test('in release mode a failed catch-up still releases, then fails the job', async () => {
			const {action, unitCli, read, originGit} = await setup(
				library({trigger: 'manual', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				CHAMOJI_MODE: 'release',
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_FAIL: '1.0.0',
			});
			expect(result.code).toBe(1);
			expect(await read('npm-calls')).toMatch(
				/^publish \.\/acme-lib-1\.1\.0\.tgz /m,
			);
			expect(await originGit('tag', '--list')).toContain('v1.1.0');
			const advice =
				"catching up didn't finish for v1.0.0; run chamoji publish --from v1.0.0, or start a workflow with mode: publish on v1.0.0";
			expect(result.stderr).toContain(advice);
			expect(await read('summary')).toContain(advice);
		});

		test('a private repository turns provenance off for the CLI', async () => {
			const {action, unitCli, read, fake} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			await writeFile(
				path.join(fake, 'event.json'),
				JSON.stringify({repository: {default_branch: 'main', private: true}}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_PUBLISHED: '1.0.0',
			});
			expect(result.code).toBe(0);
			const calls = (await read('provenance-calls'))
				.split('\n')
				.filter(Boolean);
			expect(calls).toContainEqual(
				expect.stringMatching(/^false publish --catch-up /),
			);
			expect(calls).toContainEqual(
				expect.stringMatching(/^false release --on-merge /),
			);
		});

		test('a public repository leaves provenance to the CLI', async () => {
			const {action, unitCli, read} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_PUBLISHED: '1.0.0',
			});
			expect(result.code).toBe(0);
			expect(await read('provenance-calls')).toBe('');
		});

		test('a pull request never hands the npm token to chamoji', async () => {
			const units = await setup([
				...unitStart,
				{
					commit: '✨ Add the dashboard',
					files: {'apps/web/src/dashboard.ts': 'dashboard\n'},
				},
			]);
			const preview = await units.action({
				CHAMOJI_CLI: units.unitCli,
				GITHUB_EVENT_NAME: 'pull_request',
				CHAMOJI_PR: '7',
				CHAMOJI_BASE_SHA: await units.rev('HEAD~1'),
				CHAMOJI_HEAD_SHA: await units.rev('HEAD'),
				CHAMOJI_NPM_TOKEN: TOKEN,
			});
			expect(preview.code).toBe(0);
			expect(await units.read('body')).toContain('Add the dashboard');
			expect(await units.read('token-calls')).toBe('');

			// Without release units the preview runs the CLI with npx.
			const plain = await setup(pr);
			const viaNpx = await plain.action({
				CHAMOJI_CLI: '',
				GITHUB_EVENT_NAME: 'pull_request_target',
				CHAMOJI_PR: '7',
				CHAMOJI_BASE_SHA: await plain.rev('HEAD~2'),
				CHAMOJI_HEAD_SHA: await plain.rev('HEAD'),
				CHAMOJI_NPM_TOKEN: TOKEN,
			});
			expect(viaNpx.stdout.startsWith(`::add-mask::${TOKEN}\n`)).toBe(true);
			expect(await plain.read('npx-calls')).toContain('changelog');
			expect(await plain.read('token-calls')).toBe('');
		});

		test('publish mode publishes the tag', async () => {
			const {action, unitCli, read} = await setup(
				library({publish: true}).slice(0, 2),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				CHAMOJI_MODE: 'publish',
				GITHUB_REF: 'refs/tags/v1.0.0',
				CHAMOJI_NPM_TOKEN: TOKEN,
			});
			expect(result.code).toBe(0);
			expect(await read('npm-calls')).toMatch(
				/^publish \.\/acme-lib-1\.0\.0\.tgz /m,
			);
			// Once the tag is all on npm, its missing GitHub release is made.
			expect(await read('calls')).toContain('release create v1.0.0');

			const again = await action({
				CHAMOJI_CLI: unitCli,
				FAKE_CLI_VERSION: '0.15.0',
				CHAMOJI_MODE: 'publish',
				GITHUB_REF: 'refs/tags/v1.0.0',
				CHAMOJI_NPM_TOKEN: TOKEN,
				FAKE_NPM_PUBLISHED: '1.0.0',
			});
			expect(again.code).toBe(0);
			expect(await read('summary')).toContain('nothing to publish for v1.0.0');
		});

		test('the version gate asks for 0.15.0 when publish is set', async () => {
			const {action, unitCli, read} = await setup(
				library({trigger: 'merge', publish: true}),
			);
			const result = await action({
				CHAMOJI_CLI: unitCli,
				...merged,
				FAKE_CLI_VERSION: '0.14.0',
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"this repo's release settings need chamoji 0.15.0 or newer; set chamoji-version",
			);
			expect(await read('calls')).toBe('');
			expect(await read('npm-calls')).toBe('');
		});
	});
});
