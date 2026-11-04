import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {
	detectTags,
	detectLayout,
	detectUpstream,
	findUpstreamRemote,
} from '../../src/index.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../helpers/fixture-repo.js';
import {gearzLayout} from '../helpers/setup-fixtures.js';

const execFileAsync = promisify(execFile);

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const git = async (dir: string, args: string[]) =>
	execFileAsync('git', args, {cwd: dir});

async function upstreamOf(dir: string) {
	const layout = await detectLayout(dir);
	const remote = await findUpstreamRemote(dir);
	const tags = await detectTags(layout, remote);
	return detectUpstream(dir, remote, tags.inherited.tags);
}

test('a fork with an upstream remote: since is the first own commit, 30 upstream commits, no sync yet', async () => {
	repo = await gearzLayout({template: true});
	const found = await upstreamOf(repo.dir);
	const first = (
		await gitOutput(repo.dir, [
			'log',
			'--reverse',
			'--author=Gearz Dev',
			'--format=%H',
		])
	).split('\n')[0];
	expect(found).toMatchObject({
		remote: 'upstream',
		fetched: true,
		name: 'Makerkit',
		since: first,
		upstreamCommits: 30,
		syncs: 0,
		squashedSyncs: [],
	});
});

test('a real merge from upstream counts as one sync', async () => {
	repo = await gearzLayout({template: true, sync: true});
	const found = await upstreamOf(repo.dir);
	expect(found.upstreamCommits).toBe(33);
	expect(found.syncs).toBe(1);
	expect(found.squashedSyncs).toEqual([]);
});

test("the base name comes from the remote URL's owner, title-cased", async () => {
	repo = await createRepo([{commit: '🎉 Start'}]);
	const fork = async (url: string) => {
		await git(repo!.dir, ['remote', 'remove', 'upstream']).catch(() => {});
		await git(repo!.dir, ['remote', 'add', 'upstream', url]);
		return (await detectUpstream(repo!.dir, 'upstream', [])).name;
	};

	expect(
		await fork('https://github.com/makerkit/next-supabase-saas-kit-turbo.git'),
	).toBe('Makerkit');
	expect(
		await fork('git@github.com:makerkit/next-supabase-saas-kit-turbo.git'),
	).toBe('Makerkit');
	expect(await fork('https://example.com/solo.git')).toBe('Solo');
});

test('an upstream remote with nothing fetched is reported, and since stays null', async () => {
	repo = await createRepo([{commit: '🎉 Start'}, {commit: '✨ Add a thing'}]);
	await git(repo.dir, [
		'remote',
		'add',
		'upstream',
		'https://github.com/makerkit/next-supabase-saas-kit-turbo.git',
	]);
	expect(await upstreamOf(repo.dir)).toEqual({
		remote: 'upstream',
		fetched: false,
		name: 'Makerkit',
		since: null,
		upstreamCommits: 0,
		syncs: 0,
		squashedSyncs: [],
	});
});

test('a squash-merged sync is listed', async () => {
	repo = await gearzLayout({
		template: true,
		extraSteps: [
			{commit: '✨ Add the crm pipeline'},
			{commit: '🔀 Merge upstream Makerkit 4.0.3'},
			{commit: '✨ Add invoices'},
		],
	});
	const found = await upstreamOf(repo.dir);
	const short = (
		await gitOutput(repo.dir, [
			'log',
			'-1',
			'--format=%h',
			'--grep=Merge upstream',
		])
	).trim();
	expect(found.squashedSyncs).toEqual([short]);
	expect(found.syncs).toBe(0);
});

test('a repo with inherited tags but no remote still gets a starting point', async () => {
	repo = await createRepo([
		{commit: 'Inherited'},
		{tag: '1.0.0'},
		{commit: 'Own work'},
	]);
	const own = (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim();
	expect(await detectUpstream(repo.dir, null, ['1.0.0'])).toEqual({
		remote: null,
		fetched: false,
		name: null,
		since: own,
		upstreamCommits: 0,
		syncs: 0,
		squashedSyncs: [],
	});
});

test('no remote and no inherited tags: nothing applies', async () => {
	repo = await createRepo([{commit: '🎉 Start'}]);
	expect(await detectUpstream(repo.dir, null, [])).toEqual({
		remote: null,
		fetched: false,
		name: null,
		since: null,
		upstreamCommits: 0,
		syncs: 0,
		squashedSyncs: [],
	});
});
