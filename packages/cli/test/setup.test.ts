import {existsSync} from 'node:fs';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	detect,
	fetchesMemory,
	recommend,
	releaseSection,
	summary,
	writeReleaseSection,
} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {
	gearzLayout,
	singlePackage,
} from '../../core/test/helpers/setup-fixtures.js';
import {hookPath, readHookState} from '../src/hook.js';
import {run, type GhRunner, type Io} from '../src/run.js';
import {checkSquashMerge, type SetupScreenProps} from '../src/setup/setup.js';

/** Native Windows has no unprivileged symlinks. */
const WINDOWS = process.platform === 'win32';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

const WROTE =
	'Wrote chamoji.config.json. Review it and commit it; git restore chamoji.config.json undoes this.';
const NO_TERMINAL =
	'chamoji: setup needs a terminal to ask; run chamoji setup --yes to take every recommended answer';
const SINGLE =
	"One package, so chamoji release already knows what to do; there's nothing to set up for releases.";
const SQUASH_ADVICE =
	'Squash merges here keep only the PR title or its description, which drops the commits\' Release:, Workstream: and intent-card lines. In the repo\'s Settings → General → Pull Requests, set "Default commit message" for squash merges to "Default message" or "Pull request title and commit details".';
const SQUASH_QUERY = [
	'--jq',
	'[.allow_squash_merge, .squash_merge_commit_title, .squash_merge_commit_message] | @tsv',
];

/** A gh that isn't installed, recording what it was asked. */
function noGh(): GhRunner & {calls: string[][]} {
	const calls: string[][] = [];
	const gh = async (args: string[]) => {
		calls.push(args);
		return {ok: false, message: 'no gh CLI, so no GitHub release'};
	};

	return Object.assign(gh, {calls});
}

async function chamoji(argv: string[], cwd: string, extra: Partial<Io> = {}) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-11-04',
		fetchTags: false,
		gh: noGh(),
		// No PATH: chamoji and claude are never "installed", whatever this machine has.
		env: {},
		...extra,
	});
	return {code, stdout, stderr};
}

/** Makes stderr a terminal until the test ends. */
function asTerminal(): void {
	const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
	Object.defineProperty(process.stderr, 'isTTY', {
		value: true,
		configurable: true,
	});
	cleanups.push(async () => {
		if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
		else delete (process.stderr as {isTTY?: boolean}).isTTY;
	});
}

/** A gh that answers `message`, recording each call's args and options. */
function answering(
	message: string,
): GhRunner & {calls: string[][]; options: unknown[]} {
	const calls: string[][] = [];
	const options: unknown[] = [];
	return Object.assign(
		async (args: string[], given?: unknown) => {
			calls.push(args);
			options.push(given);
			return {ok: true, message};
		},
		{calls, options},
	);
}

async function made(fixture: Promise<FixtureRepo>): Promise<string> {
	const repo = await fixture;
	cleanups.push(async () => repo.cleanup());
	return repo.dir;
}

/** Adds a bare origin, so the memory step has somewhere to share with (ruling R5). */
async function withOrigin(dir: string): Promise<string> {
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-setup-origin-'));
	cleanups.push(async () => rm(remote, {recursive: true, force: true}));
	await gitOutput(remote, ['init', '-q', '--bare', '-b', 'main']);
	await gitOutput(dir, ['remote', 'add', 'origin', remote]);
	return dir;
}

const gearz = async () => withOrigin(await made(gearzLayout({template: true})));

const readConfig = async (dir: string): Promise<{release: unknown}> =>
	JSON.parse(await readFile(path.join(dir, 'chamoji.config.json'), 'utf8')) as {
		release: unknown;
	};

