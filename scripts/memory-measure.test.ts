import {execFile, execFileSync} from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
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
	measureWhatStands,
	measureWhy,
	sampleCandidates,
} from './lib/memory-measure.mjs';
import {estimateTokens} from './lib/memory-tokens.mjs';

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

	const result = measureWhatStands(dir, cli);

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
	expect(result.commits).toBe(3);
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
		fileHistory: estimateTokens(
			await gitOutput(dir, ['log', '-p', '--no-color', '--', 'port.txt']),
		),
	});
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

test('the runner leaves the checkout it ran in untouched: git status is clean and no cache folder appears in its git directory', async () => {
	const dir = await repo([
		{
			commit: '✨ Add the parser',
			body: 'Why: the old one choked on tabs\nGotcha: tabs count as one column',
			files: {'parser.txt': lines(3)},
		},
	]);

	const {stdout} = await execFileAsync(process.execPath, [runner], {
		cwd: dir,
	});

	expect(stdout).toContain('What stands');
	expect(await gitOutput(dir, ['status', '--porcelain'])).toBe('');
	expect(existsSync(path.join(dir, '.git', 'chamoji'))).toBe(false);
});

async function repoStep(dir: string, files: Record<string, string>) {
	for (const [name, text] of Object.entries(files)) {
		await writeFile(path.join(dir, name), text);
		await gitOutput(dir, ['add', '--', name]);
	}

	await gitOutput(dir, ['commit', '-q', '-m', '♻️ Move things']);
}
