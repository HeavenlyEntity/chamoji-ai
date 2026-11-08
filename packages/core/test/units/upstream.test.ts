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
		trigger: 'manual',
		majors: 'auto',
		publish: null,
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

test("upstream's own merges and own branch merges are not syncs", async () => {
	const dir = (await createRepo([{commit: 'Base'}])).dir;
	try {
		// Upstream history with a PR-style merge in it.
		await git(dir, ['switch', '-q', '-c', 'tpl']);
		await commitFile(dir, 'tpl/a.txt', 'Template a');
		await git(dir, ['switch', '-q', '-c', 'tpl-pr', 'main']);
		await commitFile(dir, 'tpl/b.txt', 'Template b');
		await git(dir, ['switch', '-q', 'tpl']);
		await git(dir, ['merge', '--no-ff', '-q', '-m', 'Template PR', 'tpl-pr']);
		await git(dir, ['update-ref', 'refs/remotes/upstream/main', 'tpl']);
		// An own feature branch merged into main.
		await git(dir, ['switch', '-q', 'main']);
		await git(dir, ['switch', '-q', '-c', 'feature']);
		await commitFile(dir, 'apps/web/f.ts', 'Own feature');
		await git(dir, ['switch', '-q', 'main']);
		await git(dir, ['merge', '--no-ff', '-q', '-m', 'Own merge', 'feature']);
		// Then the sync, which carries the template's PR merge in.
		await git(dir, ['merge', '--no-ff', '-q', '-m', 'Sync', 'tpl']);
		const {syncs, commits} = await readUpstream(dir, 'HEAD', withUpstream, []);
		expect(syncs).toHaveLength(1);
		expect(syncs[0]!.hash).toBe(
			(await gitOutput(dir, ['rev-parse', 'HEAD'])).trim(),
		);
		const prMerge = (await gitOutput(dir, ['rev-parse', 'tpl'])).trim();
		expect(commits.has(prMerge)).toBe(true);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

/** A commit written by `email`, as a template's would be. */
async function commitAs(dir: string, email: string, name: string) {
	const file = path.join(dir, ...name.split('/'));
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, name);
	await git(dir, ['add', '--', name]);
	await git(dir, [
		'-c',
		'user.name=Template',
		'-c',
		`user.email=${email}`,
		'commit',
		'-q',
		'-m',
		`Template ${name}`,
	]);
}

/**
 * main is Base then Own; a template branch off Base gets two commits by
 * tpl@kit.dev (tagged 1.1.0 when `tag`), main merges it, and the branch is
 * deleted. upstream/main stays at Base, as when upstream prunes a branch.
 */
async function prunedTemplateBranch(tag: boolean) {
	const repo = await createRepo([{commit: 'Base'}, {commit: 'Own'}]);
	const {dir} = repo;
	await git(dir, ['update-ref', 'refs/remotes/upstream/main', 'HEAD~1']);
	await git(dir, ['switch', '-q', '-c', 'v3-step', 'HEAD~1']);
	await commitAs(dir, 'tpl@kit.dev', 'apps/web/one.ts');
	await commitAs(dir, 'tpl@kit.dev', 'apps/web/two.ts');
	if (tag) await git(dir, ['tag', '1.1.0']);
	const template = (await gitOutput(dir, ['rev-list', 'HEAD~2..HEAD']))
		.split('\n')
		.filter(Boolean);
	const short = (await gitOutput(dir, ['rev-parse', '--short', 'HEAD'])).trim();
	await git(dir, ['switch', '-q', 'main']);
	await git(dir, ['merge', '--no-ff', '-q', '-m', 'Merge v3-step', 'v3-step']);
	await git(dir, ['branch', '-q', '-D', 'v3-step']);
	const own = (await gitOutput(dir, ['rev-parse', 'HEAD~1'])).trim();
	return {repo, template, short, own};
}

test('with a remote, an ignored version tag still marks history the remote no longer has', async () => {
	const {repo, template, own} = await prunedTemplateBranch(true);
	try {
		const tags = await listTags(repo.dir, 'HEAD');
		const {commits, syncs} = await readUpstream(
			repo.dir,
			'HEAD',
			withUpstream,
			tags,
		);
		for (const hash of template) expect(commits.has(hash)).toBe(true);
		expect(commits.has(own)).toBe(false);
		expect(syncs.map(sync => sync.sync)).toEqual([
			{base: 'Makerkit', to: '1.1.0'},
		]);
	} finally {
		await repo.cleanup();
	}
});

test('with a remote, a stray ignored tag still marks nothing', async () => {
	const {repo, template} = await prunedTemplateBranch(false);
	try {
		await git(repo.dir, ['tag', 'wip/x', template[0]!]);
		const stray = settings({
			upstream: {remote: 'upstream', name: 'Makerkit'},
			tags: {ignore: ['^wip/'], aliases: {}},
		});
		const tags = await listTags(repo.dir, 'HEAD');
		const {commits, syncs} = await readUpstream(repo.dir, 'HEAD', stray, tags);
		for (const hash of template) expect(commits.has(hash)).toBe(false);
		expect(syncs).toEqual([]);
	} finally {
		await repo.cleanup();
	}
});

test('upstream.authors marks their commits on HEAD, ignoring case, and a merge of them is a sync', async () => {
	const {repo, template, short, own} = await prunedTemplateBranch(false);
	try {
		const byAuthor = settings({
			upstream: {
				remote: 'upstream',
				name: 'Makerkit',
				authors: ['TPL@Kit.dev'],
			},
		});
		const before = await readUpstream(repo.dir, 'HEAD', withUpstream, []);
		for (const hash of template) expect(before.commits.has(hash)).toBe(false);
		expect(before.syncs).toEqual([]);

		const {commits, syncs} = await readUpstream(repo.dir, 'HEAD', byAuthor, []);
		for (const hash of template) expect(commits.has(hash)).toBe(true);
		expect(commits.has(own)).toBe(false);
		expect(syncs.map(sync => sync.sync)).toEqual([
			{base: 'Makerkit', to: short},
		]);
	} finally {
		await repo.cleanup();
	}
});

test('upstream.authors works without a remote too', async () => {
	const {repo, template, own} = await prunedTemplateBranch(false);
	try {
		await git(repo.dir, ['update-ref', '-d', 'refs/remotes/upstream/main']);
		const byAuthor = settings({
			upstream: {name: 'Makerkit', authors: ['tpl@kit.dev']},
		});
		const {commits} = await readUpstream(repo.dir, 'HEAD', byAuthor, []);
		expect([...commits].sort()).toEqual([...template].sort());
		expect(commits.has(own)).toBe(false);
	} finally {
		await repo.cleanup();
	}
});
