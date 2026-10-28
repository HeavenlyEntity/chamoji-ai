import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {
	cacheFile,
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

test('install kind comes from where chamoji runs', () => {
	expect(
		installKind('/Users/a/.npm/_npx/1a2b/node_modules/.bin/chamoji', '/w'),
	).toBe('npx');
	expect(
		installKind(
			'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\.bin\\chamoji',
			'/w',
		),
	).toBe('npx');
	// path.resolve gives a drive letter on Windows, so both sides match there too.
	expect(
		installKind(
			path.resolve('/work/app/node_modules/.bin/chamoji'),
			path.resolve('/work/app/src'),
		),
	).toBe('project');
	expect(
		installKind(
			path.resolve('/usr/local/lib/node_modules/@chamoji/cli/dist/cli.js'),
			path.resolve('/work/app'),
		),
	).toBe('global');
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
