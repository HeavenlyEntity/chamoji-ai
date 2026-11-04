import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {DEFAULT_GROUP_CONFIG} from '../../src/config.js';
import {groupCommits} from '../../src/group.js';
import {listTags} from '../../src/git.js';
import type {ReleaseSettings} from '../../src/index.js';
import {readUpstream, sinceRange, syncFiles} from '../../src/units/upstream.js';
import {commit} from '../helpers/commit.js';
import {createRepo, gitOutput, type RepoStep} from '../helpers/fixture-repo.js';

const execFileAsync = promisify(execFile);

function settings(over: Partial<ReleaseSettings> = {}): ReleaseSettings {
	return {
		schema: 1,
		shape: 'apps',
		units: [],
		exclude: [],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		fixed: [],
		tags: {ignore: [], aliases: {}},
		rootChangelog: false,
		githubReleases: 'per-unit',
		...over,
	};
}

const withUpstream = settings({
	upstream: {remote: 'upstream', name: 'Makerkit'},
	tags: {ignore: ['^\\d+\\.\\d+\\.\\d+$'], aliases: {}},
});

let upstreamRepo: Awaited<ReturnType<typeof createRepo>>;
let cloneDir: string;
let upstreamHashes: string[];
let ownHashes: string[];

let day = 100;
// Fixed dates keep every hash deterministic.
async function git(dir: string, args: string[]) {
	const when = new Date(
		Date.UTC(2026, 0, 1) + day++ * 86_400_000,
	).toISOString();
	await execFileAsync('git', args, {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: when,
			GIT_COMMITTER_DATE: when,
			GIT_CONFIG_NOSYSTEM: '1',
		},
	});
}

async function commitFile(dir: string, name: string, message: string) {
	const file = path.join(dir, ...name.split('/'));
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, message);
	await git(dir, ['add', '--', name]);
	await git(dir, ['commit', '-q', '-m', message]);
}

beforeAll(async () => {
	const steps: RepoStep[] = [];
	for (let i = 1; i <= 30; i++) {
		steps.push({commit: `Upstream change ${i}`});
		if (i === 10) steps.push({tag: '4.0.1', annotated: true});
		if (i === 30) steps.push({tag: '4.0.2', annotated: true});
	}

	upstreamRepo = await createRepo(steps);
	const parent = await mkdtemp(path.join(tmpdir(), 'chamoji-clone-'));
	cloneDir = path.join(parent, 'app');
	await git(parent, ['clone', '-q', upstreamRepo.dir, 'app']);
	await git(cloneDir, ['remote', 'rename', 'origin', 'upstream']);
	for (const [key, value] of [
		['user.name', 'Dev'],
		['user.email', 'dev@example.com'],
		['commit.gpgsign', 'false'],
		['tag.gpgsign', 'false'],
	] as const) {
		await git(cloneDir, ['config', key, value]);
	}

	await commitFile(cloneDir, 'apps/web/a.ts', '✨ Add the dashboard');
	await commitFile(cloneDir, 'apps/web/b.ts', '🐛 Fix the dashboard');

	for (let i = 31; i <= 32; i++) {
		await commitFile(upstreamRepo.dir, `src/u${i}.ts`, `Upstream change ${i}`);
	}

	await commitFile(upstreamRepo.dir, 'apps/web/x.ts', 'Upstream change 33');
	await git(upstreamRepo.dir, ['tag', '-a', '4.0.3', '-m', '4.0.3']);

	await git(cloneDir, ['fetch', '-q', 'upstream']);
	await git(cloneDir, [
		'merge',
		'--no-ff',
		'-q',
		'-m',
		'Merge upstream/main',
		'upstream/main',
	]);

	upstreamHashes = (await gitOutput(upstreamRepo.dir, ['rev-list', 'HEAD']))
		.split('\n')
		.filter(Boolean);
	ownHashes = (await gitOutput(cloneDir, ['rev-list', '--no-merges', 'HEAD']))
		.split('\n')
		.filter(hash => hash && !upstreamHashes.includes(hash));
});

afterAll(async () => {
	await upstreamRepo.cleanup();
	await rm(path.dirname(cloneDir), {recursive: true, force: true});
});

test('upstream commits are every commit reachable from the remote', async () => {
	const tags = await listTags(cloneDir, 'HEAD');
	const {commits} = await readUpstream(cloneDir, 'HEAD', withUpstream, tags);
	expect(upstreamHashes).toHaveLength(33);
	expect(ownHashes).toHaveLength(2);
	expect([...commits].sort()).toEqual([...upstreamHashes].sort());
	for (const hash of ownHashes) expect(commits.has(hash)).toBe(false);
});

test('a sync merge becomes one synthetic commit', async () => {
	const tags = await listTags(cloneDir, 'HEAD');
	const {syncs} = await readUpstream(cloneDir, 'HEAD', withUpstream, tags);
	expect(syncs).toHaveLength(1);
	const [sync] = syncs;
	expect(sync!.description).toBe('Updated the Makerkit base to 4.0.3');
	expect(sync!.gitmoji).toBe('arrow_up');
	expect(sync!.gitmojiSource).toBe('gitmoji');
	expect(sync!.sync).toEqual({base: 'Makerkit', to: '4.0.3'});
	expect(sync!.breaking).toBe(false);
	expect(sync!.hash).toBe(
		(await gitOutput(cloneDir, ['rev-parse', 'HEAD'])).trim(),
	);
	expect(await syncFiles(cloneDir, sync!)).toContain('apps/web/x.ts');
});

