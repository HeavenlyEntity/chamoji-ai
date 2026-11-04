import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	detect,
	fetchesMemory,
	recommend,
	releaseSection,
	summary,
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
import {readHookState} from '../src/hook.js';
import {run, type GhRunner, type Io} from '../src/run.js';
import {checkSquashMerge} from '../src/setup/setup.js';

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
	'Squash merges here keep only the PR title, which drops Release:, Workstream: and intent-card trailers. In the repo\'s Settings → General → Pull Requests, set "Default commit message" for squash merges to "Pull request title and description".';
const SQUASH_QUERY = [
	'--jq',
	'[.allow_squash_merge, .squash_merge_commit_message] | @tsv',
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
		upstream: {remote: 'upstream', name: 'Makerkit', since},
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
		upstream: {remote: string | null; name: string | null};
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
	});
	expect(report.squashMerge).toBeNull();
	expect(await fetchesMemory(dir)).toBe(true);
	expect(await readHookState(dir)).toBe('missing');
});

test("--explain names each value's source", async () => {
	const dir = await gearz();
	const {code, stdout} = await chamoji(['setup', '--yes', '--explain'], dir);
	expect(code).toBe(0);
	const lines = stdout.split('\n');
	for (const line of [
		'release.shape = "apps" (detected in the repo)',
		'release.units.web.path = "apps/web" (detected in the repo)',
		'release.units.web.tag = "web/v{version}" (detected in the repo)',
		'release.units.mobile.buildNumber = "untouched" (recommended for apps)',
		'release.exclude = ["apps/dev-tool","apps/e2e","tooling/*"] (detected in the repo)',
		'release.sharedChanges = "ride-along" (recommended for apps)',
		'release.zeroMajor = "minor" (recommended for apps)',
		'release.upstream.name = "Makerkit" (recommended for apps)',
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
	expect((JSON.parse(json.stdout) as Report).steps).toEqual([
		{step: 'releases', result: 'nothing-to-do'},
	]);
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

	const states = [
		'✓ releases are set up in chamoji.config.json',
		'✓ memory sharing is on in this clone',
		'✓ Claude Code is connected here',
		"○ the commit composer hook isn't installed in this clone; chamoji setup hook installs it",
		'',
		'chamoji.config.json is already up to date.',
		'',
	].join('\n');
	for (const argv of [['setup', '--yes'], ['setup']]) {
		const again = await chamoji(argv, dir);
		expect(again.stderr).toBe('');
		expect(again.code).toBe(0);
		expect(again.stdout).toBe(states);
	}

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

	// The same repo twice, one set up by init and one by setup memory.
	const twin = async () =>
		withOrigin(
			await made(
				createRepo([{commit: '🎉 Start', files: {'README.md': 'hi\n'}}]),
			),
		);
	const [left, right] = [await twin(), await twin()];
	const init = await chamoji(['init'], left);
	const memory = await chamoji(['setup', 'memory', '--yes'], right);
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

test('the squash-merge check advises only for PR_TITLE squashes, and is silent without gh', async () => {
	const dir = await made(gearzLayout({template: true}));
	await gitOutput(dir, [
		'remote',
		'add',
		'origin',
		'https://github.com/acme/gearz.git',
	]);
	const answering = (message: string): GhRunner & {calls: string[][]} => {
		const calls: string[][] = [];
		return Object.assign(
			async (args: string[]) => {
				calls.push(args);
				return {ok: true, message};
			},
			{calls},
		);
	};

	const prTitle = answering('true\tPR_TITLE');
	expect(await checkSquashMerge(prTitle, dir)).toBe(SQUASH_ADVICE);
	expect(prTitle.calls).toEqual([['api', 'repos/acme/gearz', ...SQUASH_QUERY]]);
	expect(
		await checkSquashMerge(answering('true\tCOMMIT_MESSAGES'), dir),
	).toBeNull();
	expect(await checkSquashMerge(answering('false\tPR_TITLE'), dir)).toBeNull();
	expect(await checkSquashMerge(noGh(), dir)).toBeNull();
	const throwing: GhRunner = async () => {
		throw new Error('boom');
	};

	expect(await checkSquashMerge(throwing, dir)).toBeNull();

	// Through setup: the report carries it, and the text run prints it.
	const json = await chamoji(['setup', '--json'], dir, {
		gh: answering('true\tPR_TITLE'),
	});
	expect((JSON.parse(json.stdout) as Report).squashMerge).toBe(SQUASH_ADVICE);
	// Only the releases step: memory would fetch from github.com.
	const text = await chamoji(['setup', 'releases', '--yes'], dir, {
		gh: answering('true\tPR_TITLE'),
	});
	expect(text.stdout).toContain(`${SQUASH_ADVICE}\n`);

	// No GitHub remote: gh is never asked.
	const local = await gearz();
	const gh = answering('true\tPR_TITLE');
	expect(await checkSquashMerge(gh, local)).toBeNull();
	expect(gh.calls).toEqual([]);
});

test('with a terminal, the screen gets the answers and its saved result is written', async () => {
	const dir = await gearz();
	// Stderr is a terminal for this test.
	const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
	Object.defineProperty(process.stderr, 'isTTY', {
		value: true,
		configurable: true,
	});
	cleanups.push(async () => {
		if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
		else delete (process.stderr as {isTTY?: boolean}).isTTY;
	});
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
