import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {cardLineId} from '../src/card-lines.js';
import {cardStatePath, readCardState} from '../src/card-state-repo.js';
import {linesFor, publicLine} from '../src/card-state.js';
import {snapshotWorkstream} from '../src/memory.js';
import {writeNoteCard} from '../src/why-notes.js';
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

const PORT = 'The dev server must stay on port 3000';
const PORT_ID = cardLineId('constraint', PORT);
const FLAKY = 'The upload test is flaky on CI';
const FLAKY_ID = cardLineId('gotcha', FLAKY);

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    status: shipped',
		'',
	].join('\n'),
};

const rev = async (dir: string, ref: string) =>
	(await gitOutput(dir, ['rev-parse', ref])).trim();

/** Writes and stages `files`, then commits with `message` on the current branch. */
async function commit(
	dir: string,
	message: string,
	files: Record<string, string> = {},
): Promise<string> {
	for (const [name, text] of Object.entries(files)) {
		const file = path.join(dir, ...name.split('/'));
		await mkdir(path.dirname(file), {recursive: true});
		await writeFile(file, text);
		await gitOutput(dir, ['add', '--', name]);
	}

	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', message]);
	return rev(dir, 'HEAD');
}

const lineOf = async (dir: string, id: string) =>
	(await readCardState(dir)).lines.find(line => line.id === id);

test('a line resolved on a side branch is open on main, and resolved once the branch is merged', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	const resolving = await commit(
		repo.dir,
		`♻️ Move the port\n\nResolves: ${PORT_ID} the proxy owns the port now`,
		{'proxy.ts': 'proxy\n'},
	);
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({state: 'open'});

	await gitOutput(repo.dir, ['merge', '-q', '--no-ff', '-m', 'Merge', 'side']);
	const line = await lineOf(repo.dir, PORT_ID);
	expect(line).toMatchObject({
		state: 'resolved',
		resolvedBy: {hash: resolving, reason: 'the proxy owns the port now'},
	});
});

test('git revert of the resolving commit reopens the line', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{
			commit: '♻️ Move the port',
			body: `Resolves: ${PORT_ID}`,
			files: {'proxy.ts': 'proxy\n'},
		},
	]);
	expect((await lineOf(repo.dir, PORT_ID))?.state).toBe('resolved');
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	const line = await lineOf(repo.dir, PORT_ID);
	expect(line?.state).toBe('open');
	expect(line?.resolvedBy).toBeUndefined();
});

test('reverting the merge that brought the resolving commit in reopens the line', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	await commit(repo.dir, `♻️ Move the port\n\nResolves: ${PORT_ID}`, {
		'proxy.ts': 'proxy\n',
	});
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await gitOutput(repo.dir, ['merge', '-q', '--no-ff', '-m', 'Merge', 'side']);
	expect((await lineOf(repo.dir, PORT_ID))?.state).toBe('resolved');

	await gitOutput(repo.dir, ['revert', '--no-edit', '-m', '1', 'HEAD']);
	expect((await lineOf(repo.dir, PORT_ID))?.state).toBe('open');
});

test('a Constraint: line added in a note gets an id, and its source is the noted commit', async () => {
	repo = await createRepo([
		{commit: '✨ Add server', files: {'server.ts': 'listen(3000)\n'}},
		{commit: '📝 Tidy readme', files: {'README.md': 'hi\n'}},
	]);
	const noted = await rev(repo.dir, 'HEAD~1');
	await writeNoteCard(repo.dir, noted, `Constraint: ${PORT}`);
	const line = await lineOf(repo.dir, PORT_ID);
	expect(line).toMatchObject({
		id: PORT_ID,
		kind: 'constraint',
		text: PORT,
		state: 'open',
		sources: [noted],
	});
});

test('a Resolves: inside a note resolves nothing', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '📝 Tidy readme', files: {'README.md': 'hi\n'}},
	]);
	await writeNoteCard(
		repo.dir,
		await rev(repo.dir, 'HEAD'),
		`Why: the port moved\nResolves: ${PORT_ID}`,
	);
	const state = await readCardState(repo.dir);
	expect(state.lines.find(line => line.id === PORT_ID)?.state).toBe('open');
	expect(state.dangling).toEqual([]);
});

