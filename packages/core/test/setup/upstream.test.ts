import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {
	detect,
	detectTags,
	detectLayout,
	detectUpstream,
	findUpstreamRemote,
	loadConfig,
	planUnitReleases,
	recommend,
	releaseSection,
	unitChangelog,
} from '../../src/index.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../helpers/fixture-repo.js';
import {
	CONTRIBUTOR_SUBJECTS,
	forkWorkflow,
	gearzLayout,
	PRUNED_SUBJECTS,
} from '../helpers/setup-fixtures.js';
import {valid} from '../helpers/setup-detection.js';

const execFileAsync = promisify(execFile);

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const git = async (dir: string, args: string[]) =>
	execFileAsync('git', args, {cwd: dir});

/** The fork's first commit, by Gearz Dev. */
const firstOwn = async (dir: string) =>
	(
		await gitOutput(dir, [
			'log',
			'--reverse',
			'--author=Gearz Dev',
			'--format=%H',
		])
	).split('\n')[0];

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
		// The remote and the inherited tags reach every template commit, so
		// no author needs naming: this is also how a fork-workflow clone looks.
		authors: [],
	});
});

test('a real merge from upstream counts as one sync', async () => {
	repo = await gearzLayout({template: true, sync: true});
	const found = await upstreamOf(repo.dir);
	expect(found.since).toBe(await firstOwn(repo.dir));
	expect(found.upstreamCommits).toBe(33);
	expect(found.syncs).toBe(1);
	expect(found.squashedSyncs).toEqual([]);
	expect(found.authors).toEqual([]);
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
		authors: [],
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
	expect(found.since).toBe(await firstOwn(repo.dir));
	expect(found.upstreamCommits).toBe(30);
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
		upstreamCommits: 1,
		syncs: 0,
		squashedSyncs: [],
		authors: [],
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
		authors: [],
	});
});

const TODAY = '2026-11-04';

for (const kind of ['tagged', 'untagged'] as const) {
	test(`a template branch merged and then pruned from upstream (${kind}) stays out of every note`, async () => {
		repo = await gearzLayout({template: true, prunedBranch: kind});
		const detection = await detect(repo.dir);
		if (kind === 'tagged') {
			expect(detection.tags.inherited.tags).toContain('4.1.0');
		}

		expect(detection.upstream).toMatchObject({
			remote: 'upstream',
			since: await firstOwn(repo.dir),
			upstreamCommits: 32,
			syncs: 1,
			authors: [{email: 'bot@makerkit.dev', name: 'Makerkit Bot', commits: 32}],
		});
		const answers = recommend(detection);
		expect(answers.upstream?.authors).toEqual(['bot@makerkit.dev']);
		const config = {
			...(await loadConfig(repo.dir)),
			release: valid(releaseSection(answers)),
		};
		const plan = await planUnitReleases({
			cwd: repo.dir,
			config,
			today: TODAY,
		});
		expect(plan.status).toBe('ready');
		const web =
			plan.status === 'ready'
				? plan.units.find(unit => unit.unit === 'web')
				: undefined;
		expect(web?.notes).toContain('✨ Add invoices');
		const to = kind === 'tagged' ? '4.1.0' : '';
		expect(web?.notes).toContain(`Updated the Makerkit base to ${to}`);
		const changelog = JSON.stringify(
			await unitChangelog({cwd: repo.dir, config, unit: 'web'}),
		);
		expect(changelog).toContain('Add invoices');
		for (const subject of [...PRUNED_SUBJECTS, 'Update the kit']) {
			expect(web?.notes).not.toContain(subject);
			expect(changelog).not.toContain(subject);
		}
	});
}

for (const teamAfterLastTag of [true, false]) {
	const kind = teamAfterLastTag
		? 'the team committed after the last tag'
		: "the contributor's commits are the only ones after the last tag";
	test(`a fork-workflow clone (${kind}) names no template authors and hides no own commit`, async () => {
		repo = await forkWorkflow({teamAfterLastTag});
		const detection = await detect(repo.dir);
		expect(detection.upstream.authors).toEqual([]);
		// The canonical-repo guard fires only when the team's own recent
		// commits reach a release.
		expect(detection.tags.canonical).toBe(teamAfterLastTag);
		const answers = recommend(detection);
		expect(answers.upstream).toBeDefined();
		expect(answers.upstream).not.toHaveProperty('authors');
		const config = {
			...(await loadConfig(repo.dir)),
			release: valid(releaseSection(answers)),
		};
		const dir = repo.dir;
		const expectOwn = async (subjects: string[]) => {
			const plan = await planUnitReleases({cwd: dir, config, today: TODAY});
			expect(plan.status).toBe('ready');
			const web =
				plan.status === 'ready'
					? plan.units.find(unit => unit.unit === 'web')
					: undefined;
			const changelog = JSON.stringify(
				await unitChangelog({cwd: dir, config, unit: 'web'}),
			);
			for (const subject of subjects) {
				expect(web?.notes).toContain(subject);
				expect(changelog).toContain(subject.replace(/^✨ /, ''));
			}
		};

		await expectOwn(CONTRIBUTOR_SUBJECTS);
		// The same section in a checkout with no remote, as CI on the
		// canonical repo is, where Alice keeps shipping.
		await git(dir, ['remote', 'remove', 'upstream']);
		await writeFile(path.join(dir, 'apps/web/checkout.ts'), 'checkout\n');
		await git(dir, ['add', '--', 'apps/web/checkout.ts']);
		await git(dir, [
			'-c',
			'user.name=Alice',
			'-c',
			'user.email=alice@team.example',
			'commit',
			'-q',
			'-m',
			'✨ Ship the checkout',
		]);
		await expectOwn([...CONTRIBUTOR_SUBJECTS, '✨ Ship the checkout']);
	});
}
