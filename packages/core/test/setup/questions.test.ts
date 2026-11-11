import {expect, test} from 'vitest';
import {
	applyAnswer,
	questions,
	recommend,
	summary,
	type Detection,
	type SetupAnswers,
} from '../../src/index.js';
import type {RepoStep} from '../helpers/fixture-repo.js';
import {useDetection} from '../helpers/setup-detection.js';
import {gearzLayout, suiteAppMonorepo} from '../helpers/setup-fixtures.js';

const {detected} = useDetection();

test("summary reads like the spec's example", async () => {
	const detection = await detected(gearzLayout({template: true}));
	expect(summary(detection, recommend(detection))).toBe(
		"Found 4 apps (mobile, web, dev-tool, e2e) and 2 internal packages. mobile and web get their own versions; dev-tool, e2e and tooling are left out. 3 tags look like they came from Makerkit and will be ignored. Shared changes ride along with each app's own releases.",
	);
});

test("the summary's template clause names the template's authors", async () => {
	const detection = await detected(
		gearzLayout({template: true, prunedBranch: 'untagged'}),
	);
	const answers = recommend(detection);
	expect(summary(detection, answers)).toContain(
		"3 tags look like they came from Makerkit and will be ignored, and commits by bot@makerkit.dev count as Makerkit's.",
	);
	// Two are both named, the most prolific first; more are counted.
	const two = applyAnswer(detection, answers, 'upstream.authors', [
		'ci@makerkit.dev',
		'bot@makerkit.dev',
	]);
	expect(summary(detection, two)).toContain(
		"and commits by bot@makerkit.dev and ci@makerkit.dev count as Makerkit's.",
	);
	const three = applyAnswer(detection, answers, 'upstream.authors', [
		'ci@makerkit.dev',
		'bot@makerkit.dev',
		'a@makerkit.dev',
	]);
	expect(summary(detection, three)).toContain(
		"and commits by bot@makerkit.dev and 2 others count as Makerkit's.",
	);
	// With no tag ignored, the authors get a sentence of their own.
	expect(summary(detection, {...answers, ignore: []})).toContain(
		" Commits by bot@makerkit.dev count as Makerkit's. Shared changes",
	);
	// No authors, no clause.
	const none = applyAnswer(detection, answers, 'upstream.authors', []);
	expect(summary(detection, none)).not.toContain('Commits by');
	expect(summary(detection, none)).not.toContain('commits by');
});

test('summary ends with a tag that disagrees with its manifest, then squashed syncs', async () => {
	const syncs: RepoStep[] = [1, 2].map(n => ({
		commit: `Merge upstream Makerkit changes (${n})`,
		files: {'packages/ui/index.ts': `export const n = ${n};\n`},
	}));
	const detection = await detected(
		gearzLayout({
			template: true,
			extraSteps: [{tag: 'web/v1.3.0'}, ...syncs],
		}),
	);
	const text = summary(detection, recommend(detection));
	expect(text).toMatch(
		/ releases\. web's last tag says 1\.3\.0 but apps\/web\/package\.json says 0\.1\.0; the tag wins, and the release sets the file to the new version\. 2 commits look like squash-merged Makerkit syncs; they count as ordinary commits\.$/,
	);
});

test('a base with no name is "the template" in the copy and "template" as a name', async () => {
	const found = await detected(gearzLayout({template: true}));
	const detection = {
		...found,
		upstream: {...found.upstream, name: null, squashedSyncs: ['abc1234']},
	};
	const answers = recommend(detection);
	expect(answers.upstream?.name).toBe('template');
	const text = summary(detection, answers);
	expect(text).toContain(
		' 3 tags look like they came from the template and will be ignored. ',
	);
	expect(text).toMatch(
		/ 1 commit looks like a squash-merged template sync; it counts as an ordinary commit\.$/,
	);
	const asked = questions(detection, answers);
	expect(asked.find(question => question.id === 'ignore')?.found).toMatch(
		/^3 tags look like they came from the template, such as /,
	);
	expect(
		asked.find(question => question.id === 'upstream.name')?.options,
	).toEqual([{value: 'template', label: 'template', recommended: true}]);
});

