import {execFile, execFileSync} from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type RepoStep,
} from '../packages/core/test/helpers/fixture-repo.js';
import {
	assertFullHistory,
	locateSample,
	measureFileHistory,
	measureGrowth,
	measureMcpTools,
	measureWhatStands,
	measureWhy,
	releaseTags,
	sampleCandidates,
} from './lib/memory-measure.mjs';
import {
	estimateTokens,
	NO_LINES_MEASURED,
	pickSample,
	renderLive,
	renderTables,
	sectionBody,
	switchFigures,
} from './lib/memory-tokens.mjs';

const LIVE_HEADING = '## What real sessions spent';
const REPLAY_HEADING = '## The replay: reading everything';
const UNCUT = 20_000;

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const runner = path.join(root, 'scripts/memory-benchmark.mjs');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function repo(steps: RepoStep[]): Promise<string> {
	const fixture = await createRepo(steps);
	cleanups.push(async () => fixture.cleanup());
	return fixture.dir;
}

const head = async (dir: string) =>
	(await gitOutput(dir, ['rev-parse', 'HEAD'])).trim();

const chamoji = (dir: string, args: string[]) =>
	execFileSync(process.execPath, [cli, ...args, '--no-update-check'], {
		cwd: dir,
		encoding: 'utf8',
	});

const lines = (count: number, prefix = 'line') =>
	Array.from({length: count}, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

test('what stands: the brief, the log and a notes file are measured, and the notes file has one line per card line', async () => {
	const dir = await repo([
		{
			commit: '✨ Add the parser',
			body: 'Why: the old one choked on tabs\nConstraint: keep it streaming\nGotcha: tabs count as one column',
			files: {'parser.txt': lines(3)},
		},
		{
			commit: '🐛 Fix the reader',
			body: 'Why: it read past the end\nFollow-up: test empty input',
			files: {'reader.txt': lines(2)},
		},
		{commit: '📝 Say more', files: {'readme.txt': 'hello\n'}},
	]);

	const result = measureWhatStands(dir, cli, UNCUT);

	const brief = chamoji(dir, ['memory', 'brief']);
	const log = await gitOutput(dir, ['log', '--no-color']);
	const notes = [
		'Constraint: keep it streaming',
		'Gotcha: tabs count as one column',
		'Follow-up: test empty input',
	].join('\n');
	expect(result.brief).toEqual({
		chars: brief.length,
		tokens: estimateTokens(brief),
	});
	expect(result.log).toEqual({chars: log.length, tokens: estimateTokens(log)});
	expect(result.notesFile).toEqual({
		chars: notes.length,
		tokens: estimateTokens(notes),
	});
	expect(result.cardLines).toBe(3);
	expect(result.briefLines).toBe(3);
	expect(result.openLines).toBe(3);
	expect(result.commits).toBe(3);
});

test('what stands counts the lines the default brief lists, which its budget can cut, and measures the brief uncut', async () => {
	const reason = 'the reason is long enough to fill the budget '.repeat(3);
	const dir = await repo([
		{
			commit: '✨ Add the rules',
			body: [
				'Why: many rules',
				...Array.from(
					{length: 40},
					(_, i) => `Constraint: rule ${i + 1} holds because ${reason}`,
				),
			].join('\n'),
			files: {'a.txt': 'a\n'},
		},
	]);

	const result = measureWhatStands(dir, cli, UNCUT);

	const uncut = chamoji(dir, ['memory', 'brief', '--budget', String(UNCUT)]);
	expect(result.cardLines).toBe(40);
	expect(result.briefLines).toBeGreaterThan(0);
	expect(result.briefLines).toBeLessThan(40);
	expect(result.briefUncut).toEqual({
		chars: uncut.length,
		tokens: estimateTokens(uncut),
		lines: 40,
	});
	expect(result.briefUncut.tokens).toBeGreaterThan(result.brief.tokens);
});

test('the MCP tool definitions are measured from the tools/list reply of chamoji mcp, and the server has exited', async () => {
	const dir = await repo([{commit: '🎉 Start', files: {'a.txt': 'a\n'}}]);
	const reply = execFileSync(
		process.execPath,
		[cli, 'mcp', '--no-update-check'],
		{
			cwd: dir,
			encoding: 'utf8',
			input: [
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {protocolVersion: '2025-11-25', capabilities: {}},
				}),
				JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
				'',
			].join('\n'),
		},
	);
	const list = reply
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.find(message => message.id === 2);
	const tools = JSON.stringify(list.result.tools);

	expect(list.result.tools.length).toBeGreaterThan(0);
	expect(measureMcpTools(dir, cli)).toEqual({
		chars: tools.length,
		tokens: estimateTokens(tools),
	});
});