test('a sync with no inherited tag names the merged commit', async () => {
	const dir = (await createRepo([{commit: 'Base'}, {commit: 'Own'}])).dir;
	try {
		await git(dir, ['switch', '-q', '-c', 'tpl', 'HEAD~1']);
		await commitFile(dir, 'tpl.txt', 'Template change');
		const tip = (await gitOutput(dir, ['rev-parse', '--short', 'HEAD'])).trim();
		await git(dir, ['switch', '-q', 'main']);
		await git(dir, ['update-ref', 'refs/remotes/upstream/main', 'tpl']);
		await git(dir, ['merge', '--no-ff', '-q', '-m', 'Sync', 'tpl']);
		const {syncs} = await readUpstream(dir, 'HEAD', withUpstream, []);
		expect(syncs.map(s => s.sync)).toEqual([{base: 'Makerkit', to: tip}]);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test('without a remote, ignored tags mark upstream history', async () => {
	const dir = path.join(path.dirname(cloneDir), 'noremote');
	await git(path.dirname(cloneDir), ['clone', '-q', cloneDir, 'noremote']);
	await git(dir, ['remote', 'remove', 'origin']);
	const none = settings({
		upstream: {name: 'Makerkit'},
		tags: {ignore: ['^\\d+\\.\\d+\\.\\d+$'], aliases: {}},
	});
	const tags = await listTags(dir, 'HEAD');
	const {commits} = await readUpstream(dir, 'HEAD', none, tags);
	// The pattern matches 4.0.1 to 4.0.3; 4.0.3 reaches everything the others do.
	const reachable = (await gitOutput(dir, ['rev-list', '4.0.3']))
		.split('\n')
		.filter(Boolean);
	const throughTwo = (await gitOutput(dir, ['rev-list', '4.0.2']))
		.split('\n')
		.filter(Boolean);
	expect(throughTwo).toHaveLength(30);
	for (const hash of throughTwo) expect(commits.has(hash)).toBe(true);
	expect([...commits].sort()).toEqual(reachable.sort());
	for (const hash of ownHashes) expect(commits.has(hash)).toBe(false);
});

test("without a remote, a stray ignored tag doesn't mark own commits", async () => {
	const dir = path.join(path.dirname(cloneDir), 'stray');
	await git(path.dirname(cloneDir), ['clone', '-q', cloneDir, 'stray']);
	await git(dir, ['remote', 'remove', 'origin']);
	await git(dir, ['tag', 'wip/x', ownHashes[0]!]);
	const stray = settings({
		upstream: {name: 'Makerkit'},
		tags: {ignore: ['^wip/'], aliases: {}},
	});
	const tags = await listTags(dir, 'HEAD');
	const {commits, syncs} = await readUpstream(dir, 'HEAD', stray, tags);
	expect(commits.size).toBe(0);
	expect(syncs).toEqual([]);
});

test('with no upstream setting and no ignored tags, nothing is upstream', async () => {
	const tags = await listTags(cloneDir, 'HEAD');
	const result = await readUpstream(cloneDir, 'HEAD', settings(), tags);
	expect(result.commits.size).toBe(0);
	expect(result.syncs).toEqual([]);
});

test('sinceRange starts at the parent of upstream.since', async () => {
	const since = ownHashes.at(-1)!;
	const range = await sinceRange(
		cloneDir,
		settings({upstream: {name: 'Makerkit', since}}),
	);
	expect(range).toBe(`${since}^..HEAD`);
	expect(await sinceRange(cloneDir, settings())).toBeUndefined();
	expect(
		await sinceRange(cloneDir, settings({upstream: {name: 'Makerkit'}})),
	).toBeUndefined();
});

test('sinceRange is HEAD when since is a root commit', async () => {
	const root = (
		await gitOutput(cloneDir, ['rev-list', '--max-parents=0', 'HEAD'])
	).trim();
	expect(
		await sinceRange(
			cloneDir,
			settings({upstream: {name: 'Makerkit', since: root}}),
		),
	).toBe('HEAD');
});

test('a sync line is never collapsed', async () => {
	const sync = {
		...commit('⬆️ Updated the Makerkit base to 4.0.3'),
		description: 'Updated the Makerkit base to 4.0.3',
		sync: {base: 'Makerkit', to: '4.0.3'},
	};
	const groups = groupCommits(
		[sync, commit('⬆️ Bump react to 19'), commit('⬆️ Bump vitest to 4')],
		DEFAULT_GROUP_CONFIG,
	);
	const changed = groups.find(g => g.group === 'changed');
	expect(changed?.commits).toEqual([sync]);
	const dependencies = groups.find(g => g.group === 'dependencies');
	expect(dependencies?.collapse).toBe(true);
	expect(dependencies?.commits).toHaveLength(2);
});