test("the base question says where the repo's own history starts", async () => {
	const upstreamFound = (detection: Detection, answers: SetupAnswers) =>
		questions(detection, answers).find(
			question => question.id === 'upstream.name',
		)?.found;

	const forked = await detected(gearzLayout({template: true}));
	expect(upstreamFound(forked, recommend(forked))).toBe(
		'30 commits came from the upstream remote before your own history starts',
	);

	// No remote: the template's tags mark the start.
	const noRemote = {
		...forked,
		upstream: {...forked.upstream, remote: null, name: null},
	};
	expect(upstreamFound(noRemote, recommend(noRemote))).toBe(
		"Your own history starts after the template's tags, such as v4.0.2-1, 4.0.2 and 4.0.1",
	);

	// No remote and no inherited tags: only the config says anything.
	const plain = await detected(gearzLayout());
	const named = applyAnswer(
		plain,
		recommend(plain),
		'upstream.name',
		'Makerkit',
	);
	expect(upstreamFound(plain, named)).toBe(
		'No upstream remote or Makerkit tags were found',
	);
	expect(
		upstreamFound(plain, {
			...named,
			upstream: {name: 'Makerkit', since: 'abcdef1234567890'},
		}),
	).toBe('Your own history starts at commit abcdef1');
});

test('only undetectable questions need an answer', async () => {
	const detection = await detected(gearzLayout({template: true}));
	const asked = questions(detection, recommend(detection));
	expect(
		asked
			.filter(question => question.needsAnswer)
			.map(question => question.id)
			.sort(),
	).toEqual([
		'firstVersion:mobile',
		'firstVersion:web',
		'upstream.name',
		'zeroMajor',
	]);
	// Everything else is still there to change.
	expect(asked.map(question => question.id)).toEqual(
		expect.arrayContaining([
			'shape',
			'units',
			'name:web',
			'tag:web',
			'versionFiles:mobile',
			'buildNumber:mobile',
			'ignore',
			'sharedChanges',
			'rootFiles',
			'rootChangelog',
		]),
	);
	const upstream = asked.find(question => question.id === 'upstream.name')!;
	expect(upstream.options).toEqual([
		{value: 'Makerkit', label: 'Makerkit', recommended: true},
	]);
});

const rootOnlyCommits: RepoStep[] = [
	{commit: '⬆️ Bump deps', files: {'pnpm-lock.yaml': 'lockfileVersion: 9\n'}},
	{commit: '👷 Cache pnpm', files: {'.github/workflows/ci.yml': 'name: ci\n'}},
];

test('root-only copy names the window the count covers', async () => {
	const cases: Array<[RepoStep[], string]> = [
		[
			[{tag: 'web/v0.1.0'}, ...rootOnlyCommits],
			'2 commits since your last release touched only pnpm-lock.yaml or .github/',
		],
		[
			[{tag: 'wip/crm'}, ...rootOnlyCommits],
			'2 commits since wip/crm touched only pnpm-lock.yaml or .github/',
		],
		[
			rootOnlyCommits,
			'2 commits in the last 200 commits touched only pnpm-lock.yaml or .github/',
		],
		[
			[{tag: 'web/v0.1.0'}],
			'No commit since your last release touched only files outside the packages',
		],
	];
	for (const [extraSteps, copy] of cases) {
		const detection = await detected(gearzLayout({extraSteps}));
		const asked = questions(detection, recommend(detection));
		expect(asked.find(question => question.id === 'rootFiles')!.found).toBe(
			copy,
		);
	}
});

test('version files are ticked as detected', async () => {
	const detection = await detected(gearzLayout());
	const files = questions(detection, recommend(detection)).find(
		question => question.id === 'versionFiles:mobile',
	)!;
	expect(files.kind).toBe('ticks');
	expect(files.options).toEqual([
		{
			value: 'apps/mobile/app.config.ts',
			label: 'apps/mobile/app.config.ts',
			recommended: true,
		},
	]);
});

