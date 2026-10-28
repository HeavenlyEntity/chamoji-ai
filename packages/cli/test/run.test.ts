import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	type FixtureRepo,
	type RepoStep,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

async function chamoji(argv: string[], cwd: string) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-10-27',
	});
	return {code, stdout, stderr};
}

const history: RepoStep[] = [
	{commit: '🎉 Init'},
	{tag: 'v1.0.0'},
	{commit: '✨ Add search'},
];

test('changelog json on a fixture repo', async () => {
	repo = await createRepo(history);
	const {code, stdout} = await chamoji(['changelog', '--format', 'json'], repo.dir);
	expect(code).toBe(0);
	expect(JSON.parse(stdout).releases.map((r: {version: string}) => r.version)).toEqual(
		['Unreleased', 'v1.0.0'],
	);
});

test('changelog defaults to markdown and accepts md alias', async () => {
	repo = await createRepo(history);
	const plain = await chamoji(['changelog'], repo.dir);
	const alias = await chamoji(['changelog', '--format=md'], repo.dir);
	expect(plain.stdout).toMatch(/^# Changelog\n/);
	expect(alias.stdout).toBe(plain.stdout);
});

test('--output writes the file', async () => {
	repo = await createRepo(history);
	const {code, stdout, stderr} = await chamoji(
		['changelog', '--output', 'CHANGELOG.md', '--release', '1.1.0'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe('');
	expect(stderr).toBe('Wrote CHANGELOG.md\n');
	const written = await readFile(path.join(repo.dir, 'CHANGELOG.md'), 'utf8');
	expect(written).toContain('## 1.1.0 - 2026-10-27');
});

test('next-version prints the minor bump', async () => {
	repo = await createRepo(history);
	expect(await chamoji(['next-version'], repo.dir)).toEqual({
		code: 0,
		stdout: '1.1.0\n',
		stderr: '',
	});
});

test('next-version prints none when nothing needs releasing', async () => {
	repo = await createRepo([{commit: '✨ Add'}, {tag: 'v1.0.0'}]);
	expect((await chamoji(['next-version'], repo.dir)).stdout).toBe('none\n');
});

test('unknown format exits 1 with a message', async () => {
	repo = await createRepo(history);
	const {code, stderr} = await chamoji(['changelog', '--format', 'pdf'], repo.dir);
	expect(code).toBe(1);
	expect(stderr).toBe(
		'chamoji: Unknown format "pdf" (use markdown, json or html)\n',
	);
});

test('outside a repo exits 1 with a message', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-nogit-'));
	try {
		const {code, stderr} = await chamoji(['changelog'], dir);
		expect(code).toBe(1);
		expect(stderr).toBe(`chamoji: Not a git repository: ${dir}\n`);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test('no command prints help and exits 2', async () => {
	const {code, stderr} = await chamoji([], tmpdir());
	expect(code).toBe(2);
	expect(stderr).toContain('$ chamoji changelog');
});

test('--help exits 0', async () => {
	const {code, stdout} = await chamoji(['--help'], tmpdir());
	expect(code).toBe(0);
	expect(stdout).toContain('$ chamoji next-version');
});
