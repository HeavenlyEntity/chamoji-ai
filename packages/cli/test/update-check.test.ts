import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {
	cacheFile,
	createUpdateCheck,
	installKind,
	isStale,
	readCache,
	updateCheckEnabled,
	updateNotice,
	type UpdateCheck,
} from '../src/update-check.js';
import {run} from '../src/run.js';
import {
	createRepo,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';

let dir: string;
let repo: FixtureRepo | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-update-'));
});

afterEach(async () => {
	await rm(dir, {recursive: true, force: true});
	await repo?.cleanup();
	repo = undefined;
});

test.each([
	['CI is set', {CI: 'true'}, true, true],
	['NO_UPDATE_NOTIFIER is set', {NO_UPDATE_NOTIFIER: '1'}, true, true],
	['CHAMOJI_NO_UPDATE_CHECK=1', {CHAMOJI_NO_UPDATE_CHECK: '1'}, true, true],
	['stderr is not a terminal', {}, false, true],
	['--no-update-check', {}, true, false],
])('the check is off when %s', (_name, env, stderrIsTTY, flag) => {
	expect(updateCheckEnabled(env, stderrIsTTY, flag)).toBe(false);
});

test('the check is on in a plain terminal', () => {
	expect(updateCheckEnabled({}, true, true)).toBe(true);
	expect(updateCheckEnabled({CI: ''}, true, true)).toBe(true);
});

test('cache file follows each platform convention', () => {
	expect(cacheFile({XDG_CONFIG_HOME: '/x'}, 'linux', '/home/a')).toBe(
		path.join('/x', 'chamoji', 'update-check.json'),
	);
	expect(
		cacheFile(
			{APPDATA: 'C:\\Users\\a\\AppData\\Roaming'},
			'win32',
			'C:\\Users\\a',
		),
	).toBe(
		path.join('C:\\Users\\a\\AppData\\Roaming', 'chamoji', 'update-check.json'),
	);
	expect(cacheFile({}, 'darwin', '/Users/a')).toBe(
		path.join('/Users/a', '.config', 'chamoji', 'update-check.json'),
	);
});

test('a missing or corrupt cache reads as undefined', async () => {
	const file = path.join(dir, 'update-check.json');
	expect(readCache(file)).toBeUndefined();
	await writeFile(file, '{nope');
	expect(readCache(file)).toBeUndefined();
	await writeFile(file, JSON.stringify({checkedAt: 'x', latest: 3}));
	expect(readCache(file)).toBeUndefined();
	await writeFile(file, JSON.stringify({checkedAt: 5, latest: '1.0.0'}));
	expect(readCache(file)).toEqual({checkedAt: 5, latest: '1.0.0'});
});

test('the cache goes stale after 24 hours', () => {
	const day = 24 * 60 * 60 * 1000;
	expect(isStale(undefined, 0)).toBe(true);
	expect(isStale({checkedAt: 0, latest: '1.0.0'}, day - 1)).toBe(false);
	expect(isStale({checkedAt: 0, latest: '1.0.0'}, day + 1)).toBe(true);
});

test.each([
	['/Users/a/.npm/_npx/1a2b/node_modules/.bin/chamoji', 'npx'],
	[
		'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\.bin\\chamoji',
		'npx',
	],
	[
		'/Users/a/Library/Caches/pnpm/dlx/abc/node_modules/@chamoji/cli/dist/cli.js',
		'dlx',
	],
	[
		'/private/var/folders/x/T/dlx-1234/node_modules/@chamoji/cli/dist/cli.js',
		'dlx',
	],
	['/Users/a/.bun/install/cache/@chamoji/cli@0.4.0/dist/cli.js', 'dlx'],
	[
		'/Users/a/Library/pnpm/global/5/node_modules/@chamoji/cli/dist/cli.js',
		'pnpm-global',
	],
	[
		'/Users/a/.config/yarn/global/node_modules/@chamoji/cli/dist/cli.js',
		'yarn-global',
	],
	['/usr/local/lib/node_modules/@chamoji/cli/dist/cli.js', 'global'],
	[
		'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@chamoji\\cli\\dist\\cli.js',
		'global',
	],
	['/usr/local/bin/chamoji', 'global'],
	['/work/app/node_modules/.bin/chamoji', 'project'],
	[
		'/work/app/node_modules/.pnpm/@chamoji+cli@0.4.0/node_modules/@chamoji/cli/dist/cli.js',
		'project',
	],
	['C:\\Work\\App\\node_modules\\.bin\\chamoji', 'project'],
])('install kind of %s is %s', (scriptPath, kind) => {
	expect(installKind(scriptPath)).toBe(kind);
});

test('a cache dated in the future counts as stale', () => {
	expect(isStale({checkedAt: 10_000, latest: '1.0.0'}, 5000)).toBe(true);
});

