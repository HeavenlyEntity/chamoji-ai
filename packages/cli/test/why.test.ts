import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {snapshotWorkstream} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';
import {recordingFace} from './helpers/recording-face.js';

let repo: FixtureRepo | undefined;
let loose: string | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	await repo?.cleanup();
	repo = undefined;
	if (loose) await rm(loose, {recursive: true, force: true});
	loose = undefined;
});

async function chamoji(argv: string[], cwd: string) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
	});
	return {code, stdout, stderr};
}

const FILES = {'src/a.ts': 'one\ntwo\nthree\n'};

test('prints the commit and its card', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: because\nConstraint: no network\nGotcha: order matters\nFollow-up: tidy later',
			files: FILES,
		},
	]);
	const {code, stdout, stderr} = await chamoji(['why', 'src/a.ts:2'], repo.dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toMatch(/^[0-9a-f]{7} ✨ Add a\nFixture Bot, 2026-01-01\n\n/);
	expect(stdout).toContain(
		'Why: because\nConstraint: no network\nGotcha: order matters\nFollow-up: tidy later\n',
	);
	expect(stdout).not.toContain('This reason is thin');
});

test('a commit with no card still prints its subject and says so', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('✨ Add a');
	expect(stdout).toContain('This commit records no intent.');
});

test('--json prints the BlameResult', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Why: because', files: FILES},
	]);
	const {code, stdout} = await chamoji(
		['why', 'src/a.ts:3', '--json'],
		repo.dir,
	);
	expect(code).toBe(0);
	const result = JSON.parse(stdout);
	expect(result.kind).toBe('commit');
	expect(result.commit.subject).toBe('✨ Add a');
	expect(result.commit.card.why).toEqual(['because']);
});

test('strips terminal escapes from commit text', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add \u001B[31mred\u001B[0m',
			body: 'Why: \u001B]0;owned\u0007because\u009B1m',
			files: FILES,
		},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Add [31mred[0m');
	expect(stdout).toContain('Why: ]0;ownedbecause1m');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('says when the line is not committed yet', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	await appendFile(path.join(repo.dir, 'src/a.ts'), 'four\n');
	const {code, stdout} = await chamoji(['why', 'src/a.ts:4'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toBe('src/a.ts:4 is not committed yet.\n');
});

test('reports a bad location plainly', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stderr} = await chamoji(['why', 'src/a.ts'], repo.dir);
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: ');
	expect(stderr).toContain('src/a.ts');
});

test('asks for exactly one location', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const none = await chamoji(['why'], repo.dir);
	expect(none.code).toBe(2);
	expect(none.stderr).toContain('why needs one location');
	const two = await chamoji(['why', 'a.ts:1', 'b.ts:2'], repo.dir);
	expect(two.code).toBe(2);
});

test('outside a repo reports it plainly', async () => {
	loose = await mkdtemp(path.join(tmpdir(), 'chamoji-why-'));
	const {code, stderr} = await chamoji(['why', 'a.ts:1'], loose);
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: Not a git repository');
});

const SHIPPED = {
	'.chamoji/workstreams.yml':
		'workstreams:\n  auth:\n    title: Auth revamp\n    emoji: 🔐\n    status: shipped\n',
};

test('why falls back to the workstream summary', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	// With the file gone, only the memory ref knows the title.
	await rm(path.join(repo.dir, '.chamoji'), {recursive: true});
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('This commit records no intent.\n');
	expect(stdout).toContain('Workstream: 🔐 Auth revamp (shipped)\n');
});

test('why takes the title from the workstreams file before any snapshot', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Workstream: 🔐 Auth revamp (shipped)\n');
});

test('a commit with a good card shows no workstream line', async () => {
	const why = 'the old form leaked sessions after the tab closed';
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{
			commit: '✨ Add a',
			body: `Why: ${why}\nWorkstream: auth`,
			files: FILES,
		},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain(`Why: ${why}\n`);
	expect(stdout).not.toContain('Auth revamp');
});