test('a line whose commit has no card is never a sample candidate', async () => {
	const dir = await repo([
		{
			commit: '✨ Add a',
			body: 'Why: the app needs an a',
			files: {'a.txt': lines(2)},
		},
		{commit: '✨ Add b', files: {'b.txt': lines(2)}},
	]);
	const plain = await head(dir);

	const candidates = sampleCandidates(dir, cli);

	expect(candidates.map(candidate => candidate.file)).toEqual(['a.txt']);
	expect(candidates.some(candidate => candidate.commit === plain)).toBe(false);
});

test('one candidate per commit, the first surviving line by path then line', async () => {
	const dir = await repo([
		{
			commit: '✨ Add a and b',
			body: 'Why: both are needed',
			files: {'b.txt': 'b1\nb2\n', 'a.txt': 'a1\na2\na3\n'},
		},
		{
			commit: '✨ Rewrite the first line of a',
			body: 'Why: a1 was wrong',
			files: {'a.txt': 'new a1\na2\na3\n'},
		},
		{
			commit: '✨ Add c',
			body: 'Why: c is needed',
			files: {'c.txt': 'c1\n'},
		},
		{commit: '🔥 Replace c', files: {'c.txt': 'other\n'}},
	]);
	const [replaced, cAdded, rewrite, first] = (
		await gitOutput(dir, ['rev-list', 'HEAD'])
	)
		.trim()
		.split('\n');

	const candidates = sampleCandidates(dir, cli);

	expect(candidates).toHaveLength(2);
	expect(candidates).toContainEqual({
		commit: first,
		file: 'a.txt',
		line: 2,
		text: 'a2',
	});
	expect(candidates).toContainEqual({
		commit: rewrite,
		file: 'a.txt',
		line: 1,
		text: 'new a1',
	});
	const commits = candidates.map(candidate => candidate.commit);
	expect(commits).not.toContain(cAdded);
	expect(commits).not.toContain(replaced);
});

test('why: for a commit that adds a 60-line file with a card, the card is smaller than blame-then-show, which is no larger than the history of a file with three commits', async () => {
	const original = lines(60);
	const dir = await repo([
		{
			commit: '✨ Add the scheduler',
			body: 'Why: jobs ran twice when the clock jumped\nConstraint: one timer per process',
			files: {'scheduler.txt': original},
		},
		{
			commit: '🐛 Change the last line',
			files: {'scheduler.txt': original.replace('line 60', 'changed 60')},
		},
		{
			commit: '🐛 Change the line before',
			files: {
				'scheduler.txt': original
					.replace('line 60', 'changed 60')
					.replace('line 59', 'changed 59'),
			},
		},
	]);
	const first = (await gitOutput(dir, ['rev-list', '--reverse', 'HEAD']))
		.trim()
		.split('\n')[0];

	const why = measureWhy(dir, cli, {file: 'scheduler.txt', line: 1});

	expect(why.location).toBe('scheduler.txt:1');
	expect(why.commit).toBe(first);
	expect(why.card).toBeGreaterThan(0);
	expect(why.card).toBeLessThan(why.blameShow);
	expect(why.blameMessage).toBeLessThan(why.blameShow);
	expect(why.blameShow).toBeLessThanOrEqual(why.fileHistory);
	expect(why.fileHistory).toBe(measureFileHistory(dir, 'scheduler.txt'));
});