test('a relative XDG_CONFIG_HOME is ignored', () => {
	expect(cacheFile({XDG_CONFIG_HOME: 'relative/dir'}, 'linux', '/home/a')).toBe(
		path.join('/home/a', '.config', 'chamoji', 'update-check.json'),
	);
});

test('refreshIfStale records the attempt first and starts at most one worker', async () => {
	const file = path.join(dir, 'cfg', 'chamoji', 'update-check.json');
	const spawned: string[] = [];
	const check = createUpdateCheck({
		current: '0.4.0',
		env: {XDG_CONFIG_HOME: path.join(dir, 'cfg')},
		stderrIsTTY: true,
		scriptPath: '/usr/local/bin/chamoji',
		now: () => 1_000_000,
		startWorker: cache => spawned.push(cache),
	});
	check.refreshIfStale();
	check.refreshIfStale();
	expect(spawned).toEqual([file]);
	expect(readCache(file)).toEqual({checkedAt: 1_000_000, latest: ''});
});

test('refreshIfStale starts no worker when the cache cannot be written', async () => {
	// A file where the config directory should be makes the write fail.
	await writeFile(path.join(dir, 'blocked'), '');
	const spawned: string[] = [];
	createUpdateCheck({
		current: '0.4.0',
		env: {XDG_CONFIG_HOME: path.join(dir, 'blocked')},
		stderrIsTTY: true,
		scriptPath: '/usr/local/bin/chamoji',
		startWorker: cache => spawned.push(cache),
	}).refreshIfStale();
	expect(spawned).toEqual([]);
});

test('notices only for newer stable versions', () => {
	expect(updateNotice('0.3.0', '0.4.0', 'global')).toBe(
		'chamoji 0.4.0 is available (you have 0.3.0): npm i -g @chamoji/cli@latest',
	);
	expect(updateNotice('0.3.0', '0.4.0', 'npx')).toBe(
		'chamoji 0.4.0 is available (you have 0.3.0): run npx @chamoji/cli@latest',
	);
	expect(updateNotice('0.3.0', '0.4.0', 'project')).toBe(
		'chamoji 0.4.0 is available (you have 0.3.0): update @chamoji/cli in package.json',
	);
	expect(updateNotice('0.3.0', '0.4.0', 'dlx')).toBe(
		'chamoji 0.4.0 is available (you have 0.3.0): run it with @chamoji/cli@latest',
	);
	expect(updateNotice('0.3.0', '0.4.0', 'pnpm-global')).toBe(
		'chamoji 0.4.0 is available (you have 0.3.0): pnpm add -g @chamoji/cli@latest',
	);
	expect(updateNotice('0.3.0', '0.4.0', 'yarn-global')).toBe(
		'chamoji 0.4.0 is available (you have 0.3.0): yarn global add @chamoji/cli@latest',
	);
	expect(updateNotice('0.4.0', '0.4.0', 'global')).toBeUndefined();
	expect(updateNotice('0.5.0', '0.4.0', 'global')).toBeUndefined();
	expect(updateNotice('0.3.0', '0.5.0-beta.1', 'global')).toBeUndefined();
	expect(updateNotice('0.3.0', 'garbage', 'global')).toBeUndefined();
});

async function chamoji(argv: string[], updateCheck: UpdateCheck) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd: repo!.dir,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		updateCheck,
	});
	return {code, stdout, stderr};
}

const fakeCheck = (notice?: string) => {
	const calls = {refresh: 0};
	const check: UpdateCheck = {
		notice: () => notice,
		refreshIfStale: () => {
			calls.refresh++;
		},
	};
	return {check, calls};
};

test('run prints the notice on stderr and leaves stdout untouched', async () => {
	repo = await createRepo([
		{commit: '✨ Add'},
		{tag: 'v1.0.0'},
		{commit: '🐛 Fix'},
	]);
	const quiet = await chamoji(['next-version'], fakeCheck().check);
	const {check, calls} = fakeCheck(
		'chamoji 9.9.9 is available (you have 0.3.0): npm i -g @chamoji/cli@latest',
	);
	const noisy = await chamoji(['next-version'], check);

	expect(noisy.stdout).toBe(quiet.stdout);
	expect(noisy.stdout).toBe('1.0.1\n');
	expect(noisy.stderr).toBe(
		'\nchamoji 9.9.9 is available (you have 0.3.0): npm i -g @chamoji/cli@latest\n',
	);
	expect(calls.refresh).toBe(1);
});

test('--no-update-check skips the notice and the refresh', async () => {
	repo = await createRepo([{commit: '✨ Add'}]);
	const {check, calls} = fakeCheck('chamoji 9.9.9 is available');
	const {stderr} = await chamoji(['changelog', '--no-update-check'], check);
	expect(stderr).toBe('');
	expect(calls.refresh).toBe(0);
});
