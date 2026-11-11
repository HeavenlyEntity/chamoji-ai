/**
 * The spec's setup exit criterion, end to end through `run`: on a copy of
 * gearz-deploy-40's layout (a Makerkit fork with one real sync), setup finds
 * the units, leaves the template out and writes a section the release engine
 * takes as it is.
 */
import {EventEmitter} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {existsSync} from 'node:fs';
import {
	detect,
	questions,
	recommend,
	releaseSection,
	type NpmRunner,
} from '@chamoji/core';
import {afterEach, describe, expect, test} from 'vitest';
import {
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {
	acpSingle,
	appsAndLibraries,
	gearzLayout,
	suiteAppMonorepo,
	templatedSuiteApp,
} from '../../core/test/helpers/setup-fixtures.js';
import {has} from './helpers/release-publish.js';
import {readHookState} from '../src/hook.js';
import {run, type GhRunner, type Io} from '../src/run.js';
import {runSetupScreen} from '../src/setup/screen.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

/** The template's tags: three from the clone and 4.0.3 from the sync. */
const MAKERKIT_TAGS = ['4.0.1', '4.0.2', '4.0.3', 'v4.0.2-1'];
const SYNC_LINE = 'Updated the Makerkit base to 4.0.3';
const ENTER = '\r';

const noGh: GhRunner = async () => ({ok: false, message: 'no gh CLI'});

async function chamoji(argv: string[], cwd: string, extra: Partial<Io> = {}) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
		today: '2026-11-04',
		fetchTags: false,
		gh: noGh,
		// Never the real registry.
		npm: async () => ({ok: false, stdout: '', stderr: 'offline'}),
		// No PATH: claude is never "installed", whatever this machine has.
		env: {},
		...extra,
	});
	return {code, stdout, stderr};
}

/** gearz forked from the Makerkit template, after one real sync bringing 4.0.3. */
async function gearz(): Promise<string> {
	const repo: FixtureRepo = await gearzLayout({template: true, sync: true});
	cleanups.push(async () => repo.cleanup());
	return repo.dir;
}

const readRelease = async (dir: string) =>
	(
		JSON.parse(
			await readFile(path.join(dir, 'chamoji.config.json'), 'utf8'),
		) as {
			release: {
				units: Record<string, unknown>;
				exclude: string[];
				tags: {ignore: string[]};
			};
		}
	).release;

async function commitAll(dir: string, message: string): Promise<void> {
	await gitOutput(dir, ['add', '-A']);
	await gitOutput(dir, [
		'-c',
		'user.name=Gearz Dev',
		'-c',
		'user.email=dev@gearz.example',
		'commit',
		'-q',
		'-m',
		message,
	]);
}

type DryRun = {
	units: Array<{
		unit: string;
		tag: string;
		lastTag: string | null;
		notes: string;
		files: string[];
	}>;
	warnings: string[];
};