test('why: for a one-line commit the three figures are still measured and reported as they are, even when the card is not the smallest', async () => {
	const dir = await repo([
		{
			commit: '🔧 Set the port',
			body: `Why: ${'the proxy in front of staging only forwards this port, '.repeat(6)}`,
			files: {'port.txt': '8080\n'},
		},
	]);
	const commit = await head(dir);

	const why = measureWhy(dir, cli, {file: 'port.txt', line: 1});

	expect(why).toEqual({
		location: 'port.txt:1',
		commit,
		card: estimateTokens(chamoji(dir, ['why', 'port.txt:1'])),
		blameShow: estimateTokens(
			await gitOutput(dir, ['show', '--no-color', commit]),
		),
		blameMessage: estimateTokens(
			await gitOutput(dir, ['show', '-s', '--no-color', commit]),
		),
		fileHistory: estimateTokens(
			await gitOutput(dir, ['log', '-p', '--no-color', '--', 'port.txt']),
		),
	});
});

/** A stand-in CLI whose `why --json` names `commit` and gives it a card. */
function stubCli(commit: string): string {
	const file = path.join(scratchFolder('chamoji-stub-cli-'), 'cli.mjs');
	writeFileSync(
		file,
		`process.stdout.write(${JSON.stringify(
			JSON.stringify({
				kind: 'commit',
				commit: {hash: commit},
				card: {why: ['a reason'], constraint: [], gotcha: [], followUp: []},
			}),
		)});\n`,
	);
	return file;
}

test('a line is a candidate only when why names the commit blame found for it', async () => {
	const dir = await repo([
		{
			commit: '✨ Add a',
			body: 'Why: a is needed',
			files: {'a.txt': 'a1\n'},
		},
	]);
	const commit = await head(dir);

	expect(sampleCandidates(dir, stubCli('f'.repeat(40)))).toEqual([]);
	expect(sampleCandidates(dir, stubCli(commit))).toEqual([
		{commit, file: 'a.txt', line: 1, text: 'a1'},
	]);
});

test('a sample line that moved down two lines is found again by its commit and text', async () => {
	const dir = await repo([
		{
			commit: '✨ Add the list',
			body: 'Why: the menu needs items',
			files: {'list.txt': 'x\ny\nz\n'},
		},
	]);
	const commit = await head(dir);
	const sample = {commit, file: 'list.txt', line: 2, text: 'y'};
	await repoStep(dir, {'list.txt': 'new 1\nnew 2\nx\ny\nz\n'});

	expect(locateSample(dir, [sample])).toEqual({
		found: [{...sample, line: 4}],
		dropped: [],
	});
});

test('a sample line that was rewritten is dropped and counted, not measured as another line', async () => {
	const dir = await repo([
		{
			commit: '✨ Add the list',
			body: 'Why: the menu needs items',
			files: {'list.txt': 'x\ny\nz\n', 'gone.txt': 'g\n'},
		},
	]);
	const commit = await head(dir);
	const rewritten = {commit, file: 'list.txt', line: 2, text: 'y'};
	const kept = {commit, file: 'list.txt', line: 1, text: 'x'};
	const removed = {commit, file: 'gone.txt', line: 1, text: 'g'};
	await repoStep(dir, {'list.txt': 'x\nY\nz\n'});
	await gitOutput(dir, ['rm', '-q', 'gone.txt']);
	await gitOutput(dir, ['commit', '-q', '-m', '🔥 Remove gone']);

	expect(locateSample(dir, [rewritten, kept, removed])).toEqual({
		found: [kept],
		dropped: [rewritten, removed],
	});
});

test('a line with the same text is not accepted when blame gives it to a different commit', async () => {
	const dir = await repo([
		{
			commit: '✨ Add the list',
			body: 'Why: the menu needs items',
			files: {'list.txt': 'x\ny\nz\n'},
		},
	]);
	const commit = await head(dir);
	const sample = {commit, file: 'list.txt', line: 2, text: 'y'};
	await repoStep(dir, {'list.txt': 'x\nchanged\nz\ny\n'});
	const blame = await gitOutput(dir, [
		'blame',
		'--porcelain',
		'-L',
		'4,4',
		'--',
		'list.txt',
	]);
	expect(blame.split(' ')[0]).not.toBe(commit);

	expect(locateSample(dir, [sample])).toEqual({found: [], dropped: [sample]});
});

