import {expect, test} from 'vitest';
import {questions, recommend, summary} from '../../src/index.js';
import type {RepoStep} from '../helpers/fixture-repo.js';
import {useDetection} from '../helpers/setup-detection.js';
import {gearzLayout} from '../helpers/setup-fixtures.js';

const {detected} = useDetection();

test("summary reads like the spec's example", async () => {
	const detection = await detected(gearzLayout({template: true}));
	expect(summary(detection, recommend(detection))).toBe(
		"Found 4 apps (mobile, web, dev-tool, e2e) and 2 internal packages. mobile and web get their own versions; dev-tool, e2e and tooling are left out. 3 tags look like they came from Makerkit and will be ignored. Shared changes ride along with each app's own releases.",
	);
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
	const unnamed = {...answers, upstream: undefined};
	expect(summary(detection, unnamed)).toContain(
		'3 tags look like they came from the template and will be ignored. ',
	);
	expect(summary(detection, unnamed)).toMatch(
		/ 1 commit looks like a squash-merged template sync; it counts as an ordinary commit\.$/,
	);
	expect(
		questions(detection, answers).find(
			question => question.id === 'upstream.name',
		)?.options,
	).toEqual([{value: 'template', label: 'template', recommended: true}]);
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
