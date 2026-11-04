import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {
	detectLayout,
	detectTags,
	findUpstreamRemote,
	matchesTagPattern,
	type TagDetection,
} from '../../src/index.js';
import {
	createRepo,
	type FixtureRepo,
	type RepoStep,
} from '../helpers/fixture-repo.js';
import {gearzLayout, libraryLayout} from '../helpers/setup-fixtures.js';

const execFileAsync = promisify(execFile);

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const TEMPLATE_TAGS = ['4.0.1', '4.0.2', 'v4.0.2-1'];

const git = async (dir: string, args: string[]) =>
	execFileAsync('git', args, {cwd: dir});

async function tagsOf(dir: string): Promise<TagDetection> {
	const layout = await detectLayout(dir);
	return detectTags(layout, await findUpstreamRemote(dir));
}

/** One commit, then a tag on it, for each tag. */
const tagged = (...tags: string[]): RepoStep[] =>
	tags.flatMap(tag => [{commit: `🔖 Release ${tag}`}, {tag}]);

const ignoredBy = (tag: string, patterns: string[]): string[] =>
	patterns.filter(pattern => matchesTagPattern(tag, pattern));

/** Every ignore pattern setup would propose. */
const allPatterns = (found: TagDetection): string[] => [
	...found.inherited.patterns,
	...found.stray.patterns,
];

test('Makerkit tags reached from the upstream remote are inherited, as two shape patterns', async () => {
	repo = await gearzLayout({template: true});
	expect(await findUpstreamRemote(repo.dir)).toBe('upstream');
	const found = await tagsOf(repo.dir);
	expect([...found.inherited.tags].sort()).toEqual(TEMPLATE_TAGS);
	expect(found.inherited.patterns).toEqual([
		'^\\d+\\.\\d+\\.\\d+$',
		'^v\\d+\\.\\d+\\.\\d+-\\d+$',
	]);
	expect(found.inherited.examples).toEqual(['v4.0.2-1', '4.0.2', '4.0.1']);
});

test("without a remote, tags only the template's authors can reach are inherited", async () => {
	repo = await gearzLayout({
		template: true,
		extraSteps: [...tagged('1.0.0'), {commit: '✨ Add the CRM'}],
	});
	await git(repo.dir, ['remote', 'remove', 'upstream']);
	expect(await findUpstreamRemote(repo.dir)).toBeNull();
	const found = await tagsOf(repo.dir);
	expect([...found.inherited.tags].sort()).toEqual(TEMPLATE_TAGS);
	expect(found.inherited.tags).not.toContain('1.0.0');
});

test('without a remote, a fork released at HEAD takes its newest authors as recent', async () => {
	const work: RepoStep[] = Array.from({length: 50}, (_, n) => ({
		commit: `✨ Build feature ${n + 1}`,
	}));
	repo = await gearzLayout({
		template: true,
		extraSteps: [...work, {tag: '1.0.0'}],
	});
	await git(repo.dir, ['remote', 'remove', 'upstream']);
	const found = await tagsOf(repo.dir);
	expect([...found.inherited.tags].sort()).toEqual(TEMPLATE_TAGS);
});

test('an app that tags plain versions itself gets one shape pattern that leaves its own tags out', async () => {
	repo = await gearzLayout({template: true, extraSteps: tagged('1.0.0')});
	const found = await tagsOf(repo.dir);
	expect([...found.inherited.tags].sort()).toEqual(TEMPLATE_TAGS);
	expect(found.inherited.patterns).toEqual([
		String.raw`^(?!(?:1\.0\.0)$)\d+\.\d+\.\d+$`,
		String.raw`^v\d+\.\d+\.\d+-\d+$`,
	]);
	expect(ignoredBy('1.0.0', found.inherited.patterns)).toEqual([]);
	// The template's next tags are still ignored; only the exact own tag is
	// spared, not one it is a prefix or suffix of.
	for (const tag of [...TEMPLATE_TAGS, '4.0.3', '11.0.0', '1.0.01']) {
		expect(ignoredBy(tag, found.inherited.patterns)).not.toEqual([]);
	}
});

test('wip/* tags are stray with one prefix pattern', async () => {
	repo = await gearzLayout({template: true});
	const found = await tagsOf(repo.dir);
	expect(found.stray).toEqual({
		tags: ['wip/crm-pipeline-stages'],
		patterns: ['^wip/'],
	});
});