test('a shallow clone is refused with a message that says to fetch the full history', async () => {
	const dir = await repo([
		{commit: '🎉 Init', files: {'a.txt': 'a\n'}},
		{commit: '✨ More', files: {'a.txt': 'b\n'}},
	]);
	const clones = mkdtempSync(path.join(tmpdir(), 'chamoji-shallow-'));
	cleanups.push(() => rmSync(clones, {recursive: true, force: true}));
	const shallow = path.join(clones, 'shallow');
	await gitOutput(clones, [
		'clone',
		'-q',
		'--depth',
		'1',
		pathToFileURL(dir).href,
		shallow,
	]);

	expect(() => assertFullHistory(dir)).not.toThrow();
	expect(() => assertFullHistory(shallow)).toThrow(
		/^This clone is shallow.*full history/,
	);
});

test('a file history of several megabytes is measured without a buffer error', async () => {
	const big = 'x'.repeat(99) + '\n';
	const dir = await repo([
		{commit: '✨ Add data', files: {'data.txt': big.repeat(30_000)}},
		{
			commit: '♻️ Change data',
			files: {'data.txt': big.replaceAll('x', 'y').repeat(30_000)},
		},
	]);

	expect(measureFileHistory(dir, 'data.txt')).toBeGreaterThan(
		(6 * 1024 * 1024) / 4,
	);
});

test('without a built CLI the runner prints "Run pnpm build first." and exits 2', async () => {
	const copy = mkdtempSync(path.join(tmpdir(), 'chamoji-runner-'));
	cleanups.push(() => rmSync(copy, {recursive: true, force: true}));
	mkdirSync(path.join(copy, 'scripts', 'lib'), {recursive: true});
	for (const file of [
		'memory-benchmark.mjs',
		'lib/memory-measure.mjs',
		'lib/memory-tokens.mjs',
	]) {
		copyFileSync(
			path.join(root, 'scripts', file),
			path.join(copy, 'scripts', file),
		);
	}

	const error = await execFileAsync(process.execPath, [
		path.join(copy, 'scripts', 'memory-benchmark.mjs'),
	]).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain('Run pnpm build first.');
});

/** A folder outside any repo, removed after the test. */
function scratchFolder(prefix: string): string {
	const folder = mkdtempSync(path.join(tmpdir(), prefix));
	cleanups.push(() => rmSync(folder, {recursive: true, force: true}));
	return folder;
}

/**
 * A repo with two carded commits, the second changing a line in the middle of
 * a file, and a sample file for that line outside the repo. A change with
 * lines around it is one whose diff git's diff options can alter.
 */
async function runnerFixture() {
	const dir = await repo([
		{
			commit: '✨ Add the parser',
			body: 'Why: the old one choked on tabs\nGotcha: tabs count as one column',
			files: {'parser.txt': lines(9)},
		},
		{
			commit: '🐛 Fix the fifth line',
			body: 'Why: the fifth line was wrong\nConstraint: keep it short',
			files: {'parser.txt': lines(9).replace('line 5', 'fixed 5')},
		},
	]);
	const commit = await head(dir);
	const sampleFile = path.join(scratchFolder('chamoji-sample-'), 'sample.json');
	writeFileSync(
		sampleFile,
		JSON.stringify([{commit, file: 'parser.txt', line: 5, text: 'fixed 5'}]),
	);
	return {dir, sampleFile};
}

test('the runner leaves the checkout it ran in untouched: git status is clean and no cache folder appears in its git directory', async () => {
	const {dir, sampleFile} = await runnerFixture();

	const {stdout} = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile],
		{cwd: dir},
	);

	expect(stdout).toContain('What stands');
	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe('');
	expect(existsSync(path.join(dir, '.git', 'chamoji'))).toBe(false);
});

test('with --sample the runner measures the lines of that sample, end to end', async () => {
	const {dir, sampleFile} = await runnerFixture();

	const {stdout} = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile],
		{cwd: dir},
	);

	expect(stdout).toContain('(1 lines measured, 0 dropped)');
});