test('setup --yes finds web and mobile, excludes e2e, dev-tool and tooling, ignores the Makerkit tags, and release --dry-run accepts it', async () => {
	const dir = await gearz();
	const setup = await chamoji(['setup', '--yes', '--json'], dir);
	expect(setup.stderr).toBe('');
	expect(setup.code).toBe(0);
	const report = JSON.parse(setup.stdout) as {
		found: {
			kind: string;
			units: string[];
			excluded: string[];
			inheritedTags: string[];
		};
		wrote: string[];
	};
	expect(report.found.kind).toBe('apps');
	expect(new Set(report.found.units)).toEqual(new Set(['web', 'mobile']));
	expect(new Set(report.found.excluded)).toEqual(
		new Set(['apps/e2e', 'apps/dev-tool', 'tooling/*']),
	);
	expect([...report.found.inheritedTags].sort()).toEqual(MAKERKIT_TAGS);
	// The recommended privatize tick marks the public mobile app (T5-d).
	expect(report.wrote).toEqual([
		'chamoji.config.json',
		'apps/mobile/package.json',
	]);

	const release = await readRelease(dir);
	expect(Object.keys(release.units).sort()).toEqual(['mobile', 'web']);
	expect(release.exclude).toEqual(['apps/dev-tool', 'apps/e2e', 'tooling/*']);
	// Every Makerkit tag and the stray wip tag are ignored; the units' own
	// tag formats are not.
	const ignored = (tag: string) =>
		release.tags.ignore.some(pattern => new RegExp(pattern).test(tag));
	for (const tag of [...MAKERKIT_TAGS, 'wip/crm-pipeline-stages']) {
		expect(ignored(tag), tag).toBe(true);
	}

	for (const tag of ['web/v0.1.0', 'mobile/v1.0.0']) {
		expect(ignored(tag), tag).toBe(false);
	}

	// Setup never commits; the developer does.
	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe(
		' M apps/mobile/package.json\n?? chamoji.config.json\n',
	);
	await commitAll(dir, '🔧 Set up releases');
	// web has the sync to release; mobile gets a feature of its own.
	await writeFile(path.join(dir, 'apps/mobile/camera.ts'), 'camera\n');
	await commitAll(dir, '✨ Add the camera');

	const dry = await chamoji(
		['release', '--dry-run', '--json', '--any-branch'],
		dir,
	);
	expect(dry.stderr).toBe('');
	expect(dry.code).toBe(0);
	const plan = JSON.parse(dry.stdout) as DryRun;
	// Both apps release for the first time, at their manifest versions: no
	// Makerkit tag reads as a release of theirs.
	const byUnit = Object.fromEntries(plan.units.map(unit => [unit.unit, unit]));
	expect(Object.keys(byUnit).sort()).toEqual(['mobile', 'web']);
	expect(byUnit.web).toMatchObject({tag: 'web/v0.1.0', lastTag: null});
	expect(byUnit.mobile).toMatchObject({tag: 'mobile/v1.0.0', lastTag: null});
	expect(byUnit.mobile!.files).toContain('apps/mobile/app.config.ts');
	expect(plan.warnings).toEqual([]);
});

/**
 * Just enough of a terminal for Ink: keys go in on stdin, frames come out on
 * stderr. Like a real stream, a key written before anyone listens waits, and
 * is announced when a reader comes.
 */
class FakeStdin extends EventEmitter {
	isTTY = true;
	private data: string | null = null;
	write(data: string) {
		this.data = data;
		this.emit('readable');
		this.emit('data', data);
	}

	override addListener(
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	): this {
		super.addListener(event, listener);
		if (event === 'readable' && this.data !== null) {
			setImmediate(() => this.emit('readable'));
		}

		return this;
	}

	read = () => {
		const {data} = this;
		this.data = null;
		return data;
	};

	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
}

class FakeStderr extends EventEmitter {
	isTTY = true;
	columns = 120;
	rows = 60;
	written = '';
	write = (text: string) => {
		this.written += text;
		return true;
	};
}

const sleep = async (ms: number) =>
	new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the screen has drawn `text`, failing after five seconds. */
async function drawn(stderr: FakeStderr, text: string): Promise<void> {
	for (let waited = 0; waited < 5000; waited += 20) {
		if (
			stripVTControlCharacters(stderr.written)
				.replaceAll(/\s+/g, ' ')
				.includes(text)
		) {
			return;
		}

		await sleep(20);
	}

	throw new Error(`the screen never drew "${text}":\n${stderr.written}`);
}

/**
 * `chamoji setup …` with stderr a terminal and the real setup screen on a
 * fake one. Each key is pressed once the screen has drawn its `when`.
 */
