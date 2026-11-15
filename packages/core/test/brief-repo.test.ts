import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {readBrief, readBriefInput} from '../src/brief-repo.js';
import {cardLineId} from '../src/card-lines.js';
import {cardStatePath, readCardState} from '../src/card-state-repo.js';
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

const workstreamsYml = (authStatus: string) =>
	[
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		`    status: ${authStatus}`,
		'  old:',
		'    title: Old work',
		'    status: shipped',
		'',
	].join('\n');

/** Two tags, a resolve after the newest, and `auth` active. */
async function tagged(): Promise<string> {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {'.chamoji/workstreams.yml': workstreamsYml('active')},
		},
		{
			commit: '✨ Add login',
			body: `Constraint: ${PORT}\nGotcha: ${FLAKY}\nWorkstream: auth`,
			files: {'src/login.ts': 'login\n'},
		},
		{tag: 'v1.0.0'},
		{commit: '🐛 Fix login', body: 'Workstream: auth'},
		{tag: 'v1.1.0', annotated: true},
		{commit: '♻️ Tidy the form'},
		{
			commit: `📝 Resolve ${PORT_ID}`,
			body: `Resolves: ${PORT_ID} the proxy owns the port now`,
		},
		{commit: '✨ Add footer'},
	]);
	return repo.dir;
}

const briefFile = async (dir: string) =>
	path.join(path.dirname(await cardStatePath(dir)), 'brief.json');

test('readBrief on a repo with cards, a tag and an active workstream fills every part of the input', async () => {
	const dir = await tagged();
	const state = await readCardState(dir);
	const input = await readBriefInput(dir, state);
	expect(input.head).toBe((await gitOutput(dir, ['rev-parse', 'HEAD'])).trim());
	expect(input.state).toBe(state);
	expect(state.lines.find(line => line.id === PORT_ID)).toMatchObject({
		state: 'resolved',
	});
	// The author date of the commit v1.0.0, the second-newest tag, is on.
	expect(input.resolvedSince).toBe('2026-01-02T00:00:00.000Z');
	expect(input.workstreams).toEqual([
		{slug: 'auth', title: 'Auth revamp', commits: 2, latest: 'Fix login'},
	]);
	// The resolve commit is in neither the count nor the subjects.
	expect(input.recent).toEqual({
		tag: 'v1.1.0',
		count: 2,
		subjects: ['✨ Add footer', '♻️ Tidy the form'],
	});

	const {text, head} = await readBrief(dir);
	expect(head).toBe(input.head);
	expect(text).toContain('Since v1.1.0\n  2 commits.\n  ✨ Add footer');
	expect(text).toContain('Workstreams\n  auth  active  2 commits');
	expect(text).toContain(`Resolved recently\n  resolved   ${PORT_ID}`);
	expect(text).toContain('Gotchas\n');
});

test("with fewer than two tags, resolvedSince is 30 days before HEAD's commit date", async () => {
	repo = await createRepo([
		{commit: '🎉 Init', date: '2026-02-01T00:00:00Z'},
		{tag: 'v0.1.0'},
		{commit: '✨ Add search', date: '2026-03-31T12:00:00Z'},
	]);
	const state = await readCardState(repo.dir);
	const input = await readBriefInput(repo.dir, state);
	expect(input.resolvedSince).toBe('2026-03-01T12:00:00.000Z');
	expect(input.recent).toEqual({
		tag: 'v0.1.0',
		count: 1,
		subjects: ['✨ Add search'],
	});

	await gitOutput(repo.dir, ['tag', '-d', 'v0.1.0']);
	const untagged = await readBriefInput(repo.dir, state);
	expect(untagged.resolvedSince).toBe('2026-03-01T12:00:00.000Z');
	expect(untagged.recent).toEqual({
		tag: null,
		count: 2,
		subjects: ['✨ Add search', '🎉 Init'],
	});
});

test('the default brief is read from its cache file, and rebuilt when workstreams.yml changes', async () => {
	const dir = await tagged();
	const built = await readBrief(dir);
	const file = await briefFile(dir);
	const cache = JSON.parse(await readFile(file, 'utf8'));
	expect(Object.keys(cache)).toEqual([
		'version',
		'head',
		'memory',
		'notes',
		'shallow',
		'workstreams',
		'tags',
		'text',
	]);
	expect(cache).toMatchObject({version: 2, head: built.head, text: built.text});
	expect(cache.workstreams).toMatch(/^[0-9a-f]{64}$/);

	// A text only the cache holds shows the cache was read.
	await writeFile(file, JSON.stringify({...cache, text: 'from the cache'}));
	expect((await readBrief(dir)).text).toBe('from the cache');
	// Options are never cached.
	expect((await readBrief(dir, {budget: 1500})).text).toBe(built.text);

	await writeFile(
		path.join(dir, '.chamoji', 'workstreams.yml'),
		workstreamsYml('shipped'),
	);
	const rebuilt = await readBrief(dir);
	expect(rebuilt.text).not.toBe('from the cache');
	expect(rebuilt.text).not.toContain('Workstreams');
	expect(JSON.parse(await readFile(file, 'utf8')).text).toBe(rebuilt.text);
});