/** Task 4's expectation: the spec's example, with `since` the oldest own commit. */
async function gearzSection(dir: string) {
	const since = (
		await gitOutput(dir, [
			'rev-list',
			'--reverse',
			'HEAD',
			'--not',
			'--remotes=upstream',
		])
	).split('\n')[0];
	return {
		schema: 1,
		shape: 'apps',
		units: {
			web: {path: 'apps/web', tag: 'web/v{version}'},
			mobile: {
				path: 'apps/mobile',
				tag: 'mobile/v{version}',
				versionFiles: ['apps/mobile/app.config.ts'],
				buildNumber: 'untouched',
			},
		},
		exclude: ['apps/dev-tool', 'apps/e2e', 'tooling/*'],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		zeroMajor: 'minor',
		upstream: {
			remote: 'upstream',
			name: 'Makerkit',
			since,
		},
		tags: {
			ignore: [
				String.raw`^\d+\.\d+\.\d+$`,
				String.raw`^v\d+\.\d+\.\d+-\d+$`,
				'^wip/',
			],
		},
	};
}

type Report = {
	found: {
		kind: string;
		units: string[];
		excluded: string[];
		inheritedTags: string[];
		upstream: {
			remote: string | null;
			name: string | null;
			since: string | null;
			authors: Array<{email: string; name: string; commits: number}>;
		};
	} | null;
	answers: unknown;
	why: Record<string, string>;
	steps: Array<{step: string; result: string}>;
	wrote: string[];
	squashMerge: string | null;
};

const results = (report: Report) =>
	Object.fromEntries(report.steps.map(({step, result}) => [step, result]));

