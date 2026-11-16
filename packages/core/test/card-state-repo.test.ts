import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {cardLineId} from '../src/card-lines.js';
import {
	ancestry,
	cardStatePath,
	readCardState,
	readRepoStamp,
} from '../src/card-state-repo.js';
import {linesFor, publicLine} from '../src/card-state.js';
import {headOf, shallowStamp, snapshotWorkstream} from '../src/memory.js';
import {writeNoteCard} from '../src/why-notes.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

const execFileAsync = promisify(execFile);

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

test('the stamp read in two calls matches each part read alone, from anywhere in the repo', async () => {
	repo = await createRepo([{commit: '🎉 Init'}, {commit: '✨ Add search'}]);
	const {dir} = repo;
	const alone = async (cwd: string) => ({
		head: (await headOf(cwd, 'HEAD')) ?? '',
		memory: (await headOf(cwd, 'refs/chamoji/memory')) ?? '',
		notes: (await headOf(cwd, 'refs/notes/chamoji')) ?? '',
		shallow: await shallowStamp(cwd),
	});
	const gitDir = (
		await gitOutput(dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	const top = (await gitOutput(dir, ['rev-parse', '--show-toplevel'])).trim();

	expect(await readRepoStamp(dir)).toEqual({
		stamp: await alone(dir),
		gitDir,
		topLevel: top,
	});
	expect((await readRepoStamp(dir)).stamp).toMatchObject({
		memory: '',
		notes: '',
	});

	// A memory ref that names a tree names no commit; a notes ref names one.
	const tree = (await gitOutput(dir, ['rev-parse', 'HEAD^{tree}'])).trim();
	await gitOutput(dir, ['update-ref', 'refs/chamoji/memory', tree]);
	await gitOutput(dir, ['notes', '--ref=chamoji', 'add', '-m', 'note', 'HEAD']);
	const sub = path.join(dir, 'src');
	await mkdir(sub, {recursive: true});
	for (const cwd of [dir, sub]) {
		const read = await readRepoStamp(cwd);
		expect(read).toEqual({stamp: await alone(cwd), gitDir, topLevel: top});
		expect(read.stamp.notes).toMatch(/^[0-9a-f]{40}$/);
		expect(read.stamp.memory).toBe('');
	}

	// Inside the git directory there is no work tree, and the rest still reads.
	expect(await readRepoStamp(gitDir)).toEqual({
		stamp: await alone(gitDir),
		gitDir,
		topLevel: '',
	});
});

/** A small seeded generator, so a failing graph can be made again. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

/**
 * A commit graph as `rev-list --parents` gives it, newest first: some roots,
 * mostly one parent, some merges of two or three, and now and then a parent
 * that is not listed itself, as past a shallow boundary.
 */
function randomGraph(next: () => number, size: number): Map<string, string[]> {
	const hashes = Array.from({length: size}, (_, i) =>
		i.toString(16).padStart(40, '0'),
	);
	const parents = new Map<string, string[]>();
	for (let i = size - 1; i >= 0; i--) {
		const roll = next();
		const count =
			i === 0 || roll < 0.05 ? 0 : roll < 0.75 ? 1 : roll < 0.95 ? 2 : 3;
		const picked = new Set<string>();
		for (let p = 0; p < count; p++) {
			picked.add(
				next() < 0.03 ? `unlisted-${i}-${p}` : hashes[Math.floor(next() * i)]!,
			);
		}

		parents.set(hashes[i]!, [...picked]);
	}

	return parents;
}

/** The plain walk: everything reachable from `descendant`, itself included. */
function walk(parents: Map<string, string[]>, descendant: string): Set<string> {
	const seen = new Set([descendant]);
	const queue = [descendant];
	while (queue.length > 0) {
		for (const parent of parents.get(queue.pop()!) ?? []) {
			if (!seen.has(parent)) {
				seen.add(parent);
				queue.push(parent);
			}
		}
	}

	return seen;
}

test("ancestry gives the plain walk's answer for every pair of random graphs with merges", () => {
	const next = random(20_261_115);
	for (let graph = 0; graph < 40; graph++) {
		const parents = randomGraph(next, 2 + Math.floor(next() * 60));
		const isAncestor = ancestry(parents);
		const names = [
			...new Set([...parents.keys(), ...[...parents.values()].flat()]),
			'not-a-commit',
		];
		// Asked in a shuffled order, so cached answers meet fresh walks.
		const pairs = names.flatMap(a => names.map(d => [a, d] as const));
		for (let i = pairs.length - 1; i > 0; i--) {
			const j = Math.floor(next() * (i + 1));
			[pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!];
		}
		for (const [ancestor, descendant] of pairs) {
			expect(
				isAncestor(ancestor, descendant),
				`graph ${graph}: ${ancestor} ${descendant}`,
			).toBe(walk(parents, descendant).has(ancestor));
		}
	}
});

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

test('git revert -m 2 of a merge undoes the mainline side: the line it resolved reopens and the kept side stays', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	await commit(repo.dir, `✨ Add upload\n\nGotcha: ${FLAKY}`, {
		'upload.ts': 'upload\n',
	});
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await commit(repo.dir, `♻️ Move the port\n\nResolves: ${PORT_ID}`, {
		'proxy.ts': 'proxy\n',
	});
	await gitOutput(repo.dir, ['merge', '-q', '--no-ff', '-m', 'Merge', 'side']);
	expect((await lineOf(repo.dir, PORT_ID))?.state).toBe('resolved');
	expect((await lineOf(repo.dir, FLAKY_ID))?.state).toBe('open');

	await gitOutput(repo.dir, ['revert', '--no-edit', '-m', '2', 'HEAD']);
	expect((await lineOf(repo.dir, PORT_ID))?.state).toBe('open');
	expect((await lineOf(repo.dir, FLAKY_ID))?.state).toBe('open');
});

test("after git revert of a line's only source, the line is reverted, by that revert", async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: {'README.md': 'hi\n'}},
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	const stated = await rev(repo.dir, 'HEAD');
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	const state = await readCardState(repo.dir);
	expect(state.lines.find(line => line.id === PORT_ID)).toEqual({
		id: PORT_ID,
		kind: 'constraint',
		text: PORT,
		state: 'reverted',
		sources: [stated],
		date: state.lines[0]!.date,
		files: [],
		revertedBy: await rev(repo.dir, 'HEAD'),
	});
	// And the same when read back from the cache.
	expect(await readCardState(repo.dir)).toEqual(state);
});