test("mixed historical web tags are read, and the newest one's format is recommended", async () => {
	repo = await gearzLayout({
		extraSteps: tagged('web-v1.2', 'web/v1.3.0', 'final-release'),
	});
	const found = await tagsOf(repo.dir);
	expect(found.perUnit.web).toEqual({
		write: 'web/v{version}',
		read: ['web-v{version}'],
		last: {tag: 'web/v1.3.0', version: '1.3.0'},
		unparseable: [],
		manifestDisagrees: true,
	});
	expect(found.stray).toEqual({
		tags: ['final-release'],
		patterns: ['^final-release$'],
	});
	expect(found.inherited.tags).toEqual([]);
	// A unit with no tags gets the apps default.
	expect(found.perUnit.mobile).toEqual({
		write: '{unit}/v{version}',
		read: [],
		last: null,
		unparseable: [],
		manifestDisagrees: false,
	});
});

test('a web tag with no version is unparseable', async () => {
	repo = await gearzLayout({extraSteps: tagged('web/v0.1.0', 'web-final')});
	const found = await tagsOf(repo.dir);
	expect(found.perUnit.web!.unparseable).toEqual(['web-final']);
	expect(found.perUnit.web!.last).toEqual({
		tag: 'web/v0.1.0',
		version: '0.1.0',
	});
	expect(found.stray.tags).toEqual([]);
});

test('a tag that disagrees with the manifest is flagged', async () => {
	repo = await gearzLayout({
		extraSteps: tagged('web/v0.2.0', 'mobile/v1.0'),
	});
	const found = await tagsOf(repo.dir);
	// web's manifest says 0.1.0; mobile's 1.0.0 matches its loose 1.0 tag.
	expect(found.perUnit.web!.manifestDisagrees).toBe(true);
	expect(found.perUnit.mobile!.manifestDisagrees).toBe(false);
	expect(found.perUnit.mobile!.last).toEqual({
		tag: 'mobile/v1.0',
		version: '1.0.0',
	});
});

test('libraries on one v tag share it', async () => {
	const untagged = await libraryLayout();
	try {
		const plain = await tagsOf(untagged.dir);
		expect(plain.perUnit.core!.write).toBe('{name}@{version}');
	} finally {
		await untagged.cleanup();
	}

	repo = await libraryLayout({extraSteps: [{tag: 'v1.2.0'}]});
	const found = await tagsOf(repo.dir);
	expect(Object.keys(found.perUnit).sort()).toEqual(['cli', 'core', 'types']);
	for (const unit of Object.values(found.perUnit)) {
		expect(unit).toEqual({
			write: 'v{version}',
			read: [],
			last: {tag: 'v1.2.0', version: '1.2.0'},
			unparseable: [],
			manifestDisagrees: false,
		});
	}

	expect(found.inherited.tags).toEqual([]);
});

test('findUpstreamRemote takes a remote that shares history, never origin', async () => {
	repo = await gearzLayout({template: true});
	await git(repo.dir, ['remote', 'rename', 'upstream', 'template']);
	expect(await findUpstreamRemote(repo.dir)).toBe('template');
	await git(repo.dir, ['remote', 'rename', 'template', 'origin']);
	expect(await findUpstreamRemote(repo.dir)).toBeNull();
});

test('own tags of units whose names end in a digit are learned, not stray', async () => {
	const app = (name: string) =>
		JSON.stringify({name, version: '1.0.0', private: true});
	repo = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'package.json': JSON.stringify({name: 'root', private: true}),
				'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
				'apps/web3/package.json': app('web3'),
				'apps/auth0/package.json': app('auth0'),
			},
		},
		...tagged('web3-v1.2.0', 'auth0-1.0.0'),
	]);
	const found = await tagsOf(repo.dir);
	expect(found.perUnit.web3).toMatchObject({
		write: 'web3-v{version}',
		last: {tag: 'web3-v1.2.0', version: '1.2.0'},
	});
	expect(found.perUnit.auth0).toMatchObject({
		write: 'auth0-{version}',
		last: {tag: 'auth0-1.0.0', version: '1.0.0'},
	});
	expect(found.stray.tags).toEqual([]);
	for (const tag of ['web3-v1.2.0', 'auth0-1.0.0']) {
		expect(ignoredBy(tag, allPatterns(found))).toEqual([]);
	}
});