// It runs the measuring script five times, which took 18.6 s of the usual
// 20 s on GitHub's Linux runners, so it gets a minute.
test('the figures are the same when the git config of whoever runs it sets format.pretty and diff.noprefix, in a file or in the environment', async () => {
	const {dir, sampleFile} = await runnerFixture();
	const configs = scratchFolder('chamoji-gitconfig-');
	const plain = path.join(configs, 'plain');
	const noisy = path.join(configs, 'noisy');
	writeFileSync(plain, '');
	writeFileSync(
		noisy,
		'[format]\n\tpretty = oneline\n[diff]\n\tnoprefix = true\n[log]\n\tdecorate = full\n',
	);
	const runWith = async (config: string, env: NodeJS.ProcessEnv = {}) =>
		(
			await execFileAsync(process.execPath, [runner, '--sample', sampleFile], {
				cwd: dir,
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: config,
					GIT_CONFIG_NOSYSTEM: '1',
					...env,
				},
			})
		).stdout;

	const withPlain = await runWith(plain);

	expect(withPlain).toContain('(1 lines measured, 0 dropped)');
	expect(await runWith(noisy)).toBe(withPlain);
	expect(
		await runWith(plain, {
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'format.pretty',
			GIT_CONFIG_VALUE_0: 'oneline',
			GIT_CONFIG_KEY_1: 'diff.noprefix',
			GIT_CONFIG_VALUE_1: 'true',
		}),
	).toBe(withPlain);
	expect(
		await runWith(plain, {
			GIT_CONFIG_PARAMETERS: "'format.pretty'='oneline'",
		}),
	).toBe(withPlain);
	expect(await runWith(plain, {GIT_DIFF_OPTS: '--unified=0'})).toBe(withPlain);
}, 60_000);

test('--pick-sample with --sample writes a sample for the repo being measured, and leaves that repo untouched', async () => {
	const {dir} = await runnerFixture();
	const sampleFile = path.join(scratchFolder('chamoji-picked-'), 'mine.json');

	await execFileAsync(
		process.execPath,
		[runner, '--pick-sample', '--sample', sampleFile],
		{cwd: dir},
	);

	const picked = JSON.parse(readFileSync(sampleFile, 'utf8'));
	expect(picked).toEqual(pickSample(sampleCandidates(dir, cli), 20));
	expect(picked).toHaveLength(2);
	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe('');
});

test('with no line measured the runner says so and shows no typical switch, and --write refuses and writes nothing', async () => {
	const {dir} = await runnerFixture();
	const sampleFile = path.join(scratchFolder('chamoji-empty-'), 'none.json');
	writeFileSync(sampleFile, '[]\n');

	const {stdout} = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile],
		{cwd: dir},
	);

	expect(stdout).toContain(NO_LINES_MEASURED);
	expect(stdout).not.toContain('Typical switch');
	expect(stdout).not.toContain('Share of a context window');

	const pageFile = writePage(dir);
	const error = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain(NO_LINES_MEASURED);
	expect(readFileSync(pageFile, 'utf8')).toBe(pageText);
	expect(
		existsSync(path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json')),
	).toBe(false);
});

test("--pick-sample refuses to run in another repo and leaves the script's own sample alone", async () => {
	const {dir} = await runnerFixture();
	// A copy of the scripts, so a regression can't overwrite this repo's
	// sample. The CLI is a stand-in: the refusal comes before any call to it.
	const copy = scratchFolder('chamoji-runner-');
	mkdirSync(path.join(copy, 'scripts', 'lib'), {recursive: true});
	mkdirSync(path.join(copy, 'scripts', 'memory-benchmark'));
	mkdirSync(path.join(copy, 'packages', 'cli', 'dist'), {recursive: true});
	for (const file of [
		'memory-benchmark.mjs',
		'lib/memory-measure.mjs',
		'lib/memory-tokens.mjs',
	]) {
		copyFileSync(
			path.join(root, 'scripts', file),
			path.join(copy, 'scripts', file),
		);
	}

	writeFileSync(path.join(copy, 'packages', 'cli', 'dist', 'cli.js'), '');
	const sampleFile = path.join(
		copy,
		'scripts',
		'memory-benchmark',
		'sample.json',
	);
	const before = '[]\n';
	writeFileSync(sampleFile, before);

	const error = await execFileAsync(
		process.execPath,
		[path.join(copy, 'scripts', 'memory-benchmark.mjs'), '--pick-sample'],
		{
			cwd: dir,
		},
	).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain(
		"Run --pick-sample from this repo, since it writes this repo's sample.",
	);
	expect(readFileSync(sampleFile, 'utf8')).toBe(before);
	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe('');
});