async function interactive(
	dir: string,
	argv: string[],
	steps: Array<{when: string; key: string}>,
	/** Typed as the screen opens, before it first draws. */
	early?: string,
) {
	const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
	Object.defineProperty(process.stderr, 'isTTY', {
		value: true,
		configurable: true,
	});
	const stdin = new FakeStdin();
	const screen = new FakeStderr();
	let opened = 0;
	try {
		const running = chamoji(argv, dir, {
			async setupScreen(props) {
				opened++;
				if (early !== undefined) stdin.write(early);
				return runSetupScreen(props, {
					stdin: stdin as unknown as NodeJS.ReadStream,
					stdout: screen as unknown as NodeJS.WriteStream,
				});
			},
		});
		for (const {when, key} of steps) {
			await drawn(screen, when);
			stdin.write(key);
		}

		// A key the screen missed would leave it open: close it after a while,
		// so the test fails on what was (not) saved instead of hanging.
		const closer = setTimeout(() => stdin.write('\u0003'), 5000);
		try {
			return {...(await running), opened, screen};
		} finally {
			clearTimeout(closer);
		}
	} finally {
		if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
		else delete (process.stderr as {isTTY?: boolean}).isTTY;
	}
}

test('interactive setup reaches a saved config with one Enter', async () => {
	const dir = await gearz();
	const recommended = releaseSection(recommend(await detect(dir)));

	// Releases is the only step asked, and Enter on the summary takes every
	// answer as shown: one key in all.
	const result = await interactive(
		dir,
		['setup', 'releases'],
		[{when: 'Enter save · c change', key: ENTER}],
	);
	expect(result.stderr).toBe('');
	expect(result.code).toBe(0);
	expect(result.opened).toBe(1);
	expect(result.stdout).toContain('Wrote chamoji.config.json.');
	expect(await readRelease(dir)).toEqual(recommended);
	// What one Enter saved is what --yes would write.
	const again = await chamoji(['setup', 'releases', '--yes', '--json'], dir);
	expect(again.code).toBe(0);
	expect((JSON.parse(again.stdout) as {steps: unknown}).steps).toEqual([
		{step: 'releases', result: 'unchanged'},
	]);
});

test('an Enter pressed before the screen first draws, read as a newline, still saves', async () => {
	const dir = await gearz();
	const recommended = releaseSection(recommend(await detect(dir)));
	// Before raw mode the terminal turns Enter into a newline.
	const result = await interactive(dir, ['setup', 'releases'], [], '\n');
	expect(result.stderr).toBe('');
	expect(result.code).toBe(0);
	expect(result.stdout).toContain('Wrote chamoji.config.json.');
	expect(await readRelease(dir)).toEqual(recommended);
});

test('in a fresh clone, plain setup asks about the hook after the Enter, and Enter there declines it', async () => {
	const dir = await gearz();
	const result = await interactive(
		dir,
		['setup'],
		[
			{when: 'Enter save · c change', key: ENTER},
			{when: 'Install the commit composer hook?', key: ENTER},
		],
	);
	expect(result.stderr).toBe('');
	expect(result.code).toBe(0);
	expect(result.stdout).toContain('Wrote chamoji.config.json.');
	expect(await readRelease(dir)).toEqual(
		releaseSection(recommend(await detect(dir))),
	);
	// The hook is offered, never assumed.
	expect(await readHookState(dir)).toBe('missing');
});

test("after setup, web's first release leaves the template out and shows the sync as one line", async () => {
	const dir = await gearz();
	expect((await chamoji(['setup', '--yes'], dir)).code).toBe(0);
	await commitAll(dir, '🔧 Set up releases');
	await writeFile(path.join(dir, 'apps/web/dashboard.ts'), 'dashboard\n');
	await commitAll(dir, '✨ Add the dashboard');

	const dry = await chamoji(
		['release', '--dry-run', '--json', '--any-branch', '--unit', 'web'],
		dir,
	);
	expect(dry.stderr).toBe('');
	expect(dry.code).toBe(0);
	const web = (JSON.parse(dry.stdout) as DryRun).units.find(
		unit => unit.unit === 'web',
	)!;
	expect(web.lastTag).toBeNull();
	expect(web.notes).toContain('Add the dashboard');
	// None of the template's 33 commits, and the sync once.
	expect(web.notes).not.toContain('Update the kit');
	expect(web.notes).not.toContain('Merge upstream');
	expect(web.notes.split(SYNC_LINE)).toHaveLength(2);
});