test('a thin card still shows the workstream line', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Why: because\nWorkstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Workstream: 🔐 Auth revamp (shipped)\n');
});

test('a workstream nothing knows about leaves the plain answer', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Workstream: gone', files: FILES},
	]);
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('This commit records no intent.\n');
	expect(stdout).not.toContain('Workstream:');
});

test('a corrupt workstreams file does not stop why', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	await mkdir(path.join(repo.dir, '.chamoji'));
	await writeFile(path.join(repo.dir, '.chamoji/workstreams.yml'), 'a: [\n');
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('This commit records no intent.\n');
});

test('the workstream summary strips terminal escapes', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml':
					'workstreams:\n  auth:\n    title: "Auth \\e[31mred"\n    status: active\n',
			},
		},
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Workstream: Auth [31mred (active)\n');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('a separator byte in an author name puts no escape text on stdout', async () => {
	// Git keeps \u001F inside a name, which moves every field after it along.
	vi.stubEnv('GIT_AUTHOR_NAME', 'a\u001Fb\u001F\u001B[31mevil');
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	vi.unstubAllEnvs();
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('[31mevil');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('why is one step, and prints what it printed before', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Why: because', files: FILES},
	]);
	const plain = await chamoji(['why', 'src/a.ts:2'], repo.dir);
	const {face, calls} = recordingFace();
	let stdout = '';
	const code = await run(['why', 'src/a.ts:2'], {
		cwd: repo.dir,
		stdout: text => (stdout += text),
		stderr() {},
		face,
	});
	expect(code).toBe(0);
	expect(stdout).toBe(plain.stdout);
	expect(calls).toEqual([
		['step', 'Finding the commit that wrote the line'],
		['end', 'ok', 'Found the commit'],
		['stop'],
	]);
});

const NOTICE =
	'This reason is thin. Look at the PR, issue and nearby commits too.';

async function thinRepo(why: string) {
	return createRepo([
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked sessions after the tab closed, so logins stayed open',
			files: FILES,
		},
		{
			commit: '🐛 Fix login (#12)',
			body: `Why: ${why}`,
			files: {'src/a.ts': 'one\ntwo\nthree\nfour\n'},
		},
	]);
}

test('a thin card prints the notice, the PR and nearby commits', async () => {
	repo = await thinRepo('fix bug');
	const {stdout} = await chamoji(['why', 'src/a.ts:4'], repo.dir);
	expect(stdout).toContain(`Why: fix bug\n${NOTICE}\n`);
	expect(stdout).toContain('PR: #12\n');
	expect(stdout).toMatch(
		/Nearby: [0-9a-f]{7} ✨ Add login\n {2}Why: the old form leaked sessions/,
	);
});

test('a good card prints no notice and no clues', async () => {
	repo = await thinRepo(
		'a retry storm took the login service down when the token expired',
	);
	const {stdout} = await chamoji(['why', 'src/a.ts:4'], repo.dir);
	expect(stdout).not.toContain(NOTICE);
	expect(stdout).not.toContain('Nearby:');
	expect(stdout).not.toContain('PR:');
});

test('--json adds whyQuality, whyReasons and clues', async () => {
	repo = await thinRepo('fix bug');
	const {stdout} = await chamoji(['why', 'src/a.ts:4', '--json'], repo.dir);
	const result = JSON.parse(stdout);
	expect(result.kind).toBe('commit');
	expect(result.whyQuality).toBe('thin');
	expect(result.whyReasons).toEqual(['filler', 'too-short']);
	expect(result.clues.pr).toBe(12);
	expect(result.clues.nearby).toHaveLength(1);
});

const REASON = 'the provider returns 422 for stays over 365 nights';

async function hashOf(dir: string, rev = 'HEAD') {
	return (await gitOutput(dir, ['rev-parse', rev])).trim();
}