async function repoStep(dir: string, files: Record<string, string>) {
	for (const [name, text] of Object.entries(files)) {
		await writeFile(path.join(dir, name), text);
		await gitOutput(dir, ['add', '--', name]);
	}

	await gitOutput(dir, ['commit', '-q', '-m', '♻️ Move things']);
}

const tag = (dir: string, name: string) => gitOutput(dir, ['tag', name]);

test('growth has one row per tag from v0.11.0 that is an ancestor of HEAD, oldest first', async () => {
	const dir = await repo([{commit: '🎉 Start', files: {'a.txt': 'a\n'}}]);
	await tag(dir, 'v0.9.0');
	await repoStep(dir, {'a.txt': 'b\n'});
	await tag(dir, 'v0.11.0');
	await repoStep(dir, {'a.txt': 'c\n'});
	await tag(dir, 'v0.12.0');
	await tag(dir, 'nightly');
	await repoStep(dir, {'a.txt': 'd\n'});
	await tag(dir, 'v0.100.0');
	await tag(dir, 'v1.0.0-rc.1');
	await gitOutput(dir, ['switch', '-q', '-c', 'side']);
	await repoStep(dir, {'b.txt': 'side\n'});
	await tag(dir, 'v0.13.0');
	await gitOutput(dir, ['switch', '-q', 'main']);

	const tags = releaseTags(dir);
	const growth = measureGrowth(dir, cli, tags, {uncutBudget: UNCUT});

	expect(tags).toEqual(['v0.11.0', 'v0.12.0', 'v0.100.0']);
	expect(growth.map(row => row.tag)).toEqual(tags);
	expect(growth.map(row => row.commits)).toEqual([2, 3, 4]);
});

test('a tag with no card lines gives brief 0 and cardLines 0, and the row has no NaN or Infinity', async () => {
	const dir = await repo([{commit: '🎉 Start', files: {'a.txt': 'a\n'}}]);
	await tag(dir, 'v0.11.0');
	await repoStep(dir, {'a.txt': 'b\n'});
	await gitOutput(dir, [
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'✨ Add b',
		'-m',
		'Why: b is needed\nGotcha: b is slow',
	]);
	await tag(dir, 'v0.12.0');

	const [bare, carded] = measureGrowth(dir, cli, ['v0.11.0', 'v0.12.0'], {
		uncutBudget: UNCUT,
	});

	expect(bare).toMatchObject({
		tag: 'v0.11.0',
		brief: 0,
		briefUncut: 0,
		cardLines: 0,
	});
	expect(carded.cardLines).toBe(1);
	expect(carded.brief).toBeGreaterThan(0);
	expect(carded.briefUncut).toBe(carded.brief);
	for (const row of [bare, carded]) {
		for (const value of Object.values(row)) {
			if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
		}
	}
});

test('the worktrees made for the tags are gone afterwards, and the checkout is untouched', async () => {
	const dir = await repo([
		{
			commit: '✨ Add a',
			body: 'Why: a is needed',
			files: {'a.txt': 'a\n'},
		},
	]);
	await tag(dir, 'v0.11.0');
	await repoStep(dir, {'a.txt': 'b\n'});
	await tag(dir, 'v0.12.0');
	const before = await head(dir);
	const growthFolders = () =>
		readdirSync(tmpdir()).filter(name =>
			name.startsWith('chamoji-memory-growth-'),
		);
	const foldersBefore = growthFolders();

	measureGrowth(dir, cli, ['v0.11.0', 'v0.12.0'], {uncutBudget: UNCUT});

	expect(
		(await gitOutput(dir, ['worktree', 'list', '--porcelain']))
			.split('\n')
			.filter(line => line.startsWith('worktree ')),
	).toHaveLength(1);
	expect(growthFolders()).toEqual(foldersBefore);
	expect(await head(dir)).toBe(before);
	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe('');
});

const pageText = `# Page\n\n${LIVE_HEADING}\n\nOld live.\n\n## After\n\nKept.\n\n${REPLAY_HEADING}\n\nOld.\n`;

/** The page --write fills in, put in a fixture repo's working copy. */
function writePage(dir: string) {
	const file = path.join(dir, 'docs', 'site', 'guides', 'memory-tokens.mdx');
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, pageText);
	return file;
}