/** The merge workflow is written only when the CLI knows its own version. */
const WITH_VERSION: Partial<Io> = {cliVersion: '0.16.0'};
const WORKFLOW = '.github/workflows/chamoji-release.yml';

type Found = {
	path: string;
	name: string;
	kind: string;
	reasons: string[];
	framework: {id: string; name: string; version: string | null} | null;
};
type SetupReport = {
	found: {kind: string; units: string[]; packages: Found[]};
	answers: {
		shape: string;
		trigger: string;
		publish?: unknown;
		units?: Record<
			string,
			{path: string; versionFiles?: string[]; firstVersion?: string}
		>;
	};
	wrote: string[];
};

/** A repo from a fixture, cleaned up after the test. */
async function made(make: () => Promise<FixtureRepo>): Promise<string> {
	const repo = await make();
	cleanups.push(async () => repo.cleanup());
	return repo.dir;
}

const readJson = async (dir: string, file: string) =>
	JSON.parse(await readFile(path.join(dir, file), 'utf8')) as {
		private?: boolean;
		version?: string;
		release?: unknown;
	};

test('suiteAppMonorepo: backend and web are app units, nothing is offered for npm', async () => {
	const dir = await made(suiteAppMonorepo);
	const setup = await chamoji(['setup', '--yes', '--json'], dir, WITH_VERSION);
	expect(setup.stderr).toBe('');
	expect(setup.code).toBe(0);
	const report = JSON.parse(setup.stdout) as SetupReport;
	expect(report.found.kind).toBe('apps');
	const byName = Object.fromEntries(
		report.found.packages.map(pkg => [pkg.name, pkg]),
	);
	expect(byName.backend).toMatchObject({
		path: 'apps/backend',
		kind: 'app',
		reasons: ['NetSuite SuiteApp (`apps/backend/src/manifest.xml`)'],
		framework: {id: 'netsuite-suiteapp', name: 'NetSuite SuiteApp'},
	});
	expect(byName.web).toMatchObject({
		kind: 'app',
		framework: {id: 'next', name: 'Next.js'},
	});
	expect(report.found.units).toEqual(['backend', 'web']);
	// Apps are never offered for npm: no publish answer, in the report or the file.
	expect(report.answers.publish).toBeUndefined();
	expect(
		'publish' in ((await readJson(dir, 'chamoji.config.json')).release as {}),
	).toBe(false);
	// The merge workflow (T6-a) and the privatize tick (T5-d) are written too,
	// and the release engine finds the SuiteApp's manifest.xml.
	expect(report.wrote).toEqual([
		'chamoji.config.json',
		WORKFLOW,
		'apps/backend/package.json',
	]);
	expect(report.answers.units?.backend?.versionFiles).toEqual([
		'apps/backend/src/manifest.xml',
	]);
	expect((await readJson(dir, 'apps/backend/package.json')).private).toBe(true);
	// The text view names the NetSuite project with its id and version.
	const text = await chamoji(
		['setup', '--yes'],
		await made(suiteAppMonorepo),
		WITH_VERSION,
	);
	expect(text.stdout).toContain(
		'backend (NetSuite SuiteApp · com.example.myapp 2.10.34)',
	);
});

test('suiteAppMonorepo: setup points out 2.5.20 versus 2.10.34', async () => {
	const dir = await made(suiteAppMonorepo);
	const detection = await detect(dir);
	const asked = questions(detection, recommend(detection));
	const first = asked.find(question => question.id === 'firstVersion:backend');
	expect(first?.title).toBe(
		'backend is 2.10.34 in manifest.xml but 2.5.20 in package.json; which is current?',
	);
	// The manifest is offered first, and --yes starts there.
	expect(first?.options).toMatchObject([
		{value: '2.10.34', recommended: true},
		{value: '2.5.20'},
	]);
	const setup = await chamoji(['setup', '--yes', '--json'], dir);
	expect(
		(JSON.parse(setup.stdout) as SetupReport).answers.units?.backend,
	).toMatchObject({firstVersion: '2.10.34'});
});