test('a line whose branch was deleted after ws ship is off branch', async () => {
	repo = await createRepo([{commit: '🎉 Init', files: WORKSTREAMS}]);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'auth']);
	const stated = await commit(
		repo.dir,
		`✨ Add login\n\nConstraint: ${PORT}\nWorkstream: auth`,
		{'login.ts': 'login\n'},
	);
	await snapshotWorkstream(repo.dir, 'auth');
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await gitOutput(repo.dir, ['branch', '-q', '-D', 'auth']);

	const line = await lineOf(repo.dir, PORT_ID);
	expect(line).toMatchObject({
		state: 'off-branch',
		sources: [stated],
		workstream: {slug: 'auth', status: 'shipped'},
		files: [],
	});
});

test('an open line whose file was rewritten is in doubt, with replacedBy set to the rewriting commit', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '📝 Tidy readme', files: {'README.md': 'hi\n'}},
		{commit: '♻️ Rewrite server', files: {'server.ts': 'serve()\n'}},
		{commit: '📝 Readme again', files: {'README.md': 'hello\n'}},
	]);
	const line = await lineOf(repo.dir, PORT_ID);
	expect(line).toMatchObject({
		state: 'in-doubt',
		files: ['server.ts'],
		replacedBy: await rev(repo.dir, 'HEAD~1'),
	});
});

test('readCardState called from a subdirectory gives the same state as from the root, and what it caches is right when read from the root', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}\nGotcha: ${FLAKY}`,
			files: {'src/server.ts': 'listen(3000)\n', 'docs/port.md': 'port\n'},
		},
		{commit: '♻️ Rewrite the docs', files: {'docs/port.md': 'gone\n'}},
	]);
	const fromSub = await readCardState(path.join(repo.dir, 'src'));
	expect(fromSub.lines.map(line => [line.id, line.state]).sort()).toEqual(
		[
			[PORT_ID, 'open'],
			[FLAKY_ID, 'open'],
		].sort(),
	);
	expect([...fromSub.lines[0]!.files].sort()).toEqual([
		'docs/port.md',
		'src/server.ts',
	]);

	// Read back from the cache at the root, then worked out afresh there.
	expect(await readCardState(repo.dir)).toEqual(fromSub);
	await rm(await cardStatePath(repo.dir));
	expect(await readCardState(repo.dir)).toEqual(fromSub);
});

test('files lists the paths the source commit added lines to', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}\nGotcha: ${FLAKY}`,
			files: {'src/server.ts': 'listen(3000)\n', 'docs/port.md': 'port\n'},
		},
		{commit: '✅ Fix the test', body: `Resolves: ${FLAKY_ID}`},
	]);
	const state = await readCardState(repo.dir);
	const port = state.lines.find(line => line.id === PORT_ID);
	expect(port?.state).toBe('open');
	expect([...port!.files].sort()).toEqual(['docs/port.md', 'src/server.ts']);
	// A resolved line is never blamed, so nothing is known of its files.
	const flaky = state.lines.find(line => line.id === FLAKY_ID);
	expect(flaky).toMatchObject({state: 'resolved', files: []});
});

test('a repo with no card lines blames nothing', async () => {
	repo = await createRepo([
		{commit: '✨ Add server', files: {'server.ts': 'listen(3000)\n'}},
	]);
	expect((await readCardState(repo.dir)).lines).toEqual([]);
	const blameCache = path.join(
		path.dirname(await cardStatePath(repo.dir)),
		'blame-cache.json',
	);
	await expect(readFile(blameCache, 'utf8')).rejects.toThrow();
});