/** The runner with --write in a fixture repo; the results file it wrote. */
async function runWrite(extra: string[], env: NodeJS.ProcessEnv = process.env) {
	const {dir, sampleFile} = await runnerFixture();
	writePage(dir);
	const output = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write', ...extra],
		{cwd: dir, env},
	);
	const text = readFileSync(
		path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json'),
		'utf8',
	);
	return {...output, text};
}

test('--write produces a file that parses, has version 2, records the budgets and the tool definitions, and whose typicalSwitch equals switchFigures() of its own parts', async () => {
	const {text} = await runWrite([]);
	const results = JSON.parse(text);

	expect(text.endsWith('}\n')).toBe(true);
	expect(text).toContain('\n\t"version": 2,');
	expect(results.version).toBe(2);
	expect(results.why.sampleSize).toBe(1);
	expect(results.method).toMatchObject({
		refsAsOf: 'HEAD',
		briefBudget: 1500,
		uncutBudget: 20_000,
	});
	expect(results.whatStands.mcpTools.tokens).toBeGreaterThan(0);
	expect(results.whatStands.briefLines).toBe(2);
	expect(results.why.perLine[0].blameMessage).toBeGreaterThan(0);
	expect(results.growth).toEqual([]);
	expect(results.typicalSwitch).toEqual(
		switchFigures({
			whatStands: results.whatStands,
			why: results.why,
			lookups: results.method.lookups,
		}),
	);
	expect(results.typicalSwitch.with).toBe(
		Math.round(
			results.whatStands.brief.tokens +
				results.whatStands.mcpTools.tokens +
				5 * results.why.card.mean,
		),
	);
});

test('--exact with no API key prints the skip line and still writes the file with exact: null', async () => {
	const env = {...process.env};
	delete env.ANTHROPIC_API_KEY;

	const {stderr, text} = await runWrite(['--exact'], env);

	expect(stderr).toContain(
		'No API key in the environment, so the exact column was skipped.',
	);
	expect(JSON.parse(text).exact).toBeNull();
});

test('--write fills in the page from the file it wrote, in the fixture and not in this repo', async () => {
	const {dir, sampleFile} = await runnerFixture();
	const pageFile = writePage(dir);
	const ours = path.join(
		path.dirname(runner),
		'..',
		'docs',
		'benchmarks',
		'memory-tokens.json',
	);
	const oursBefore = readFileSync(ours, 'utf8');

	await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	);

	const results = JSON.parse(
		readFileSync(
			path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json'),
			'utf8',
		),
	);
	const page = readFileSync(pageFile, 'utf8');
	expect(sectionBody(page, REPLAY_HEADING)).toBe(renderTables(results).trim());
	expect(sectionBody(page, '## After')).toBe('Kept.');
	expect(sectionBody(page, LIVE_HEADING)).toBe(
		'The live sample has not been run yet.',
	);
	expect(readFileSync(ours, 'utf8')).toBe(oursBefore);
});

test('--write fills the live section from the live results file when there is one', async () => {
	const {dir, sampleFile} = await runnerFixture();
	const pageFile = writePage(dir);
	const figures = {mean: 2, median: 2, min: 1, max: 3};
	const side = {
		runs: 1,
		errors: 0,
		inputTokens: figures,
		outputTokens: figures,
		turns: figures,
		toolCalls: figures,
	};
	const live = {
		version: 1,
		model: 'claude-sonnet-5-5',
		date: '2026-11-19',
		commit: '0123456789abcdef0123456789abcdef01234567',
		method: {},
		runs: [
			{question: 1, side: 'with', run: 1, inputTokens: 2, correct: null},
			{question: 1, side: 'without', run: 1, inputTokens: 2, correct: null},
		],
		summary: {with: side, without: side},
		checked: false,
	};
	mkdirSync(path.join(dir, 'docs', 'benchmarks'), {recursive: true});
	writeFileSync(
		path.join(dir, 'docs', 'benchmarks', 'memory-tokens-live.json'),
		JSON.stringify(live),
	);

	await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	);

	const page = readFileSync(pageFile, 'utf8');
	const results = JSON.parse(
		readFileSync(
			path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json'),
			'utf8',
		),
	);
	expect(sectionBody(page, LIVE_HEADING)).toBe(
		renderLive(live, results).trim(),
	);
	expect(sectionBody(page, '## After')).toBe('Kept.');
});