test("write follows the newest tag's format, even when an older tag has a higher version", async () => {
	repo = await gearzLayout({extraSteps: tagged('web-v2.0', 'web/v1.5.0')});
	const found = await tagsOf(repo.dir);
	expect(found.perUnit.web).toMatchObject({
		write: 'web/v{version}',
		read: ['web-v{version}'],
		last: {tag: 'web-v2.0', version: '2.0.0'},
	});
});

test('an upstream that is the canonical repo with our own tags proposes no inherited tags', async () => {
	// The maintainer tags releases and keeps committing after the last one;
	// this clone is a contributor's, so upstream reaches every tag.
	repo = await libraryLayout({
		templateSteps: [
			{commit: '✨ First feature'},
			{tag: '1.0.0'},
			{commit: '✨ Second feature'},
			{tag: '1.1.0'},
			{commit: '✨ Third feature'},
		],
	});
	expect(await findUpstreamRemote(repo.dir)).toBe('upstream');
	const found = await tagsOf(repo.dir);
	expect(found.inherited).toEqual({tags: [], patterns: [], examples: []});
});

test("the libraries' next v{version} tag is never matched by an inherited pattern", async () => {
	// Own tags are two-part (v1.2), so only the next tag, v1.0.0-shaped,
	// overlaps the template's v4.0.2.
	repo = await libraryLayout({
		templateSteps: [{commit: 'Update the kit'}, {tag: 'v4.0.2'}],
		extraSteps: [{tag: 'v1.2'}, {commit: '✨ Add the parser'}],
	});
	const found = await tagsOf(repo.dir);
	expect(found.inherited.tags).toEqual(['v4.0.2']);
	expect(found.perUnit.core!.write).toBe('v{version}');
	expect(found.inherited.patterns).toEqual(['^v4\\.0\\.2$']);
	expect(ignoredBy('v1.3.0', found.inherited.patterns)).toEqual([]);
});

test('an own tag on an unmerged branch is matched by no pattern', async () => {
	repo = await gearzLayout({template: true});
	await git(repo.dir, ['switch', '-q', '-c', 'release-candidate']);
	await git(repo.dir, ['commit', '-q', '--allow-empty', '-m', '🔖 Try 1.2.3']);
	await git(repo.dir, ['tag', '1.2.3']);
	await git(repo.dir, ['switch', '-q', 'main']);
	const found = await tagsOf(repo.dir);
	expect(found.inherited.tags).not.toContain('1.2.3');
	expect([...found.inherited.tags].sort()).toEqual(TEMPLATE_TAGS);
	expect(ignoredBy('1.2.3', allPatterns(found))).toEqual([]);
	expect(found.inherited.patterns).toContain(
		String.raw`^(?!(?:1\.2\.3)$)\d+\.\d+\.\d+$`,
	);
	expect(ignoredBy('4.0.9', found.inherited.patterns)).not.toEqual([]);
});

test('with a remote, a template tag whose branch upstream pruned is inherited, and an own unmerged tag is not', async () => {
	repo = await gearzLayout({template: true, prunedBranch: 'tagged'});
	await git(repo.dir, ['switch', '-q', '-c', 'offline-publish']);
	await git(repo.dir, ['commit', '-q', '--allow-empty', '-m', '🔖 5.0.0']);
	await git(repo.dir, ['tag', '5.0.0']);
	await git(repo.dir, ['switch', '-q', 'main']);
	const found = await tagsOf(repo.dir);
	expect([...found.inherited.tags].sort()).toEqual([
		...TEMPLATE_TAGS.slice(0, 2),
		'4.1.0',
		TEMPLATE_TAGS[2],
	]);
	expect(ignoredBy('4.1.0', found.inherited.patterns)).not.toEqual([]);
	expect(ignoredBy('5.0.0', allPatterns(found))).toEqual([]);
	expect(found.inherited.patterns).toEqual([
		String.raw`^(?!(?:5\.0\.0)$)\d+\.\d+\.\d+$`,
		String.raw`^v\d+\.\d+\.\d+-\d+$`,
	]);
});