test('templatedSuiteApp: setup finds apps/suiteapp with no package.json', async () => {
	const dir = await made(templatedSuiteApp);
	const setup = await chamoji(['setup', '--yes', '--json'], dir, WITH_VERSION);
	expect(setup.stderr).toBe('');
	expect(setup.code).toBe(0);
	const report = JSON.parse(setup.stdout) as SetupReport;
	expect(report.found.units).toEqual(['suiteapp']);
	expect(report.found.packages).toMatchObject([
		{
			path: 'apps/suiteapp',
			kind: 'app',
			reasons: ['NetSuite SuiteApp (`apps/suiteapp/template/manifest.xml`)'],
			framework: {id: 'netsuite-suiteapp', version: '0.1.0'},
		},
	]);
	// The tracked template is the version file, not the git-ignored src/.
	expect(report.answers.units?.suiteapp?.versionFiles).toEqual([
		'apps/suiteapp/template/manifest.xml',
	]);
	// With no package.json there is nothing to privatize, and none is made.
	expect(report.wrote).toEqual(['chamoji.config.json', WORKFLOW]);
	expect(existsSync(path.join(dir, 'apps/suiteapp/package.json'))).toBe(false);
});

test('acpSingle: shown as an Account Customization Project, first release asks for a version', async () => {
	const dir = await made(acpSingle);
	const setup = await chamoji(['setup', '--yes'], dir, WITH_VERSION);
	expect(setup.code).toBe(0);
	expect(setup.stdout).toContain(
		'Found a single NetSuite Account Customization Project',
	);
	await commitAll(dir, '🔧 Set up releases');
	await writeFile(path.join(dir, 'src/script.js'), 'script\n');
	await commitAll(dir, '✨ Add a script');
	// An ACP has no version of its own: the first release is told, not guessed.
	const first = await chamoji(['release', '--json', '--any-branch'], dir);
	expect(first.code).toBe(2);
	expect(first.stderr).toContain('give the version');
	const given = await chamoji(
		['release', '1.0.0', '--json', '--any-branch'],
		dir,
	);
	expect(given.code).toBe(0);
	const released = JSON.parse(given.stdout) as {
		units?: unknown;
		files: string[];
	};
	expect(released.files).toEqual(['CHANGELOG.md']);
	expect(await gitOutput(dir, ['tag', '--list'])).toBe('v1.0.0\n');
	// From then on the version comes from the tag.
	await writeFile(path.join(dir, 'src/more.js'), 'more\n');
	await commitAll(dir, '✨ Add more');
	const next = await chamoji(['release', '--json', '--any-branch'], dir);
	expect(next.code).toBe(0);
	expect(await gitOutput(dir, ['tag', '--list', '--sort=v:refname'])).toBe(
		'v1.0.0\nv1.1.0\n',
	);
});