test("the template's authors are a detected question under Change something", async () => {
	const detection = await detected(
		gearzLayout({template: true, prunedBranch: 'untagged'}),
	);
	const answers = recommend(detection);
	expect(answers.upstream?.authors).toEqual(['bot@makerkit.dev']);
	expect(answers.why['upstream.authors']).toBe('detected');
	const authors = questions(detection, answers).find(
		question => question.id === 'upstream.authors',
	);
	expect(authors).toEqual({
		id: 'upstream.authors',
		title: "Whose commits are always Makerkit's?",
		found:
			'bot@makerkit.dev wrote 32 commits here, and none of your recent ones',
		kind: 'ticks',
		options: [
			{
				value: 'bot@makerkit.dev',
				label: 'Makerkit Bot <bot@makerkit.dev>',
				recommended: true,
			},
		],
		needsAnswer: false,
	});

	// Unticking drops the key; ticking again, in any case, brings it back.
	const none = applyAnswer(detection, answers, 'upstream.authors', []);
	expect(none.upstream).not.toHaveProperty('authors');
	expect(none.why['upstream.authors']).toBe('chosen');
	const again = applyAnswer(detection, none, 'upstream.authors', [
		'Bot@Makerkit.dev',
		'ci@makerkit.dev',
	]);
	expect(again.upstream?.authors).toEqual([
		'bot@makerkit.dev',
		'ci@makerkit.dev',
	]);
	expect(
		questions(detection, again)
			.find(question => question.id === 'upstream.authors')
			?.options.map(option => option.value),
	).toEqual(['bot@makerkit.dev', 'ci@makerkit.dev']);
});

test('a mixed repo says its published packages stay internal for now', async () => {
	const detection = await detected(
		gearzLayout({
			extraSteps: [
				{
					commit: '✨ Publish the SDK',
					files: {
						'packages/sdk/package.json':
							'{"name": "@gearz/sdk", "version": "0.3.0"}\n',
					},
				},
			],
		}),
	);
	expect(detection.layout.kind).toBe('mixed');
	const answers = recommend(detection);
	const note =
		'@gearz/sdk is published but stays internal for now, as a mixed setup that versions it is still to come';
	expect(summary(detection, answers)).toContain(
		`internal packages. ${note}. mobile and web get their own versions;`,
	);
	expect(
		questions(detection, answers).find(question => question.id === 'shape')
			?.found,
	).toBe(
		`Found 4 apps (mobile, web, dev-tool, e2e) and 3 internal packages; ${note}`,
	);

	// Not in an apps-only repo.
	const apps = await detected(gearzLayout());
	expect(summary(apps, recommend(apps))).not.toContain('mixed setup');
});

test('the first-version title offers 1.0.0 only when the manifest is something else', async () => {
	const detection = await detected(gearzLayout());
	const asked = questions(detection, recommend(detection));
	const first = (unit: string) =>
		asked.find(question => question.id === `firstVersion:${unit}`);
	expect(first('mobile')?.title).toBe(
		'mobile is 1.0.0 in package.json; start there?',
	);
	expect(first('mobile')?.options).toEqual([
		{value: '', label: 'Start at 1.0.0', recommended: true},
	]);
	expect(first('web')?.title).toBe(
		'web is 0.1.0 in package.json; start there or at 1.0.0?',
	);
	expect(first('web')?.options.map(option => option.label)).toEqual([
		'Start at 0.1.0',
		'Start at 1.0.0',
	]);
});

test('with no tag and a mismatch, firstVersion offers the manifest version first', async () => {
	const detection = await detected(suiteAppMonorepo());
	const asked = questions(detection, recommend(detection));
	const first = asked.find(question => question.id === 'firstVersion:backend');
	expect(first?.title).toBe(
		'backend is 2.10.34 in manifest.xml but 2.5.20 in package.json; which is current?',
	);
	expect(first?.options).toMatchObject([
		{value: '2.10.34', recommended: true},
		{value: '2.5.20'},
	]);
});

test('with a tag and a mismatch, the summary names the manifest', async () => {
	const detection = await detected(
		suiteAppMonorepo({extraSteps: [{tag: 'backend/v2.10.34'}]}),
	);
	const text = summary(detection, recommend(detection));
	expect(text).toContain(
		"backend's last tag says 2.10.34 but apps/backend/package.json says 2.5.20; the tag wins, and the release sets both files to the new version.",
	);
});

test('the found sentence shows a SuiteApp with its id and version', async () => {
	const detection = await detected(suiteAppMonorepo());
	const asked = questions(detection, recommend(detection));
	expect(asked.find(question => question.id === 'shape')?.found).toContain(
		'backend (NetSuite SuiteApp · com.example.myapp 2.10.34)',
	);
});

test('the units question labels each app with its framework', async () => {
	const detection = await detected(suiteAppMonorepo());
	const asked = questions(detection, recommend(detection));
	const units = asked.find(question => question.id === 'units');
	expect(units?.options.map(option => option.label)).toEqual([
		'backend (apps/backend) · NetSuite SuiteApp',
		'web (apps/web) · Next.js',
	]);
});