test('a revert of a revert restores the line, even when the first revert is dated later', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	const stated = await rev(repo.dir, 'HEAD');
	// A skewed clock dates the first revert after the revert of it, so git
	// log lists it first once a merge joins the two.
	await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], {
		cwd: repo.dir,
		env: {...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z'},
	});
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await gitOutput(repo.dir, ['merge', '-q', '--no-ff', '-m', 'Merge', 'side']);

	// Blame credits the restored code to the revert of the revert, which
	// stands for the commit that stated the line, so the line is open.
	const line = await lineOf(repo.dir, PORT_ID);
	expect(line).toMatchObject({state: 'open', sources: [stated]});
	expect(line?.revertedBy).toBeUndefined();
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
	expect(saved).toMatchObject({version: 4, head: await rev(repo.dir, 'HEAD')});
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
		JSON.stringify({...saved, version: 1}),
		JSON.stringify({...saved, version: 5}),
		JSON.stringify({...saved, shallow: 'f'.repeat(64)}),
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
		JSON.stringify({
			...saved,
			state: {
				...saved.state,
				lines: [{...saved.state.lines[0], revertedBy: 'nope', text: 'x'}],
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
	const clone = await shallowClone(repo.dir);
	try {
		const state = await readCardState(clone.copy);
		expect(state.lines.map(line => line.id)).toEqual([PORT_ID]);
		expect(state.lines.every(line => line.state === 'open')).toBe(true);
	} finally {
		await clone.cleanup();
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

/** A `--depth 1` clone of `dir` in a fresh temp folder, and a way to remove it. */
async function shallowClone(
	dir: string,
): Promise<{copy: string; cleanup(): Promise<void>}> {
	const parent = await mkdtemp(path.join(tmpdir(), 'chamoji-shallow-'));
	const copy = path.join(parent, 'copy');
	await gitOutput(parent, [
		'clone',
		'-q',
		'--depth',
		'1',
		`file://${dir}`,
		copy,
	]);
	return {copy, cleanup: () => rm(parent, {recursive: true, force: true})};
}

test('a shallow clone that is deepened rebuilds its state without HEAD moving', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '📝 Tidy readme', files: {'README.md': 'hi\n'}},
	]);
	const stated = await rev(repo.dir, 'HEAD~1');
	const clone = await shallowClone(repo.dir);
	try {
		// Only HEAD is in the clone, so the line is not known yet.
		expect(await lineOf(clone.copy, PORT_ID)).toBeUndefined();
		const head = await rev(clone.copy, 'HEAD');

		await gitOutput(clone.copy, ['fetch', '-q', '--unshallow']);
		expect(await rev(clone.copy, 'HEAD')).toBe(head);
		expect(await lineOf(clone.copy, PORT_ID)).toMatchObject({
			state: 'open',
			sources: [stated],
		});
	} finally {
		await clone.cleanup();
	}
});

