import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {snapshotWorkstream} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

let repo: FixtureRepo | undefined;
let loose: string | undefined;
afterEach(async () => {
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

test('a commit with a card shows no workstream line', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Why: because\nWorkstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Why: because\n');
	expect(stdout).not.toContain('Auth revamp');
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