describe('Next.js at the root, Expo under packages/ and a Vite app, none private', () => {
	test('setup finds apps with reasons and libraries with theirs', async () => {
		const dir = await made(appsAndLibraries);
		const setup = await chamoji(['setup', '--yes', '--json'], dir);
		expect(setup.stderr).toBe('');
		expect(setup.code).toBe(0);
		const report = JSON.parse(setup.stdout) as SetupReport;
		const byName = Object.fromEntries(
			report.found.packages.map(pkg => [pkg.name, pkg]),
		);
		expect(byName.mobile).toMatchObject({
			kind: 'app',
			reasons: expect.arrayContaining(['`expo` in dependencies']),
			framework: {name: 'Expo'},
		});
		expect(byName.site).toMatchObject({
			kind: 'app',
			reasons: ['`vite` in devDependencies', '`index.html`'],
			framework: {name: 'Vite'},
		});
		// An Expo module and a React library with react as a peer are libraries.
		expect(byName.camera).toMatchObject({
			kind: 'library',
			reasons: ['`expo-module.config.json`'],
		});
		expect(byName.ui).toMatchObject({
			kind: 'library',
			reasons: ['`exports` field'],
			framework: null,
		});
		// Only the apps are units, and the public ones are marked private.
		expect(report.found.units).toEqual(['mobile', 'site']);
		expect(report.wrote).toEqual([
			'chamoji.config.json',
			'packages/mobile/package.json',
			'packages/site/package.json',
		]);
		expect((await readJson(dir, 'packages/mobile/package.json')).private).toBe(
			true,
		);
		expect(
			(await readJson(dir, 'packages/camera/package.json')).private,
		).toBeUndefined();
	});

	/** A fake npm that records what it is asked, and never publishes. */
	const recorder = () => {
		const calls: string[][] = [];
		const npm: NpmRunner = async args => {
			calls.push(args);
			if (args[0] === '--version') {
				return {ok: true, stdout: '11.6.0', stderr: ''};
			}

			return {ok: false, stdout: '', stderr: 'npm error code E404'};
		};

		return {npm, calls};
	};

	test.skipIf(!has('npm'))(
		'publish names only the libraries, and skips every app with its reason',
		async () => {
			const dir = await made(appsAndLibraries);
			await gitOutput(dir, ['tag', 'v1.0.0']);
			const fake = recorder();
			const result = await chamoji(['publish', '--dry-run'], dir, {
				npm: fake.npm,
			});
			expect(result.code).toBe(0);
			expect(result.stdout).toBe(
				'@shop/camera 1.0.0 → latest: would publish\n@shop/ui 1.0.0 → latest: would publish\n',
			);
			expect(result.stderr).toContain('skipped shop: Next.js app');
			expect(result.stderr).toContain('skipped @shop/mobile: Expo app');
			expect(result.stderr).toContain('skipped @shop/site: Vite app');
			// No app is even looked up on the registry.
			const looked = fake.calls
				.filter(call => call[0] === 'view')
				.map(call => call[1]);
			expect(looked).toEqual(['@shop/camera', '@shop/ui']);
		},
	);

	test('publishing an app stops before any tag, and nothing is published', async () => {
		const dir = await made(appsAndLibraries);
		await writeFile(
			path.join(dir, 'chamoji.config.json'),
			JSON.stringify({
				release: {
					schema: 2,
					shape: 'apps',
					units: {mobile: {path: 'packages/mobile'}},
				},
			}),
		);
		await commitAll(dir, '🔧 Set up releases');
		await gitOutput(dir, ['tag', 'mobile/v1.0.0']);
		const fake = recorder();
		const result = await chamoji(['publish', '--from', 'mobile/v1.0.0'], dir, {
			npm: fake.npm,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('packages/mobile looks like a Expo app');
		expect(result.stderr).toContain("apps aren't published");
		expect(fake.calls.filter(call => call[0] === 'publish')).toEqual([]);
		// No release commit or tag came of it.
		expect(await gitOutput(dir, ['tag', '--list'])).toBe('mobile/v1.0.0\n');
	});
});

test('chamoji publish refuses a SuiteApp package: nothing NetSuite is offered for npm', async () => {
	const dir = await made(suiteAppMonorepo);
	await chamoji(['setup', '--yes'], dir);
	// Whatever the package.json says, a SuiteApp is an app.
	await writeFile(
		path.join(dir, 'apps/backend/package.json'),
		JSON.stringify({
			name: '@example/backend',
			version: '2.10.34',
			main: 'x.js',
		}),
	);
	await commitAll(dir, '🔧 Set up releases');
	await gitOutput(dir, ['tag', 'backend/v2.10.34']);
	const result = await chamoji(['publish', '--from', 'backend/v2.10.34'], dir, {
		npm: async args =>
			args[0] === '--version'
				? {ok: true, stdout: '11.6.0', stderr: ''}
				: {ok: false, stdout: '', stderr: 'npm error code E404'},
	});
	expect(result.code).toBe(2);
	expect(result.stderr).toContain('NetSuite SuiteApp');
	expect(result.stderr).toContain("apps aren't published");
});
