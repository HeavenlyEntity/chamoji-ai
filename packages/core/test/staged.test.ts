import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {isWithheld, readStagedChanges} from '../src/staged.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

async function stage(dir: string, files: Record<string, string>) {
	for (const [file, text] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(dir, file)), {recursive: true});
		await writeFile(path.join(dir, file), text);
	}

	await gitOutput(dir, ['add', '-A']);
}

test('files, status and line counts of what is staged', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await stage(repo.dir, {'src/app.ts': 'one\ntwo\n'});
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ App']);
	await stage(repo.dir, {
		'src/app.ts': 'one\nTWO\nthree\n',
		'src/new.ts': 'a\nb\nc\nd\n',
	});
	const staged = await readStagedChanges(repo.dir);
	expect(staged).toEqual({
		files: [
			{path: 'src/app.ts', status: 'modified', added: 2, deleted: 1},
			{path: 'src/new.ts', status: 'added', added: 4, deleted: 0},
		],
		withheld: 0,
	});
});

test('secrets and lockfiles are withheld, even their names', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await stage(repo.dir, {
		'.env.local': 'TOKEN=shh\n',
		'deploy/id_rsa': 'key\n',
		'pnpm-lock.yaml': 'lock\n',
		'src/app.ts': 'ok\n',
	});
	const staged = await readStagedChanges(repo.dir, {sendDiffs: true});
	expect(staged.files.map(file => file.path)).toEqual(['src/app.ts']);
	expect(staged.withheld).toBe(3);
	expect(staged.diff).toContain('src/app.ts');
	expect(staged.diff).not.toMatch(/shh|id_rsa|env\.local|pnpm-lock/);
});

test('the diff is only read with sendDiffs, and is capped', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const long = Array.from({length: 500}, (_, i) => `line ${i}`).join('\n');
	await stage(repo.dir, {'big.txt': `${long}\n`});
	expect((await readStagedChanges(repo.dir)).diff).toBeUndefined();
	const diff = (await readStagedChanges(repo.dir, {sendDiffs: true})).diff!;
	expect(diff.split('\n').length).toBeLessThanOrEqual(201);
	expect(diff).toContain('lines cut');
});

test('unstaged changes are left out', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await stage(repo.dir, {'a.txt': 'a\n'});
	await writeFile(path.join(repo.dir, 'b.txt'), 'not staged\n');
	const staged = await readStagedChanges(repo.dir);
	expect(staged.files.map(file => file.path)).toEqual(['a.txt']);
});

test.each([
	['.env', true],
	['config/.env.production', true],
	['certs/server.pem', true],
	['keys/deploy.key', true],
	['home/.ssh/id_ed25519', true],
	['src/secrets.ts', true],
	['package-lock.json', true],
	['Cargo.lock', true],
	['src/environment.ts', false],
	['docs/keyboard.md', false],
	['src/app.ts', false],
])('isWithheld(%s) is %s', (file, expected) => {
	expect(isWithheld(file)).toBe(expected);
});

test('a rename reports the new path and its line counts', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const lines = Array.from({length: 20}, (_, i) => `${i}`).join('\n');
	await stage(repo.dir, {'old.txt': `${lines}\n`});
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ Old']);
	await gitOutput(repo.dir, ['mv', 'old.txt', 'new.txt']);
	await writeFile(path.join(repo.dir, 'new.txt'), `${lines}\n20\n`);
	await gitOutput(repo.dir, ['add', '-A']);
	expect((await readStagedChanges(repo.dir)).files).toEqual([
		{path: 'new.txt', status: 'renamed', added: 1, deleted: 0},
	]);
});

test('a rename is withheld when either name is', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await stage(repo.dir, {'.env': 'TOKEN=shh\nMORE=1\nEVEN=2\n'});
	await gitOutput(repo.dir, ['commit', '-q', '-m', '🔧 Env']);
	await gitOutput(repo.dir, ['mv', '.env', 'notes.txt']);
	const staged = await readStagedChanges(repo.dir, {sendDiffs: true});
	expect(staged.files).toEqual([]);
	expect(staged.withheld).toBe(1);
	expect(staged.diff).toBeUndefined();
});

test('file names are literal paths, never pathspec patterns', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await stage(repo.dir, {'.env.local': 'TOKEN=shh\n', '*': 'star\n'});
	const staged = await readStagedChanges(repo.dir, {sendDiffs: true});
	expect(staged.files.map(file => file.path)).toEqual(['*']);
	expect(staged.diff).toContain('star');
	expect(staged.diff).not.toContain('shh');
});

test('secret-shaped strings in the diff are replaced', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await stage(repo.dir, {
		'src/config.ts': [
			'const aws = "AKIAIOSFODNN7EXAMPLE";',
			'const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
			'-----BEGIN OPENSSH PRIVATE KEY-----',
			'b3BlbnNzaC1rZXktdjEAAAAA',
			'-----END OPENSSH PRIVATE KEY-----',
			'const ok = "hello";',
		].join('\n'),
	});
	const {diff} = await readStagedChanges(repo.dir, {sendDiffs: true});
	expect(diff).not.toMatch(/AKIAIOSFODNN7EXAMPLE|ghp_abc|b3BlbnNzaC1rZXkt/);
	expect(diff).toContain('<redacted>');
	expect(diff).toContain('hello');
});

test.each([
	'.envrc',
	'.npmrc',
	'.netrc',
	'.pgpass',
	'.git-credentials',
	'aws/credentials',
	'infra/prod.tfvars',
	'ios/AuthKey.p8',
	'android/release.jks',
	'android/release.keystore',
	'putty/server.ppk',
	'gpg/private.asc',
	'ssh/ID_RSA',
	'certs/SERVER.PEM',
])('%s is withheld', file => {
	expect(isWithheld(file)).toBe(true);
});