test('setup --yes on gearz writes the recommended section and runs memory, not the hook', async () => {
	const dir = await gearz();
	const {code, stdout, stderr} = await chamoji(['setup', '--yes'], dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect((await readConfig(dir)).release).toEqual(await gearzSection(dir));
	expect(stdout).toContain(`${WROTE}\n`);
	expect(stdout).toContain('origin now fetches chamoji memory.\n');
	expect(await fetchesMemory(dir)).toBe(true);
	expect(await readHookState(dir)).toBe('missing');
	// Setup never commits.
	expect(await gitOutput(dir, ['status', '--porcelain'])).toContain(
		'?? chamoji.config.json',
	);

	// Then release --dry-run accepts it, once web has a feature to release.
	const commit = async (message: string, file: string) => {
		await gitOutput(dir, ['add', file]);
		await gitOutput(dir, [
			'-c',
			'user.name=Dev',
			'-c',
			'user.email=dev@example.com',
			'commit',
			'-q',
			'-m',
			message,
		]);
	};

	await commit('🔧 Set up releases', 'chamoji.config.json');
	await writeFile(path.join(dir, 'apps/web/dashboard.ts'), 'dashboard\n');
	await commit('✨ Add the dashboard', 'apps/web/dashboard.ts');
	const dry = await chamoji(['release', '--dry-run', '--any-branch'], dir);
	expect(dry.stderr).toBe('');
	expect(dry.code).toBe(0);
	expect(dry.stdout).toMatch(/^web {2}/m);
});

test('with no origin, the memory step has nothing to do', async () => {
	const dir = await made(gearzLayout({template: true}));
	const {code, stdout} = await chamoji(['setup', '--yes', '--json'], dir);
	expect(code).toBe(0);
	expect(results(JSON.parse(stdout) as Report).memory).toBe('nothing-to-do');
	expect(await fetchesMemory(dir)).toBe(false);
});

test('no terminal and no --yes prints what it would do and exits 2 without writing', async () => {
	const dir = await gearz();
	const detection = await detect(dir);
	const screen = vi.fn();
	// A screen is there, but stderr isn't a terminal, so it isn't used.
	const {code, stdout, stderr} = await chamoji(['setup'], dir, {
		setupScreen: screen,
	});
	expect(code).toBe(2);
	expect(screen).not.toHaveBeenCalled();
	expect(stderr).toBe(`${NO_TERMINAL}\n`);
	expect(stdout).toContain(summary(detection, recommend(detection)));
	expect(stdout).toContain(
		JSON.stringify(releaseSection(recommend(detection)), null, 2),
	);
	expect(existsSync(path.join(dir, 'chamoji.config.json'))).toBe(false);
	expect(await fetchesMemory(dir)).toBe(false);
});

test('--json without --yes reports and exits 2; with --yes it reports written steps', async () => {
	const dir = await gearz();
	const before = await chamoji(['setup', '--json'], dir);
	expect(before.code).toBe(2);
	expect(before.stderr).toBe('');
	const plan = JSON.parse(before.stdout) as Report;
	expect(results(plan)).toEqual({
		releases: 'written',
		memory: 'written',
		agents: 'skipped',
		hook: 'offered',
	});
	expect(plan.wrote).toEqual([]);
	expect(existsSync(path.join(dir, 'chamoji.config.json'))).toBe(false);
	expect(await fetchesMemory(dir)).toBe(false);

	const after = await chamoji(['setup', '--json', '--yes'], dir);
	expect(after.code).toBe(0);
	const report = JSON.parse(after.stdout) as Report;
	expect(results(report)).toEqual({
		releases: 'written',
		memory: 'written',
		agents: 'skipped',
		hook: 'offered',
	});
	expect(report.wrote).toEqual(['chamoji.config.json']);
	expect(report.answers).toEqual(await gearzSection(dir));
	expect(report.answers).toEqual((await readConfig(dir)).release);
	expect(report.why).toMatchObject({
		shape: 'detected',
		units: 'detected',
		sharedChanges: 'recommended',
	});
	expect(report.found?.units.toSorted()).toEqual(['mobile', 'web']);
	expect(report.found?.excluded).toEqual([
		'apps/dev-tool',
		'apps/e2e',
		'tooling/*',
	]);
	expect(report.found?.inheritedTags).toContain('4.0.1');
	expect(report.found?.upstream).toMatchObject({
		remote: 'upstream',
		name: 'Makerkit',
		authors: [],
	});
	expect(report.squashMerge).toBeNull();
	expect(await fetchesMemory(dir)).toBe(true);
	expect(await readHookState(dir)).toBe('missing');
});

test("a template's authors are in --json's found.upstream, the section, the summary and --explain", async () => {
	const dir = await made(
		gearzLayout({template: true, prunedBranch: 'untagged'}),
	);
	const json = await chamoji(['setup', '--json'], dir);
	expect(json.code).toBe(2);
	const report = JSON.parse(json.stdout) as Report;
	expect(report.found?.upstream.authors).toEqual([
		{email: 'bot@makerkit.dev', name: 'Makerkit Bot', commits: 32},
	]);
	expect(report.answers).toMatchObject({
		upstream: {authors: ['bot@makerkit.dev']},
	});

	const {code, stdout} = await chamoji(['setup', '--yes', '--explain'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain(
		"and commits by bot@makerkit.dev count as Makerkit's.",
	);
	expect(stdout.split('\n')).toContain(
		'release.upstream.authors = ["bot@makerkit.dev"] (detected in the repo)',
	);
});

test("--explain names each value's source", async () => {
	const dir = await gearz();
	const {code, stdout} = await chamoji(['setup', '--yes', '--explain'], dir);
	expect(code).toBe(0);
	const lines = stdout.split('\n');
	expect(lines.find(line => line.startsWith('release.upstream.since'))).toMatch(
		/ \(detected in the repo\)$/,
	);
	for (const line of [
		'release.shape = "apps" (detected in the repo)',
		'release.units.web.path = "apps/web" (detected in the repo)',
		'release.units.web.tag = "web/v{version}" (detected in the repo)',
		'release.units.mobile.buildNumber = "untouched" (recommended for apps)',
		'release.exclude = ["apps/dev-tool","apps/e2e","tooling/*"] (detected in the repo)',
		'release.sharedChanges = "ride-along" (recommended for apps)',
		'release.zeroMajor = "minor" (recommended for apps)',
		'release.upstream.name = "Makerkit" (recommended for apps)',
		'release.upstream.remote = "upstream" (detected in the repo)',
	]) {
		expect(lines).toContain(line);
	}

	// A hand-written key setup doesn't ask about is kept.
	const config = await readConfig(dir);
	await writeFile(
		path.join(dir, 'chamoji.config.json'),
		`${JSON.stringify({release: {...(config.release as object), githubReleases: 'combined'}}, null, 2)}\n`,
	);
	const again = await chamoji(['setup', '--yes', '--explain'], dir);
	expect(again.stdout.split('\n')).toEqual(
		expect.arrayContaining([
			'release.githubReleases = "combined" (kept from chamoji.config.json)',
			'release.sharedChanges = "ride-along" (kept from chamoji.config.json)',
		]),
	);
});

test('a single package: nothing to set up for releases; memory still runs', async () => {
	const dir = await withOrigin(await made(singlePackage()));
	const {code, stdout} = await chamoji(['setup', '--yes'], dir);
	expect(code).toBe(0);
	expect(stdout).toContain(`${SINGLE}\n`);
	expect(stdout).not.toContain(WROTE);
	expect(existsSync(path.join(dir, 'chamoji.config.json'))).toBe(false);
	expect(stdout).toContain('origin now fetches chamoji memory.\n');
	expect(await fetchesMemory(dir)).toBe(true);

	const json = await chamoji(['setup', 'releases', '--yes', '--json'], dir);
	const report = JSON.parse(json.stdout) as Report;
	expect(report.steps).toEqual([{step: 'releases', result: 'nothing-to-do'}]);
	// Nothing was written, so there's no section to report.
	expect(report.answers).toBeNull();
});

test("a re-run with nothing new is already up to date and shows each step's state", async () => {
	const dir = await gearz();
	await mkdir(path.join(dir, '.claude'));
	const first = await chamoji(['setup', '--yes', '--json'], dir);
	expect(first.code).toBe(0);
	const report = JSON.parse(first.stdout) as Report;
	expect(results(report).agents).toBe('written');
	expect(report.wrote).toEqual([
		'chamoji.config.json',
		'.mcp.json',
		'.claude/settings.json',
	]);
	const config = await readFile(path.join(dir, 'chamoji.config.json'), 'utf8');

	const states = (hook: string) =>
		[
			'✓ releases are set up in chamoji.config.json',
			'✓ memory sharing is on in this clone',
			'✓ Claude Code is connected here',
			hook,
			'',
			'chamoji.config.json is already up to date.',
			'',
		].join('\n');
	const noHook =
		"○ the commit composer hook isn't installed in this clone; chamoji setup hook --yes installs it";
	const again = await chamoji(['setup', '--yes'], dir);
	expect(again.stderr).toBe('');
	expect(again.code).toBe(0);
	expect(again.stdout).toBe(states(noHook));
	expect(await readFile(path.join(dir, 'chamoji.config.json'), 'utf8')).toBe(
		config,
	);
	const json = await chamoji(['setup', '--yes', '--json'], dir);
	expect(results(JSON.parse(json.stdout) as Report)).toEqual({
		releases: 'unchanged',
		memory: 'unchanged',
		agents: 'unchanged',
		hook: 'offered',
	});
	expect((JSON.parse(json.stdout) as Report).wrote).toEqual([]);

	// Without --yes, releases, memory and agents are done and the hook is
	// only offered, never assumed, so nothing would change: both exit 0
	// (rulings R15 and R17).
	const offered = await chamoji(['setup'], dir);
	expect(offered.stderr).toBe('');
	expect(offered.code).toBe(0);
	expect(offered.stdout).toBe(
		`${states(noHook)}Setup would also offer the commit composer hook for this clone.\n`,
	);
	const offeredJson = await chamoji(['setup', '--json'], dir);
	expect(offeredJson.code).toBe(0);
	expect(results(JSON.parse(offeredJson.stdout) as Report).hook).toBe(
		'offered',
	);
	expect((JSON.parse(offeredJson.stdout) as Report).wrote).toEqual([]);
	expect(await readHookState(dir)).toBe('missing');

	// Naming the hook asks for it, so without --yes that still exits 2.
	expect((await chamoji(['setup', 'hook'], dir)).code).toBe(2);
	expect((await chamoji(['setup', 'hook', '--json'], dir)).code).toBe(2);

	// Once every step is done, nothing would change: both exit 0.
	expect((await chamoji(['setup', 'hook', '--yes'], dir)).code).toBe(0);
	const settled = await chamoji(['setup'], dir);
	expect(settled.stderr).toBe('');
	expect(settled.code).toBe(0);
	expect(settled.stdout).toBe(
		states('✓ the commit composer hook is installed in this clone'),
	);
	const settledJson = await chamoji(['setup', '--json'], dir);
	expect(settledJson.code).toBe(0);
	expect(results(JSON.parse(settledJson.stdout) as Report)).toEqual({
		releases: 'unchanged',
		memory: 'unchanged',
		agents: 'unchanged',
		hook: 'unchanged',
	});
});

test("setup hook installs the hook; setup memory equals init's memory output", async () => {
	const dir = await gearz();
	const asked = await chamoji(['setup', 'hook'], dir);
	expect(asked.code).toBe(2);
	expect(asked.stderr).toBe(`${NO_TERMINAL}\n`);
	expect(await readHookState(dir)).toBe('missing');

	const hook = await chamoji(['setup', 'hook', '--yes'], dir);
	expect(hook.code).toBe(0);
	expect(hook.stdout).toContain('Installed the hook: ');
	expect(await readHookState(dir)).toBe('installed');
	const json = await chamoji(['setup', 'hook', '--yes', '--json'], dir);
	expect((JSON.parse(json.stdout) as Report).steps).toEqual([
		{step: 'hook', result: 'unchanged'},
	]);
	// An outdated chamoji hook counts as installed, and is rewritten.
	await writeFile(
		await hookPath(dir),
		'#!/bin/sh\n# chamoji: an older hook\nchamoji hook run "$@"\n',
	);
	await chmod(await hookPath(dir), 0o755);
	expect(await readHookState(dir)).toBe('installed');
	const rewritten = await chamoji(['setup', 'hook', '--yes', '--json'], dir);
	expect((JSON.parse(rewritten.stdout) as Report).steps).toEqual([
		{step: 'hook', result: 'written'},
	]);

	// The same repo twice, one set up by init and one by setup memory.
	const twin = async () =>
		withOrigin(
			await made(
				createRepo([{commit: '🎉 Start', files: {'README.md': 'hi\n'}}]),
			),
		);
	const [left, right] = [await twin(), await twin()];
	const init = await chamoji(['init'], left, {env: {CI: 'true'}});
	const memory = await chamoji(['setup', 'memory', '--yes'], right, {
		env: {CI: 'true'},
	});
	expect(memory.code).toBe(init.code);
	expect(memory.stdout).toBe(init.stdout);
	expect(memory.stdout).toContain('origin now fetches chamoji memory.');
	expect(memory.stderr).toBe(init.stderr);

	// With no origin too.
	const [bareLeft, bareRight] = [
		await made(createRepo([{commit: '🎉 Start'}])),
		await made(createRepo([{commit: '🎉 Start'}])),
	];
	const noOrigin = await chamoji(['init'], bareLeft);
	expect((await chamoji(['setup', 'memory', '--yes'], bareRight)).stdout).toBe(
		noOrigin.stdout,
	);
});

test('an unknown step exits 1', async () => {
	const dir = await made(singlePackage());
	const {code, stderr} = await chamoji(['setup', 'deploy'], dir);
	expect(code).toBe(1);
	expect(stderr).toBe(
		'chamoji: setup takes releases, memory, agents or hook, not "deploy"\n',
	);
});

test('the squash-merge check advises when squash bodies are blank or the PR description, and is silent without gh', async () => {
	const dir = await made(gearzLayout({template: true}));
	await gitOutput(dir, [
		'remote',
		'add',
		'origin',
		'https://github.com/acme/gearz.git',
	]);
	// "Pull request title": the body is blank.
	const prTitle = answering('true\tPR_TITLE\tBLANK');
	expect(await checkSquashMerge(prTitle, dir)).toBe(SQUASH_ADVICE);
	expect(prTitle.calls).toEqual([['api', 'repos/acme/gearz', ...SQUASH_QUERY]]);
	// gh is killed after 5 s, and an answer that never comes gives null.
	expect(prTitle.options).toEqual([{timeoutMs: 5000}]);
	// "Pull request title and description".
	expect(
		await checkSquashMerge(answering('true\tPR_TITLE\tPR_BODY'), dir),
	).toBe(SQUASH_ADVICE);
	expect(
		await checkSquashMerge(answering('true\tCOMMIT_OR_PR_TITLE\tBLANK'), dir),
	).toBe(SQUASH_ADVICE);
	const hanging: GhRunner = async () => new Promise(() => {});
	expect(await checkSquashMerge(hanging, dir, 50)).toBeNull();
	// "Default message" and "Pull request title and commit details" keep them.
	for (const kept of [
		'true\tCOMMIT_OR_PR_TITLE\tCOMMIT_MESSAGES',
		'true\tPR_TITLE\tCOMMIT_MESSAGES',
		'false\tPR_TITLE\tBLANK',
	]) {
		expect(await checkSquashMerge(answering(kept), dir)).toBeNull();
	}

	expect(await checkSquashMerge(noGh(), dir)).toBeNull();
	const throwing: GhRunner = async () => {
		throw new Error('boom');
	};

	expect(await checkSquashMerge(throwing, dir)).toBeNull();

	// Through setup: the report carries it, and the text run prints it.
	const json = await chamoji(['setup', '--json'], dir, {
		gh: answering('true\tPR_TITLE\tBLANK'),
	});
	expect((JSON.parse(json.stdout) as Report).squashMerge).toBe(SQUASH_ADVICE);
	// Only the releases step: memory would fetch from github.com.
	const text = await chamoji(['setup', 'releases', '--yes'], dir, {
		gh: answering('true\tPR_TITLE\tPR_BODY'),
	});
	expect(text.stdout).toContain(`${SQUASH_ADVICE}\n`);

	// No GitHub remote: gh is never asked.
	const local = await gearz();
	const gh = answering('true\tPR_TITLE\tBLANK');
	expect(await checkSquashMerge(gh, local)).toBeNull();
	expect(gh.calls).toEqual([]);
});

test('with a terminal, the screen gets the answers and its saved result is written', async () => {
	const dir = await gearz();
	asTerminal();
	const detection = await detect(dir);
	const seen: Array<Parameters<NonNullable<Io['setupScreen']>>[0]> = [];
	const saved = await chamoji(['setup'], dir, {
		async setupScreen(props) {
			seen.push(props);
			const preview = await props.preview(props.initial);
			expect(preview.heading).toBe('The next release from here would be:');
			expect(await props.replay(props.initial)).toEqual([]);
			return {
				saved: true,
				answers: {...props.initial, rootFiles: 'note'},
				steps: ['memory'],
			};
		},
	});
	expect(saved.code).toBe(0);
	expect(seen).toHaveLength(1);
	expect(seen[0]!.initial).toEqual(recommend(detection));
	expect(seen[0]!.states.map(state => state.step)).toEqual([
		'releases',
		'memory',
		'agents',
		'hook',
	]);
	expect(seen[0]!.columns).toBeGreaterThan(0);
	expect(saved.stdout).toContain(`${WROTE}\n`);
	expect((await readConfig(dir)).release).toMatchObject({rootFiles: 'note'});
	expect(await fetchesMemory(dir)).toBe(true);

	await rm(path.join(dir, 'chamoji.config.json'));
	const cancelled = await chamoji(['setup'], dir, {
		setupScreen: async () => ({saved: false}),
	});
	expect(cancelled.code).toBe(1);
	expect(cancelled.stderr).toBe('Setup cancelled; nothing was saved.\n');
	expect(existsSync(path.join(dir, 'chamoji.config.json'))).toBe(false);
});

test("a config that isn't an object gets core's error", async () => {
	const dir = await made(gearzLayout());
	await writeFile(path.join(dir, 'chamoji.config.json'), '[]\n');
	let error = '';
	try {
		writeReleaseSection('[]\n', {});
	} catch (thrown) {
		error = (thrown as Error).message;
	}

	expect(error).toBe("chamoji.config.json isn't a JSON object");
	for (const argv of [
		['setup', '--yes'],
		['setup', '--json'],
	]) {
		const {code, stdout, stderr} = await chamoji(argv, dir);
		expect(code).toBe(1);
		expect(stdout).toBe('');
		expect(stderr).toBe(`chamoji: ${error}\n`);
	}

	expect(await readFile(path.join(dir, 'chamoji.config.json'), 'utf8')).toBe(
		'[]\n',
	);
});

test.skipIf(WINDOWS)(
	'a symlinked chamoji.config.json is refused and its target left alone',
	async () => {
		const dir = await made(gearzLayout());
		const elsewhere = await mkdtemp(path.join(tmpdir(), 'chamoji-elsewhere-'));
		cleanups.push(async () => rm(elsewhere, {recursive: true, force: true}));
		const target = path.join(elsewhere, 'config.json');
		await writeFile(target, '{}\n');
		await symlink(target, path.join(dir, 'chamoji.config.json'));
		const {code, stdout, stderr} = await chamoji(['setup', '--yes'], dir);
		expect(code).toBe(1);
		expect(stdout).toBe('');
		expect(stderr).toBe(
			"chamoji: chamoji.config.json is a symlink; chamoji won't write through links\n",
		);
		expect(await readFile(target, 'utf8')).toBe('{}\n');
	},
);

test('the file is written in place of the old one, keeping its permissions', async () => {
	const dir = await made(gearzLayout());
	const file = path.join(dir, 'chamoji.config.json');
	await writeFile(file, '{"groups": []}\n');
	if (!WINDOWS) await chmod(file, 0o640);
	expect((await chamoji(['setup', 'releases', '--yes'], dir)).code).toBe(0);
	expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
		groups: [],
		release: {shape: 'apps'},
	});
	if (!WINDOWS) {
		const {stat} = await import('node:fs/promises');
		expect((await stat(file)).mode & 0o777).toBe(0o640);
	}
});

test('names and versions from the repo reach the terminal without control characters', async () => {
	// Git refuses control characters in tag and remote names, so the escape
	// rides in a manifest version, which the summary quotes.
	const escape = '\u001B[2J';
	const dir = await made(
		gearzLayout({
			extraSteps: [
				{
					commit: '🔖 Release web 0.2.0',
					files: {
						'apps/web/package.json': `${JSON.stringify({name: 'web', private: true, version: `0.1.0${escape}`}, null, 2)}\n`,
					},
				},
				{tag: 'web/v0.2.0'},
			],
		}),
	);
	for (const argv of [['setup'], ['setup', '--yes', '--explain']]) {
		const {stdout, stderr} = await chamoji(argv, dir);
		expect(stdout).toContain('apps/web/package.json says 0.1.0[2J');
		expect(`${stdout}${stderr}`).not.toContain('\u001B');
	}
});

test('setup --yes exits 2 for a release section from a newer chamoji', async () => {
	const dir = await withOrigin(await made(gearzLayout()));
	await writeFile(
		path.join(dir, 'chamoji.config.json'),
		`${JSON.stringify({release: {schema: 99, shape: 'apps'}})}\n`,
	);
	const {code, stderr} = await chamoji(['setup', '--yes'], dir);
	expect(code).toBe(2);
	expect(stderr).toContain(
		"this repo's release settings need chamoji 0.15.0 or newer",
	);
	expect(await fetchesMemory(dir)).toBe(false);
});

test("in a terminal, the squash check doesn't hold up the screen", async () => {
	const dir = await made(gearzLayout({template: true}));
	await gitOutput(dir, [
		'remote',
		'add',
		'origin',
		'https://github.com/acme/gearz.git',
	]);
	asTerminal();
	let answer: () => void = () => {};
	// gh answers only once the screen is open.
	const gh: GhRunner = async () => {
		await new Promise<void>(resolve => {
			answer = resolve;
		});
		return {ok: true, message: 'true\tPR_TITLE\tBLANK'};
	};

	const {code, stdout} = await chamoji(['setup', 'releases'], dir, {
		gh,
		async setupScreen(props) {
			answer();
			return {saved: true, answers: props.initial, steps: []};
		},
	});
	expect(code).toBe(0);
	expect(stdout).toContain(`${SQUASH_ADVICE}\n`);
});

test('in a terminal, a set-up repo with no per-clone prompt left never opens the screen (R16)', async () => {
	// No origin, so no memory step; no Claude Code, so no agents step.
	const dir = await made(gearzLayout({template: true}));
	expect((await chamoji(['setup', 'releases', '--yes'], dir)).code).toBe(0);
	expect((await chamoji(['setup', 'hook', '--yes'], dir)).code).toBe(0);
	asTerminal();
	const screen = vi.fn();
	const {code, stdout} = await chamoji(['setup'], dir, {setupScreen: screen});
	expect(screen).not.toHaveBeenCalled();
	expect(code).toBe(0);
	// With no screen, the step states are printed as before.
	expect(stdout).toContain('✓ releases are set up in chamoji.config.json\n');
	expect(stdout).toContain('chamoji.config.json is already up to date.\n');

	const solo = await made(singlePackage());
	expect((await chamoji(['setup', 'hook', '--yes'], solo)).code).toBe(0);
	const alone = await chamoji(['setup'], solo, {setupScreen: screen});
	expect(screen).not.toHaveBeenCalled();
	expect(alone.code).toBe(0);
	expect(alone.stdout).toContain(`${SINGLE}\n`);
	expect(existsSync(path.join(solo, 'chamoji.config.json'))).toBe(false);
});

test('in a terminal, a set-up repo opens the screen for the per-clone steps only', async () => {
	const dir = await gearz();
	expect((await chamoji(['setup', 'releases', '--yes'], dir)).code).toBe(0);
	asTerminal();
	const seen: SetupScreenProps[] = [];
	const {code, stdout} = await chamoji(['setup'], dir, {
		async setupScreen(props) {
			seen.push(props);
			return {saved: true, answers: props.initial, steps: ['memory']};
		},
	});
	expect(code).toBe(0);
	// The screen shows the step states itself, so they aren't printed first.
	for (const state of seen[0]!.states) expect(stdout).not.toContain(state.line);
	expect(seen).toHaveLength(1);
	expect(seen[0]!.states[0]).toMatchObject({step: 'releases', done: true});
	expect(await fetchesMemory(dir)).toBe(true);

	// Naming the step asks releases again, and only releases.
	const named: SetupScreenProps[] = [];
	await chamoji(['setup', 'releases'], dir, {
		async setupScreen(props) {
			named.push(props);
			return {saved: false};
		},
	});
	expect(named).toHaveLength(1);
	expect(named[0]!.states).toEqual([
		expect.objectContaining({step: 'releases', done: false}),
	]);
});