test('--amend adds a reason that shows first, marked as added later', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const hash = await hashOf(repo.dir);
	const added = await chamoji(
		['why', '--amend', hash, ...REASON.split(' ')],
		repo.dir,
	);
	expect(added.stderr).toBe('');
	expect(added.code).toBe(0);
	expect(added.stdout).toMatch(
		/^Added a reason to [0-9a-f]{7} 🐛 Fix bug\. Share it with: git push origin refs\/notes\/chamoji\n$/,
	);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain(`Why: ${REASON} (added later)\nWhy: fix bug\n`);
	expect(stdout).not.toContain('This reason is thin');
});

test('--amend refuses a reason that is thin too and writes nothing', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const {code, stderr} = await chamoji(
		['why', '--amend', await hashOf(repo.dir), 'fix', 'it'],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stderr).toContain('that reason is thin too.');
	expect(await gitOutput(repo.dir, ['notes', '--ref=chamoji', 'list'])).toBe(
		'',
	);
});

test('--amend takes a file:line and refuses an empty reason', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const done = await chamoji(
		['why', '--amend', 'src/a.ts:1', ...REASON.split(' ')],
		repo.dir,
	);
	expect(done.code).toBe(0);
	expect((await chamoji(['why', 'src/a.ts:2'], repo.dir)).stdout).toContain(
		`Why: ${REASON} (added later)`,
	);
	const empty = await chamoji(['why', '--amend', 'src/a.ts:1'], repo.dir);
	expect(empty.code).toBe(2);
});

test('--amend on an uncommitted line exits 1 and an unknown commit exits 1', async () => {
	repo = await createRepo([{commit: '🐛 Fix bug', files: FILES}]);
	await appendFile(path.join(repo.dir, 'src/a.ts'), 'four\n');
	const line = await chamoji(
		['why', '--amend', 'src/a.ts:4', REASON],
		repo.dir,
	);
	expect(line.code).toBe(1);
	expect(line.stderr).toBe(
		'chamoji: src/a.ts:4 is not committed yet, so there is no commit to add a reason to.\n',
	);
	const unknown = await chamoji(['why', '--amend', 'nope', REASON], repo.dir);
	expect(unknown.code).toBe(1);
});

test('--thin lists thin and missing Whys behind a path', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: the provider returns 422 for stays over 365 nights',
			files: {'src/a.ts': 'a1\na2\n'},
		},
		{
			commit: '🐛 Fix b',
			body: 'Why: fix bug',
			files: {'src/b.ts': 'b1\nb2\nb3\nb4\nb5\n'},
		},
		{commit: '✨ Add c', files: {'src/c.ts': 'c1\n'}},
	]);
	const {code, stdout, stderr} = await chamoji(['why', '--thin'], repo.dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toContain('5 lines');
	expect(stdout).toContain('Why: fix bug');
	expect(stdout).toContain('No Why.');
	expect(stdout).toContain(
		'Add a better reason with: chamoji why --amend <hash> "<reason>"',
	);

	const none = await chamoji(['why', '--thin', 'src/a.ts'], repo.dir);
	expect(none.code).toBe(0);
	expect(none.stdout).toContain('No thin Whys behind src/a.ts.');

	const json = await chamoji(['why', '--thin', '--json'], repo.dir);
	expect(JSON.parse(json.stdout)).toHaveLength(2);
});

test('--thin refuses a path outside the repository with exit 2', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stdout, stderr} = await chamoji(
		['why', '--thin', '../outside'],
		repo.dir,
	);
	expect(code).toBe(2);
	expect(stdout).toBe('');
	expect(stderr).toBe('chamoji: ../outside is outside the repository.\n');
});

test('--thin refuses an absolute path outside the repository with exit 2', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const outside = path.dirname(repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['why', '--thin', outside],
		repo.dir,
	);
	expect(code).toBe(2);
	expect(stdout).toBe('');
	expect(stderr).toBe(`chamoji: ${outside} is outside the repository.\n`);
});