test('--page-only re-renders both sections from the two results files as they are, measuring nothing', async () => {
	const {dir, sampleFile} = await runnerFixture();
	const pageFile = writePage(dir);
	await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	);
	const resultsFile = path.join(
		dir,
		'docs',
		'benchmarks',
		'memory-tokens.json',
	);
	const resultsText = readFileSync(resultsFile, 'utf8');
	// A replay figure no run could give, so a re-measure would show.
	const results = {
		...JSON.parse(resultsText),
		ranAt: {tag: null, commit: 'f'.repeat(40), date: '2000-01-01'},
	};
	writeFileSync(resultsFile, `${JSON.stringify(results, null, '\t')}\n`);
	const figures = {mean: 2, median: 2, min: 1, max: 3};
	const side = {
		runs: 1,
		errors: 0,
		inputTokens: figures,
		outputTokens: figures,
		turns: figures,
		toolCalls: figures,
	};
	const live = {
		version: 1,
		model: 'claude-sonnet-5-5',
		date: '2026-11-19',
		commit: '0123456789abcdef0123456789abcdef01234567',
		method: {},
		questions: [
			{question: 'One?', rule: 'c-00000001', key: 'Yes.', inBrief: true},
		],
		runs: [
			{question: 1, side: 'with', run: 1, inputTokens: 2, correct: true},
			{question: 1, side: 'without', run: 1, inputTokens: 2, correct: false},
		],
		summary: {with: side, without: side},
		checked: true,
	};
	writeFileSync(
		path.join(dir, 'docs', 'benchmarks', 'memory-tokens-live.json'),
		JSON.stringify(live),
	);

	await execFileAsync(process.execPath, [runner, '--page-only'], {cwd: dir});

	const page = readFileSync(pageFile, 'utf8');
	expect(sectionBody(page, REPLAY_HEADING)).toBe(renderTables(results).trim());
	expect(sectionBody(page, REPLAY_HEADING)).toContain('2000-01-01');
	expect(sectionBody(page, LIVE_HEADING)).toBe(
		renderLive(live, results).trim(),
	);
	expect(JSON.parse(readFileSync(resultsFile, 'utf8'))).toEqual(results);
});

test('--page-only with no results file refuses and leaves the page as it was', async () => {
	const {dir} = await runnerFixture();
	const pageFile = writePage(dir);

	const error = await execFileAsync(process.execPath, [runner, '--page-only'], {
		cwd: dir,
	}).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain('docs/benchmarks/memory-tokens.json');
	expect(readFileSync(pageFile, 'utf8')).toBe(pageText);
});

test('--write with a page that has no live heading fails and leaves the page as it was', async () => {
	const {dir, sampleFile} = await runnerFixture();
	const pageFile = writePage(dir);
	const text = `# Page\n\n${REPLAY_HEADING}\n\nOld.\n`;
	writeFileSync(pageFile, text);

	const error = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain(`has no "${LIVE_HEADING}" heading`);
	expect(readFileSync(pageFile, 'utf8')).toBe(text);
	expect(
		existsSync(path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json')),
	).toBe(false);
});

test('--write with no page fails with a message and writes no results file', async () => {
	const {dir, sampleFile} = await runnerFixture();

	const error = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain(
		'There is no page at docs/site/guides/memory-tokens.mdx',
	);
	expect(
		existsSync(path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json')),
	).toBe(false);
});

test('--write with a page that has no replay heading fails and leaves the page as it was', async () => {
	const {dir, sampleFile} = await runnerFixture();
	const pageFile = writePage(dir);
	const text = `# Page\n\n${LIVE_HEADING}\n\nOld live.\n`;
	writeFileSync(pageFile, text);

	const error = await execFileAsync(
		process.execPath,
		[runner, '--sample', sampleFile, '--write'],
		{cwd: dir},
	).then(
		() => undefined,
		(error: {code: number; stderr: string}) => error,
	);

	expect(error?.code).toBe(2);
	expect(error?.stderr).toContain(`has no "${REPLAY_HEADING}" heading`);
	expect(readFileSync(pageFile, 'utf8')).toBe(text);
	expect(
		existsSync(path.join(dir, 'docs', 'benchmarks', 'memory-tokens.json')),
	).toBe(false);
});
