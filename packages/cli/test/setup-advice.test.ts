import {rm, writeFile} from 'node:fs/promises';
import {type NpmRunner} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {
	publishableLibraries,
	singlePackage,
} from '../../core/test/helpers/setup-fixtures.js';
import {run, type GhRunner, type Io} from '../src/run.js';
import {
	checkPushRules,
	neverPublished,
	NPM_LOOKUP_CONCURRENCY,
	npmSignInSteps,
	SETUP_NETWORK_TIMEOUT_MS,
} from '../src/setup/advice.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

async function repoWithOrigin(fixture?: Promise<FixtureRepo>): Promise<string> {
	const repo = await (fixture ?? singlePackage());
	cleanups.push(async () => repo.cleanup());
	await gitOutput(repo.dir, [
		'remote',
		'add',
		'origin',
		'https://github.com/acme/gearz.git',
	]);
	return repo.dir;
}

const answering = (message: string, ok = true) => {
	const calls: string[][] = [];
	const gh: GhRunner = async args => {
		calls.push(args);
		return {ok, message};
	};

	return Object.assign(gh, {calls});
};

const ADVICE =
	'main blocks direct pushes, so the release commit can\'t land. Let the GitHub Actions app bypass the ruleset, use a GitHub App token in checkout, or keep trigger "manual" for now. chamoji doesn\'t change repo settings.';

test('a pull_request rule gives the advice', async () => {
	const dir = await repoWithOrigin();
	for (const type of [
		'pull_request',
		'update',
		'required_status_checks',
		'required_deployments',
	]) {
		const gh = answering(JSON.stringify([{type: 'deletion'}, {type}]));
		// eslint-disable-next-line no-await-in-loop
		expect(await checkPushRules(gh, dir, 'main')).toBe(ADVICE);
		expect(gh.calls).toEqual([['api', 'repos/acme/gearz/rules/branches/main']]);
	}
});

test('no rules, a 404, gh missing or a timeout give null', async () => {
	const dir = await repoWithOrigin();
	expect(await checkPushRules(answering('[]'), dir, 'main')).toBeNull();
	expect(
		await checkPushRules(answering('[{"type":"deletion"}]'), dir, 'main'),
	).toBeNull();
	expect(
		await checkPushRules(
			answering('{"message":"Not Found"}', false),
			dir,
			'main',
		),
	).toBeNull();
	expect(await checkPushRules(answering('not json'), dir, 'main')).toBeNull();
	const missing = answering('no gh CLI, so no GitHub release', false);
	expect(await checkPushRules(missing, dir, 'main')).toBeNull();
	const hanging: GhRunner = async () => new Promise(() => {});
	expect(await checkPushRules(hanging, dir, 'main', 10)).toBeNull();
	const throwing: GhRunner = async () => {
		throw new Error('boom');
	};

	expect(await checkPushRules(throwing, dir, 'main')).toBeNull();
	expect(SETUP_NETWORK_TIMEOUT_MS).toBe(5000);
});

test('trusted-publisher steps name owner, repo and workflow file', () => {
	const text = npmSignInSteps({
		repo: 'acme/gearz',
		workflowFile: 'release.yml',
		ciAuth: 'oidc',
		packages: [
			{name: '@acme/ui', registry: 'https://registry.npmjs.org/'},
			{name: '@acme/core', registry: 'https://registry.npmjs.org/'},
		],
		neverPublished: [],
	});
	expect(text).toBe(
		[
			'On npmjs.com, add a trusted publisher to @acme/ui: owner acme, repository gearz, workflow release.yml.',
			'On npmjs.com, add a trusted publisher to @acme/core: owner acme, repository gearz, workflow release.yml.',
		].join('\n'),
	);
});

test('a never-published package gets the first-version note', () => {
	const text = npmSignInSteps({
		repo: 'acme/gearz',
		workflowFile: 'chamoji-release.yml',
		ciAuth: 'oidc',
		packages: [{name: '@acme/ui', registry: 'https://registry.npmjs.org/'}],
		neverPublished: ['@acme/ui'],
	});
	expect(text).toBe(
		[
			'On npmjs.com, add a trusted publisher to @acme/ui: owner acme, repository gearz, workflow chamoji-release.yml.',
			'@acme/ui has never been published; publish its first version locally with chamoji publish, then add the trusted publisher.',
		].join('\n'),
	);
});

test('a token names the secret and never a value', () => {
	const text = npmSignInSteps({
		repo: null,
		workflowFile: 'chamoji-release.yml',
		ciAuth: 'token',
		packages: [{name: 'x', registry: 'https://npm.example.com/'}],
		neverPublished: ['x'],
	});
	expect(text).toBe(
		'Create an npm granular access token with publish rights and add it as the NPM_TOKEN secret.',
	);
});

test('neverPublished lists the packages npm has no record of', async () => {
	const seen: string[][] = [];
	const timeouts: Array<number | undefined> = [];
	const npm: NpmRunner = async (args, options) => {
		seen.push(args);
		timeouts.push(options.timeoutMs);
		return args[1] === '@acme/new'
			? {ok: false, stdout: '', stderr: 'npm error code E404'}
			: {
					ok: true,
					stdout: JSON.stringify({versions: ['1.0.0'], 'dist-tags': {}}),
					stderr: '',
				};
	};

	const registry = 'https://registry.npmjs.org/';
	expect(
		await neverPublished(
			npm,
			[
				{name: '@acme/old', registry},
				{name: '@acme/new', registry},
			],
			'/',
		),
	).toEqual(['@acme/new']);
	// npm is killed by the runner, not just abandoned.
	expect(timeouts).toEqual([5000, 5000]);
	// A package npm can't answer for is left out, not guessed at.
	const broken: NpmRunner = async () => ({
		ok: false,
		stdout: '',
		stderr: 'offline',
	});
	expect(await neverPublished(broken, [{name: 'a', registry}], '/')).toEqual(
		[],
	);
});