test('the state is read back from the cache file, and rebuilt when the notes ref moves', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	await readCardState(repo.dir);
	const file = await cardStatePath(repo.dir);
	const saved = JSON.parse(await readFile(file, 'utf8'));
	expect(saved).toMatchObject({version: 1, head: await rev(repo.dir, 'HEAD')});
	saved.state.lines[0].text = 'edited in place';
	await writeFile(file, JSON.stringify(saved));
	expect((await lineOf(repo.dir, PORT_ID))?.text).toBe('edited in place');

	await writeNoteCard(repo.dir, await rev(repo.dir, 'HEAD'), 'Why: a reason');
	expect((await lineOf(repo.dir, PORT_ID))?.text).toBe(PORT);
});

test('a cache file that does not check out is rebuilt', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	await readCardState(repo.dir);
	const file = await cardStatePath(repo.dir);
	const saved = JSON.parse(await readFile(file, 'utf8'));
	for (const damage of [
		'not json',
		JSON.stringify({...saved, version: 2}),
		JSON.stringify({...saved, state: {...saved.state, lines: 'none'}}),
		JSON.stringify({
			...saved,
			state: {
				...saved.state,
				lines: [{...saved.state.lines[0], state: 'gone', text: 'x'}],
			},
		}),
		JSON.stringify({
			...saved,
			state: {
				...saved.state,
				lines: [{...saved.state.lines[0], sources: ['nope'], text: 'x'}],
			},
		}),
	]) {
		await writeFile(file, damage);
		const line = await lineOf(repo.dir, PORT_ID);
		expect(line).toMatchObject({text: PORT, state: 'open'});
	}
});

test('two calls at once both return the same state', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '♻️ Rewrite server', files: {'server.ts': 'serve()\n'}},
	]);
	const [first, second] = await Promise.all([
		readCardState(repo.dir),
		readCardState(repo.dir),
	]);
	expect(first).toEqual(second);
	expect(first.lines.find(line => line.id === PORT_ID)?.state).toBe('in-doubt');
	expect(await readCardState(repo.dir)).toEqual(first);
});

test('a state that cannot be written to the cache is still returned', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	// A file where the cache folder should be makes every write fail.
	await writeFile(path.dirname(await cardStatePath(repo.dir)), 'in the way');
	const line = await lineOf(repo.dir, PORT_ID);
	expect(line).toMatchObject({state: 'open', files: ['server.ts']});
});

test('a shallow clone gives open lines and does not throw', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: {'README.md': 'hi\n'}},
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	const parent = await mkdtemp(path.join(tmpdir(), 'chamoji-shallow-'));
	try {
		const copy = path.join(parent, 'copy');
		await gitOutput(parent, [
			'clone',
			'-q',
			'--depth',
			'1',
			`file://${repo.dir}`,
			copy,
		]);
		const state = await readCardState(copy);
		expect(state.lines.map(line => line.id)).toEqual([PORT_ID]);
		expect(state.lines.every(line => line.state === 'open')).toBe(true);
	} finally {
		await rm(parent, {recursive: true, force: true});
	}
});

test('a repo with no commits gives no lines', async () => {
	repo = await createRepo([]);
	expect(await readCardState(repo.dir)).toEqual({
		head: '',
		lines: [],
		dangling: [],
	});
});

test("linesFor returns a card's lines with their state, and nothing for undefined", async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}\nGotcha: ${FLAKY}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '✅ Fix the test', body: `Resolves: ${FLAKY_ID} retries added`},
	]);
	const state = await readCardState(repo.dir);
	const card = {
		why: [],
		constraint: [PORT, 'A line no commit states'],
		gotcha: [FLAKY],
		followUp: [],
	};
	const lines = linesFor(state, card);
	expect(lines.map(line => [line.id, line.state])).toEqual([
		[PORT_ID, 'open'],
		[FLAKY_ID, 'resolved'],
	]);
	expect(linesFor(state, undefined)).toEqual([]);

	expect(publicLine(lines[1]!)).toEqual({
		id: FLAKY_ID,
		kind: 'gotcha',
		text: FLAKY,
		state: 'resolved',
		resolvedBy: {
			hash: await rev(repo.dir, 'HEAD'),
			date: lines[1]!.resolvedBy!.date,
			reason: 'retries added',
		},
	});
	expect(Object.keys(publicLine(lines[0]!))).toEqual([
		'id',
		'kind',
		'text',
		'state',
	]);
});
