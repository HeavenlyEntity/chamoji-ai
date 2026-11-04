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
import {detect, recommend, releaseSection} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {gearzLayout} from '../../core/test/helpers/setup-fixtures.js';
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
	expect(report.wrote).toEqual(['chamoji.config.json']);

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
		'?? chamoji.config.json\n',
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

/** Just enough of a terminal for Ink: keys go in on stdin, frames come out on stderr. */
class FakeStdin extends EventEmitter {
	isTTY = true;
	private data: string | null = null;
	write(data: string) {
		this.data = data;
		this.emit('readable');
		this.emit('data', data);
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

		return {...(await running), opened, screen};
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