test('neverPublished runs at most 6 npm lookups at once and still lists them all', async () => {
	let running = 0;
	let peak = 0;
	let calls = 0;
	const npm: NpmRunner = async args => {
		calls++;
		running++;
		peak = Math.max(peak, running);
		await new Promise(resolve => {
			setTimeout(resolve, 5);
		});
		running--;
		// Every third package has never been published.
		return Number(args[1]!.slice(1)) % 3 === 0
			? {ok: false, stdout: '', stderr: 'npm error code E404'}
			: {
					ok: true,
					stdout: JSON.stringify({versions: ['1.0.0'], 'dist-tags': {}}),
					stderr: '',
				};
	};

	const registry = 'https://registry.npmjs.org/';
	const packages = Array.from({length: 20}, (_, index) => ({
		name: `p${index}`,
		registry,
	}));
	expect(NPM_LOOKUP_CONCURRENCY).toBe(6);
	const found = await neverPublished(npm, packages, '/');
	expect(calls).toBe(20);
	expect(peak).toBe(6);
	expect(found).toEqual(['p0', 'p3', 'p6', 'p9', 'p12', 'p15', 'p18']);

	// Past the overall timeout, no further lookup starts.
	let started = 0;
	const slow: NpmRunner = async () => {
		started++;
		return new Promise(() => {});
	};

	expect(await neverPublished(slow, packages, '/', 50)).toBeNull();
	expect(started).toBe(6);
});

test('neverPublished returns null when npm does not answer in time', async () => {
	const hanging: NpmRunner = async () => new Promise(() => {});
	expect(
		await neverPublished(
			hanging,
			[{name: 'a', registry: 'https://registry.npmjs.org/'}],
			'/',
			10,
		),
	).toBeNull();
});

async function chamoji(argv: string[], cwd: string, extra: Partial<Io> = {}) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-11-04',
		cliVersion: '0.16.0',
		fetchTags: false,
		gh: answering('', false),
		npm: async () => ({ok: false, stdout: '', stderr: 'offline'}),
		env: {},
		...extra,
	});
	return {code, stdout, stderr};
}

const BLOCKED = answering(JSON.stringify([{type: 'pull_request'}]));

test('setup prints the push-rule line for a merge trigger, and --json carries it', async () => {
	const dir = await repoWithOrigin();
	const text = await chamoji(['setup', 'releases', '--yes'], dir, {
		gh: BLOCKED,
	});
	expect(text.stdout).toContain(`${ADVICE}\n`);
	const json = await chamoji(['setup', 'releases', '--json'], dir, {
		gh: BLOCKED,
	});
	expect((JSON.parse(json.stdout) as {advice: string[]}).advice).toContain(
		ADVICE,
	);
});

test('a manual trigger is not told about push rules', async () => {
	const dir = await repoWithOrigin();
	await chamoji(['setup', 'releases', '--yes'], dir, {gh: BLOCKED});
	await rm(`${dir}/chamoji.config.json`);
	await rm(`${dir}/.github`, {recursive: true, force: true});
	const section = {release: {schema: 2, shape: 'single', trigger: 'manual'}};
	await writeFile(`${dir}/chamoji.config.json`, JSON.stringify(section));
	const gh = answering(JSON.stringify([{type: 'pull_request'}]));
	const json = await chamoji(['setup', 'releases', '--json'], dir, {gh});
	expect((JSON.parse(json.stdout) as {advice: string[]}).advice).toEqual([]);
	// Only the squash-merge check asks; the rules never do.
	expect(gh.calls.every(args => !args[1]?.includes('/rules/'))).toBe(true);
});

test('setup of publishable libraries prints the trusted-publisher steps with the first-version note', async () => {
	const dir = await repoWithOrigin(publishableLibraries());
	const npm: NpmRunner = async args =>
		args[1] === '@acme/core'
			? {
					ok: true,
					stdout: JSON.stringify({versions: ['1.2.0'], 'dist-tags': {}}),
					stderr: '',
				}
			: {ok: false, stdout: '', stderr: 'npm error code E404'};
	const json = await chamoji(['setup', 'releases', '--yes', '--json'], dir, {
		npm,
	});
	const {advice} = JSON.parse(json.stdout) as {advice: string[]};
	expect(advice).toContain(
		'On npmjs.com, add a trusted publisher to @acme/ui: owner acme, repository gearz, workflow chamoji-release.yml.',
	);
	expect(advice).toContain(
		'On npmjs.com, add a trusted publisher to @acme/core: owner acme, repository gearz, workflow chamoji-release.yml.',
	);
	expect(advice).toContain(
		'@acme/ui has never been published; publish its first version locally with chamoji publish, then add the trusted publisher.',
	);
	expect(advice.some(line => line.startsWith('@acme/core has never'))).toBe(
		false,
	);
});

test('with no gh and no network, setup still writes, exits 0 and prints no advice lines', async () => {
	const dir = await repoWithOrigin(publishableLibraries());
	const {code, stdout} = await chamoji(['setup', 'releases', '--yes'], dir, {
		npm: async () => {
			throw new Error('offline');
		},
	});
	expect(code).toBe(0);
	expect(stdout).toContain('Wrote chamoji.config.json');
	expect(stdout).not.toContain('never been published');
	expect(stdout).not.toContain('blocks direct pushes');
	// The trusted-publisher lines still come: they need no lookup.
	expect(stdout).toContain('add a trusted publisher to @acme/ui');
});
