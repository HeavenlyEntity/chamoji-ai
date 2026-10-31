import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	type FixtureRepo,
	type RepoStep,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';

const execFileAsync = promisify(execFile);

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
	const {code, stdout} = await chamoji(
		['changelog', '--format', 'json'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(
		JSON.parse(stdout).releases.map((r: {version: string}) => r.version),
	).toEqual(['Unreleased', 'v1.0.0']);
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

test('next-version exits 3 with no output when nothing needs releasing', async () => {
	repo = await createRepo([
		{commit: '✨ Add'},
		{tag: 'v1.0.0'},
		{commit: '📝 Docs only'},
	]);
	const {code, stdout, stderr} = await chamoji(['next-version'], repo.dir);
	expect(code).toBe(3);
	expect(stdout).toBe('');
	expect(stderr).toContain('no release needed');
});

test('format names are not looked up on the object prototype', async () => {
	repo = await createRepo(history);
	const {code, stderr} = await chamoji(
		['changelog', '--format', 'constructor'],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stderr).toContain('Unknown format "constructor"');
});

test('unknown format exits 1 with a message', async () => {
	repo = await createRepo(history);
	const {code, stderr} = await chamoji(
		['changelog', '--format', 'pdf'],
		repo.dir,
	);
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

test('--ai without an API key exits 1 with a clear message', async () => {
	repo = await createRepo(history);
	const saved = process.env['TYPESAFE_API_KEY'];
	delete process.env['TYPESAFE_API_KEY'];
	try {
		const {code, stderr} = await chamoji(['changelog', '--ai'], repo.dir);
		expect(code).toBe(1);
		expect(stderr).toContain('--ai needs a TypeSafe API key');
	} finally {
		if (saved !== undefined) {
			process.env['TYPESAFE_API_KEY'] = saved;
		}
	}
});

test('--ai with a truncated API key explains the problem', async () => {
	repo = await createRepo(history);
	const saved = process.env['TYPESAFE_API_KEY'];
	process.env['TYPESAFE_API_KEY'] = 'tsk_abc…';
	try {
		const {code, stderr} = await chamoji(['changelog', '--ai'], repo.dir);
		expect(code).toBe(1);
		expect(stderr).toContain(
			'TYPESAFE_API_KEY contains "…", so it looks truncated',
		);
		expect(stderr).not.toContain('tsk_abc');
	} finally {
		if (saved === undefined) {
			delete process.env['TYPESAFE_API_KEY'];
		} else {
			process.env['TYPESAFE_API_KEY'] = saved;
		}
	}
});

test('--ai uses a key from .env.local in the repo', async () => {
	repo = await createRepo([{commit: 'Tidelift tasks'}]);
	await writeFile(path.join(repo.dir, '.env.local'), 'TYPESAFE_API_KEY=bad…\n');
	const saved = process.env['TYPESAFE_API_KEY'];
	delete process.env['TYPESAFE_API_KEY'];
	try {
		// The truncated-key check proves the file's key reached the client setup.
		const {code, stderr} = await chamoji(['changelog', '--ai'], repo.dir);
		expect(code).toBe(1);
		expect(stderr).toContain('looks truncated');
	} finally {
		if (saved !== undefined) {
			process.env['TYPESAFE_API_KEY'] = saved;
		}
	}
});

test('changelog --since previews only the commits after a ref', async () => {
	repo = await createRepo([...history, {commit: '🐛 Fix search'}]);
	const {code, stdout} = await chamoji(
		['changelog', '--since', 'HEAD~1', '--format', 'json'],
		repo.dir,
	);
	expect(code).toBe(0);
	const {releases} = JSON.parse(stdout);
	expect(releases).toHaveLength(1);
	expect(releases[0].groups.map((g: {label: string}) => g.label)).toEqual([
		'Fixed',
	]);
});

async function withOrigin(url: string): Promise<string> {
	repo = await createRepo(history);
	await execFileAsync('git', ['remote', 'add', 'origin', url], {
		cwd: repo.dir,
	});
	return repo.dir;
}

test('card prints the renderer URL for the repo', async () => {
	repo = await createRepo(history);
	const {code, stdout, stderr} = await chamoji(
		['card', '--repo', 'acme/widgets'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stderr).toBe('');
	expect(
		stdout.startsWith('https://chamoji.dev/api/card?repo=acme%2Fwidgets'),
	).toBe(true);
	expect(stdout.endsWith('\n')).toBe(true);
	expect(stdout.endsWith('\n\n')).toBe(false);
});

test('card reads the repo from the origin remote', async () => {
	const dir = await withOrigin('https://github.com/acme/widgets.git');
	const {code, stdout} = await chamoji(['card'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('repo=acme%2Fwidgets');
});

test('card reads an SSH origin too', async () => {
	const dir = await withOrigin('git@github.com:acme/widgets.git');
	const {code, stdout} = await chamoji(['card'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain('repo=acme%2Fwidgets');
});

test('card asks for --repo when origin is not on GitHub', async () => {
	const dir = await withOrigin('https://gitlab.com/acme/widgets.git');
	const {code, stdout, stderr} = await chamoji(['card'], dir);
	expect(code).toBe(1);
	expect(stdout).toBe('');
	expect(stderr).toContain(
		"chamoji: can't tell the repo; pass --repo owner/name",
	);
});

test('card --endpoint replaces the renderer', async () => {
	repo = await createRepo(history);
	const {code, stdout} = await chamoji(
		[
			'card',
			'--repo',
			'acme/widgets',
			'--endpoint',
			'http://localhost:3100/api/card',
		],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout.startsWith('http://localhost:3100/api/card?repo=')).toBe(true);
});

test('card refuses an endpoint that is not a URL', async () => {
	repo = await createRepo(history);
	const {code, stdout, stderr} = await chamoji(
		['card', '--repo', 'acme/widgets', '--endpoint', 'not a url'],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stdout).toBe('');
	expect(stderr).toContain('chamoji:');
});

test('card --json prints the stats', async () => {
	repo = await createRepo(history);
	const {code, stdout} = await chamoji(
		['card', '--repo', 'acme/widgets', '--json'],
		repo.dir,
	);
	expect(code).toBe(0);
	const stats = JSON.parse(stdout);
	expect(stats).toMatchObject({repo: 'acme/widgets', version: 'v1.0.0'});
	expect(stats).toHaveProperty('sorted');
});

test('card never calls the classifier, even with --ai', async () => {
	repo = await createRepo(history);
	const saved = process.env['TYPESAFE_API_KEY'];
	delete process.env['TYPESAFE_API_KEY'];
	try {
		// Without a key, building the classifier throws; card must not build it.
		const {code, stdout, stderr} = await chamoji(
			['card', '--repo', 'acme/widgets', '--ai'],
			repo.dir,
		);
		expect(stderr).toBe('');
		expect(code).toBe(0);
		expect(stdout).toContain('repo=acme%2Fwidgets');
	} finally {
		if (saved !== undefined) {
			process.env['TYPESAFE_API_KEY'] = saved;
		}
	}
});