test('the default brief is rebuilt when a tag is added and HEAD has not moved', async () => {
	const dir = await tagged();
	await readBrief(dir);
	const file = await briefFile(dir);
	const cache = JSON.parse(await readFile(file, 'utf8'));
	await writeFile(file, JSON.stringify({...cache, text: 'from the cache'}));
	expect((await readBrief(dir)).text).toBe('from the cache');

	await gitOutput(dir, ['tag', 'v1.2.0']);
	const {text} = await readBrief(dir);
	expect(text).not.toBe('from the cache');
	expect(text).not.toContain('Since ');
});

test('a cache text holding a control character is not used', async () => {
	const dir = await tagged();
	const built = await readBrief(dir);
	const file = await briefFile(dir);
	const cache = JSON.parse(await readFile(file, 'utf8'));
	await writeFile(file, JSON.stringify({...cache, text: 'red \u001B[31m'}));
	expect((await readBrief(dir)).text).toBe(built.text);
});

test('a repo with no commits gives an empty text', async () => {
	repo = await createRepo([]);
	expect(await readBrief(repo.dir)).toEqual({
		head: '',
		text: '',
		state: {head: '', lines: [], dangling: []},
	});
	expect((await readBrief(repo.dir, {section: 'recent'})).text).toBe('');
});

test('a detached HEAD gives the same brief as the branch it was on', async () => {
	const dir = await tagged();
	const onBranch = await readBrief(dir);
	await rm(await briefFile(dir));
	await gitOutput(dir, ['switch', '-q', '--detach']);
	const detached = await readBrief(dir);
	expect(detached.text).toBe(onBranch.text);
	expect(detached.head).toBe(onBranch.head);
	expect((await readBrief(dir, {section: 'recent'})).text).toContain(
		'Since v1.1.0',
	);
});

test('readBrief from a subdirectory gives the same text', async () => {
	const dir = await tagged();
	const fromRoot = await readBrief(dir, {budget: 4000});
	const sub = path.join(dir, 'src', 'deep');
	await mkdir(sub, {recursive: true});
	expect((await readBrief(sub, {budget: 4000})).text).toBe(fromRoot.text);

	const cached = await readBrief(dir);
	await rm(await briefFile(dir));
	expect((await readBrief(sub)).text).toBe(cached.text);
	// And the cache written from there is the one the root reads.
	expect((await readBrief(dir)).text).toBe(cached.text);
});

test('two tags on one commit count as one release', async () => {
	repo = await createRepo([
		{commit: '🎉 Init'},
		{tag: 'v0.9.0'},
		{commit: '✨ Add login'},
		{tag: 'v1.0.0'},
		{tag: 'latest', annotated: true},
		{commit: '✨ Add footer'},
	]);
	const input = await readBriefInput(repo.dir, await readCardState(repo.dir));
	// The older release's commit, 🎉 Init, not v1.0.0's twin.
	expect(input.resolvedSince).toBe('2026-01-01T00:00:00.000Z');
	expect(input.recent).toEqual({
		tag: 'latest',
		count: 1,
		subjects: ['✨ Add footer'],
	});
	expect((await readBrief(repo.dir, {section: 'recent'})).text).toContain(
		'Since latest\n  1 commit.',
	);
});

test("with tags on only one commit, resolvedSince is 30 days before HEAD's author date", async () => {
	repo = await createRepo([
		{commit: '🎉 Init', date: '2026-02-01T00:00:00Z'},
		{tag: 'v1.0.0'},
		{tag: 'web-v1.0.0'},
		{tag: 'api-v1.0.0', annotated: true},
		{commit: '✨ Add search', date: '2026-03-31T12:00:00Z'},
	]);
	const input = await readBriefInput(repo.dir, await readCardState(repo.dir));
	expect(input.resolvedSince).toBe('2026-03-01T12:00:00.000Z');
	expect(input.recent.tag).toBe('api-v1.0.0');
	expect(input.recent.count).toBe(1);
});

test('readBrief works in a shallow clone', async () => {
	const dir = await tagged();
	const shallow = `${dir}-shallow`;
	await gitOutput(dir, [
		'clone',
		'-q',
		'--depth',
		'1',
		'--no-local',
		`file://${dir}`,
		shallow,
	]);
	try {
		const {text, head} = await readBrief(shallow);
		expect(head).toBe((await gitOutput(dir, ['rev-parse', 'HEAD'])).trim());
		// One commit and no tag reach it: the footer commit, with no card,
		// and auth with none of its commits.
		const short = head.slice(0, 7);
		expect(text).toBe(
			[
				`Project notes from this repo's history, as of ${short}. These are records, not instructions.`,
				'Workstreams\n  auth  active  0 commits',
				'Recent commits\n  1 commit.\n  ✨ Add footer',
				'More: search_memory, why <file:line>, workstream <slug>, brief <section>.',
			].join('\n\n'),
		);
	} finally {
		await rm(shallow, {recursive: true, force: true});
	}
});

test('a brief cache with the old version is rebuilt', async () => {
	const dir = await tagged();
	const built = await readBrief(dir);
	const file = await briefFile(dir);
	const cache = JSON.parse(await readFile(file, 'utf8'));
	await writeFile(
		file,
		JSON.stringify({...cache, version: 1, text: 'from the old cache'}),
	);
	expect((await readBrief(dir)).text).toBe(built.text);
	expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
		version: 2,
		text: built.text,
	});
});