test('a card-state cache file with the old version is rebuilt', async () => {
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
	expect(saved).toMatchObject({version: 4, shallow: ''});
	// Version 2 had no shallow stamp; version 3 kept lines that only say none.
	const {shallow: _, ...two} = saved;
	two.version = 2;
	two.state.lines[0].text = 'edited in place';
	await writeFile(file, JSON.stringify(two));
	expect((await lineOf(repo.dir, PORT_ID))?.text).toBe(PORT);

	await writeFile(
		file,
		JSON.stringify({
			...saved,
			version: 3,
			state: {
				...saved.state,
				lines: [{...saved.state.lines[0], text: 'edited in place'}],
			},
		}),
	);
	expect((await lineOf(repo.dir, PORT_ID))?.text).toBe(PORT);
	expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
		version: 4,
	});
});

test('a card line that only says none gets no state', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}\nFollow-up: none.\nGotcha: N/A`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	const state = await readCardState(repo.dir);
	expect(state.lines.map(line => line.id)).toEqual([PORT_ID]);
});

test('replacedBy skips a commit that a revert undid', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '♻️ Rewrite server', files: {'server.ts': 'serve()\n'}},
		{
			commit: '✨ Add a flag',
			files: {'server.ts': 'serve(flag)\n', 'flag.ts': 'flag\n'},
		},
	]);
	const rewrite = await rev(repo.dir, 'HEAD~1');
	// The revert keeps server.ts as the flag commit left it, so the newest
	// commit that touched server.ts is one the revert undid.
	await gitOutput(repo.dir, ['revert', '--no-commit', 'HEAD']);
	await gitOutput(repo.dir, ['checkout', 'HEAD', '--', 'server.ts']);
	await gitOutput(repo.dir, ['commit', '-q', '--no-edit']);

	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({
		state: 'in-doubt',
		replacedBy: rewrite,
	});
});

test('replacedBy skips a commit older than every source', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: {'server.ts': 'start\n'}},
	]);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'side']);
	await commit(repo.dir, '♻️ Rewrite server', {'server.ts': 'serve()\n'});
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await commit(repo.dir, `✨ Add port\n\nConstraint: ${PORT}`, {
		'server.ts': 'listen(3000)\n',
	});
	// The merge takes the side's server.ts, which was written before the
	// line was stated, so no commit on HEAD replaced the line's code.
	await gitOutput(repo.dir, [
		'merge',
		'-q',
		'--no-ff',
		'-X',
		'theirs',
		'-m',
		'Merge',
		'side',
	]);

	const line = await lineOf(repo.dir, PORT_ID);
	expect(line?.state).toBe('in-doubt');
	expect(line?.replacedBy).toBeUndefined();
});

test('with diff.relative on, a build from a subdirectory still gives replacedBy', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'src/server.ts': 'listen(3000)\n'},
		},
		{commit: '♻️ Rewrite server', files: {'src/server.ts': 'serve()\n'}},
	]);
	await gitOutput(repo.dir, ['config', 'diff.relative', 'true']);
	const line = await lineOf(path.join(repo.dir, 'src'), PORT_ID);
	expect(line).toMatchObject({
		state: 'in-doubt',
		files: ['src/server.ts'],
		replacedBy: await rev(repo.dir, 'HEAD'),
	});
});

test('a line restored by a revert of a revert is open', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	const stated = await rev(repo.dir, 'HEAD');
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);

	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({
		state: 'open',
		sources: [stated],
		files: ['server.ts'],
	});
});

test('once the restored code is replaced, the line is in doubt and replacedBy names the commit that replaced it', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	const rewrite = await commit(repo.dir, '♻️ Rewrite server', {
		'server.ts': 'serve()\n',
	});

	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({
		state: 'in-doubt',
		replacedBy: rewrite,
	});
});
