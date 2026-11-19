import {execFile} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {
	estimateTokens,
	pickSample,
	ratio,
	renderLive,
	renderTables,
	replaceSection,
	roundedSummary,
	sectionBody,
	summarize,
	switchFigures,
	typicalSwitch,
	windowShares,
	WINDOWS,
} from './lib/memory-tokens.mjs';
import {
	checkProblem,
	countToolCalls,
	firstSide,
	markInBrief,
	recordFromResult,
	summarizeSide,
} from './memory-benchmark-live.mjs';

const LIVE_HEADING = '## What real sessions spent';
const REPLAY_HEADING = '## The replay: reading everything';

test('estimateTokens rounds up at 4 characters a token', () => {
	expect(estimateTokens('')).toBe(0);
	expect(estimateTokens('abcd')).toBe(1);
	expect(estimateTokens('abcde')).toBe(2);
});

test('typicalSwitch is one what-stands plus five whys at the mean', () => {
	expect(typicalSwitch({whatStands: 1500, whyMean: 140.4})).toBe(2202);
});

test('windowShares gives the share and how many switches fit', () => {
	expect(windowShares({withTokens: 2500, withoutTokens: 50_000})[0]).toEqual({
		window: 250_000,
		withShare: 0.01,
		withoutShare: 0.2,
		withFits: 100,
		withoutFits: 5,
	});
});

test('windowShares covers all three windows by default', () => {
	expect(
		windowShares({withTokens: 1, withoutTokens: 1}).map(row => row.window),
	).toEqual(WINDOWS);
});

test('windowShares and ratio give null, not Infinity, at zero tokens', () => {
	expect(
		windowShares({withTokens: 0, withoutTokens: 10})[0].withFits,
	).toBeNull();
	expect(ratio(0, 10)).toBeNull();
});

test('windowShares gives null fits for a side with zero tokens', () => {
	expect(
		windowShares({withTokens: 10, withoutTokens: 0})[0].withoutFits,
	).toBeNull();
});

test('ratio is without over with, to one decimal', () => {
	expect(ratio(3, 10)).toBe(3.3);
});

test('summarize of an empty list is all zeros', () => {
	expect(summarize([])).toEqual({mean: 0, median: 0, min: 0, max: 0});
});

test('summarize of an odd count takes the middle value', () => {
	expect(summarize([9, 1, 5])).toEqual({mean: 5, median: 5, min: 1, max: 9});
});

test('summarize of an even count averages the two middle values', () => {
	expect(summarize([4, 1, 2, 10])).toEqual({
		mean: 4.25,
		median: 3,
		min: 1,
		max: 10,
	});
});

test('pickSample is the first n by commit hash, whatever order they arrive in', () => {
	const c = [{commit: 'c'}, {commit: 'a'}, {commit: 'b'}];
	expect(pickSample(c, 2)).toEqual([{commit: 'a'}, {commit: 'b'}]);
	expect(pickSample([...c].reverse(), 2)).toEqual([
		{commit: 'a'},
		{commit: 'b'},
	]);
});

test('pickSample does not reorder its input', () => {
	const c = [{commit: 'b'}, {commit: 'a'}];
	pickSample(c, 1);
	expect(c).toEqual([{commit: 'b'}, {commit: 'a'}]);
});

test('roundedSummary is summarize with every figure to one decimal', () => {
	expect(roundedSummary([1, 2, 2])).toEqual({
		mean: 1.7,
		median: 2,
		min: 1,
		max: 2,
	});
});

const whatStandsParts = {
	brief: {chars: 5995, tokens: 1499},
	briefLines: 33,
	briefUncut: {chars: 9665, tokens: 2417, lines: 57},
	mcpTools: {chars: 4575, tokens: 1144},
	log: {chars: 233_999, tokens: 58_500},
	notesFile: {chars: 7485, tokens: 1872},
	cardLines: 57,
	openLines: 57,
	commits: 454,
};

test('switchFigures counts the brief and the tool definitions with chamoji, and the log with whys read in full or as messages only', () => {
	const figures = switchFigures({
		whatStands: whatStandsParts,
		why: {
			sampleSize: 20,
			card: {mean: 67.8},
			blameShow: {mean: 3637.2},
			blameMessage: {mean: 122.3},
		},
		lookups: 5,
	});

	expect(figures).toEqual({
		with: 2982,
		without: 76_686,
		saved: 73_704,
		ratio: 25.7,
		messagesOnly: {without: 59_112, saved: 56_130, ratio: 19.8},
	});
});

test('switchFigures is null when no line was measured', () => {
	expect(
		switchFigures({
			whatStands: whatStandsParts,
			why: {
				sampleSize: 0,
				card: {mean: 0},
				blameShow: {mean: 0},
				blameMessage: {mean: 0},
			},
			lookups: 5,
		}),
	).toBeNull();
});

/** A replay results file with made-up figures that agree with each other. */
function replayResults(overrides: Record<string, unknown> = {}) {
	const perLine = [
		{
			location: 'a.ts:1',
			commit: 'a'.repeat(40),
			card: 60,
			blameShow: 3000,
			blameMessage: 100,
			fileHistory: 9000,
		},
		{
			location: 'b.ts:2',
			commit: 'b'.repeat(40),
			card: 75,
			blameShow: 4275,
			blameMessage: 145,
			fileHistory: 28_000,
		},
	];
	const of = (key: keyof (typeof perLine)[number]) =>
		roundedSummary(perLine.map(line => Number(line[key])));
	const why = {
		sampleSize: 2,
		dropped: 0,
		card: of('card'),
		blameShow: of('blameShow'),
		blameMessage: of('blameMessage'),
		fileHistory: of('fileHistory'),
		perLine,
	};
	const change = switchFigures({whatStands: whatStandsParts, why, lookups: 5});
	return {
		version: 2,
		ranAt: {
			tag: null,
			commit: 'de4046f305c717f7822f3626b084a766b19f4226',
			date: '2026-11-19',
		},
		method: {
			charsPerToken: 4,
			lookups: 5,
			refsAsOf: 'HEAD',
			briefBudget: 1500,
			uncutBudget: 20_000,
		},
		whatStands: whatStandsParts,
		why,
		typicalSwitch: change,
		windows: windowShares({
			withTokens: change?.with ?? 0,
			withoutTokens: change?.without ?? 0,
		}),
		chatExample: {file: 'a.ts', fileHistory: 9000},
		growth: [
			{
				tag: 'v0.11.0',
				commits: 175,
				cardLines: 54,
				brief: 1478,
				briefUncut: 2230,
				log: 22_194,
				notesFile: 1765,
			},
			{
				tag: 'v0.16.0',
				commits: 370,
				cardLines: 57,
				brief: 1474,
				briefUncut: 2417,
				log: 48_141,
				notesFile: 1872,
			},
		],
		exact: null,
		...overrides,
	};
}

test('renderTables shows the typical switch with the tool definitions and the mean why to one decimal, for both git rows', () => {
	const text = renderTables(replayResults());

	expect(text).toMatch(
		/\|\s*With chamoji\s*\|\s*1,499\s*\|\s*1,144\s*\|\s*67\.5\s*\|\s*2,981\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Git alone, read in full\s*\|\s*58,500\s*\|\s*0\s*\|\s*3,637\.5\s*\|\s*76,688\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Git alone, messages only\s*\|\s*58,500\s*\|\s*0\s*\|\s*122\.5\s*\|\s*59,113\s*\|/,
	);
	expect(text).toContain(
		'Read in full, git alone comes to 25.7× as many tokens as chamoji, 73,707 more. With only each commit’s message for a why, it comes to 19.8× as many, 56,132 more.',
	);
	expect(text).toMatch(/tool definitions/);
});

test('renderTables says what the brief is: its budget, how many lines it lists, and the uncut brief', () => {
	const text = renderTables(replayResults());

	expect(text).toContain('a budget of 1,500 tokens');
	expect(text).toContain('lists 33 of the 57 card lines');
	expect(text).toContain('each section says how many more it has');
	expect(text).toContain(
		'With a budget of 20,000 tokens it lists 57 of them in 2,417 tokens.',
	);
	expect(text).toMatch(/\|\s*Tag\s*\|.*\|\s*Brief, uncut\s*\|/);
	expect(text).toMatch(/\|\s*v0\.16\.0\s*\|.*\|\s*2,417\s*\|\s*48,141\s*\|/);
});

test('renderTables says whether rule states made a difference', () => {
	expect(renderTables(replayResults())).toContain(
		'All 57 card lines are open, so rule states made no difference to any figure here.',
	);
	expect(
		renderTables(
			replayResults({whatStands: {...whatStandsParts, openLines: 50}}),
		),
	).toContain('50 of the 57 card lines are open.');
});

test('renderTables labels the window table as following from the read-in-full model', () => {
	const text = renderTables(replayResults());

	expect(text).toContain('read-in-full model');
	expect(text).toContain('not what a live session used');
	expect(text).toMatch(
		/\|\s*Window\s*\|\s*With chamoji\s*\|\s*Git alone, read in full\s*\|/,
	);
	expect(text).not.toMatch(/\| Git alone \|/);
});

test('renderTables says the estimate is unchecked until an exact count is made', () => {
	expect(renderTables(replayResults())).toContain(
		'No exact count has been made yet, so the estimate of 4 characters a token has not been checked against a model’s own count.',
	);
	expect(
		renderTables(
			replayResults({
				exact: {
					model: 'claude-sonnet-5-5',
					typicalSwitch: {with: 3000, without: 70_000},
				},
			}),
		),
	).not.toContain('No exact count');
});

test('renderTables has a why row for blame, then the commit’s message', () => {
	expect(renderTables(replayResults())).toMatch(
		/\|\s*`git blame`, then the commit’s message\s*\|\s*123\s*\|/,
	);
});

const resultsUrl = new URL(
	'../docs/benchmarks/memory-tokens.json',
	import.meta.url,
);
const pageUrl = new URL(
	'../docs/site/guides/memory-tokens.mdx',
	import.meta.url,
);
const results = () => JSON.parse(readFileSync(resultsUrl, 'utf8'));

test('docs/benchmarks/memory-tokens.json agrees with itself', () => {
	const file = results();
	const {why} = file;

	for (const key of ['card', 'blameShow', 'blameMessage', 'fileHistory']) {
		expect(why[key]).toEqual(
			roundedSummary(why.perLine.map((line: any) => line[key])),
		);
	}
	expect(why.sampleSize).toBe(why.perLine.length);
	expect(file.typicalSwitch).toEqual(
		switchFigures({
			whatStands: file.whatStands,
			why,
			lookups: file.method.lookups,
		}),
	);
	expect(file.windows).toEqual(
		windowShares({
			withTokens: file.typicalSwitch.with,
			withoutTokens: file.typicalSwitch.without,
		}),
	);

	let sizes = 0;
	const walk = (value: unknown) => {
		if (!value || typeof value !== 'object') return;
		const record = value as Record<string, unknown>;
		if (typeof record.chars === 'number') {
			expect(record.tokens).toBe(Math.ceil(record.chars / 4));
			sizes++;
		}
		Object.values(record).forEach(walk);
	};
	walk(file);
	expect(sizes).toBeGreaterThanOrEqual(5);
});

test('renderTables shows the three windows as 250k, 500k and 1M with both shares as percentages', () => {
	const base = replayResults();
	const text = renderTables({
		...base,
		windows: [
			{
				window: 250_000,
				withShare: 0.0073,
				withoutShare: 0.3042,
				withFits: 136,
				withoutFits: 3,
			},
			{
				window: 500_000,
				withShare: 0.0037,
				withoutShare: 0.1521,
				withFits: 272,
				withoutFits: 6,
			},
			{
				window: 1_000_000,
				withShare: 0.0018,
				withoutShare: 0.076,
				withFits: 544,
				withoutFits: 13,
			},
		],
	});

	expect(text).toMatch(/\|\s*250k\s*\|\s*0\.73%\s*\|\s*30\.4%\s*\|/);
	expect(text).toMatch(/\|\s*500k\s*\|\s*0\.37%\s*\|\s*15\.2%\s*\|/);
	expect(text).toMatch(/\|\s*1M\s*\|\s*0\.18%\s*\|\s*7\.6%\s*\|/);
});

test('renderTables writes "not measured" for a null ratio and never prints NaN, Infinity or null', () => {
	const base = replayResults();
	const text = renderTables({
		...base,
		typicalSwitch: {
			...base.typicalSwitch,
			ratio: null,
			messagesOnly: {...base.typicalSwitch?.messagesOnly, ratio: null},
		},
		windows: base.windows.map((w: object) => ({
			...w,
			withFits: null,
			withoutFits: null,
		})),
	});

	expect(text).toContain('not measured');
	expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
	expect(renderTables(base)).not.toMatch(/NaN|Infinity|null|undefined/);
});

test('renderTables formats tokens with separators, ratios with a times sign and the date as UTC', () => {
	const text = renderTables(replayResults());

	expect(text).toMatch(/\d{1,3},\d{3}/);
	expect(text).toMatch(/\d+\.\d×/);
	expect(text).toMatch(/\d{4}-\d{2}-\d{2} UTC/);
});

test('renderTables rounds half up to whole tokens', () => {
	const base = replayResults();
	const text = renderTables({
		...base,
		why: {...base.why, card: {mean: 67.5, median: 62.5, min: 44, max: 143}},
	});

	expect(text).toMatch(/\|\s+68 \|\s+63 \|\s+44 \|\s+143 \|/);
});

test('the replay section of the page equals renderTables of docs/benchmarks/memory-tokens.json', () => {
	const page = readFileSync(pageUrl, 'utf8');

	expect(sectionBody(page, REPLAY_HEADING)).toBe(
		renderTables(results()).trim(),
	);
});

test('the page shows what real sessions spent before the replay, and has neither old heading', () => {
	const page = readFileSync(pageUrl, 'utf8');

	expect(page.indexOf(`${LIVE_HEADING} `)).toBeGreaterThan(0);
	expect(page.indexOf(`${LIVE_HEADING} `)).toBeLessThan(
		page.indexOf(`${REPLAY_HEADING} `),
	);
	expect(page).not.toContain('## The numbers');
	expect(page).not.toContain('## A sample of real runs');
});

test('every whole number of four digits or more in the generated part appears in the results file', () => {
	const known = new Set<number>();
	const collect = (value: unknown) => {
		if (typeof value === 'number') {
			known.add(value);
			known.add(Math.round(value));
		} else if (value && typeof value === 'object') {
			Object.values(value).forEach(collect);
		}
	};
	collect(results());
	const text = renderTables(results());
	const found = [
		...text.matchAll(
			/(?<![\w.,-])(?:\d{1,3}(?:,\d{3})+(?![\w.-]|,\d)|\d{4,}(?![\w.-]))/g,
		),
	].map(([match]) => Number(match.replaceAll(',', '')));

	expect(found.length).toBeGreaterThan(10);
	for (const number of found) expect(known.has(number)).toBe(true);
});

const liveUrl = new URL(
	'../docs/benchmarks/memory-tokens-live.json',
	import.meta.url,
);

test('the live section of the page equals renderLive of docs/benchmarks/memory-tokens-live.json, or the not-run sentence when there is none', () => {
	const page = readFileSync(pageUrl, 'utf8');
	const live = existsSync(liveUrl)
		? JSON.parse(readFileSync(liveUrl, 'utf8'))
		: null;

	expect(sectionBody(page, LIVE_HEADING)).toBe(
		renderLive(live, results()).trim(),
	);
});

test('docs/benchmarks/memory-tokens-live.json agrees with itself: each side’s summary is the one its runs give', () => {
	const live = JSON.parse(readFileSync(liveUrl, 'utf8'));

	for (const side of ['with', 'without']) {
		expect(live.summary[side]).toEqual(
			summarizeSide(live.runs.filter((run: any) => run.side === side)),
		);
	}
});

test('replaceSection leaves other sections alone', () => {
	const page = readFileSync(pageUrl, 'utf8');
	const live = sectionBody(page, LIVE_HEADING);

	expect(live).not.toBeNull();
	const swapped = replaceSection(page, REPLAY_HEADING, 'Changed.');
	expect(sectionBody(swapped ?? '', REPLAY_HEADING)).toBe('Changed.');
	expect(sectionBody(swapped ?? '', LIVE_HEADING)).toBe(live);
	expect(replaceSection(page, '## No such heading', 'x')).toBeNull();
});

test('renderTables rounds a share that lands on a tie half up', () => {
	const base = replayResults();
	const text = renderTables({
		...base,
		windows: [
			{
				window: 250_000,
				withShare: 0.0115,
				withoutShare: 0.0125,
				withFits: 1,
				withoutFits: 1,
			},
		],
	});

	expect(text).toMatch(/\|\s*250k\s*\|\s*1\.2%\s*\|\s*1\.3%\s*\|/);
});

const figures = (min: number, median: number, max: number) => ({
	mean: median,
	median,
	min,
	max,
});

/** A live results file with made-up figures, as the live runner writes one. */
function liveResults(overrides: Record<string, unknown> = {}) {
	const run = (
		side: string,
		question: number,
		inputTokens: number,
		turns: number,
	) => ({
		question,
		side,
		run: 1,
		inputTokens,
		outputTokens: 300,
		turns,
		toolCalls: turns - 1,
		costUsd: 0.05,
		answer: 'No.',
		correct: null as boolean | null,
	});
	return {
		version: 1,
		model: 'claude-sonnet-5-5',
		date: '2026-11-19',
		commit: '0123456789abcdef0123456789abcdef01234567',
		method: {},
		questions: [
			{
				question: 'May I add a folder?',
				label: 'A new folder',
				rule: 'c-00000001',
				key: 'No: the layout is fixed.',
				inBrief: true,
			},
			{
				question: 'Should init set the push refspec?',
				label: 'The push refspec',
				rule: 'c-00000002',
				key: 'No: push would break.',
				inBrief: false,
			},
		],
		runs: [
			run('with', 1, 10_000, 1),
			run('with', 2, 30_000, 2),
			run('without', 1, 60_000, 5),
			run('without', 2, 20_000, 3),
		],
		summary: {
			with: {
				runs: 2,
				errors: 0,
				inputTokens: figures(12_345, 20_000, 40_000),
				outputTokens: figures(200, 300, 400),
				turns: figures(1, 2, 3),
				toolCalls: figures(0, 1, 2),
			},
			without: {
				runs: 2,
				errors: 0,
				inputTokens: figures(55_000, 90_000, 150_500),
				outputTokens: figures(500, 800, 1200),
				turns: figures(4, 9, 15),
				toolCalls: figures(3, 8, 14),
			},
		},
		checked: false,
		...overrides,
	};
}

test('renderLive says input tokens are summed over every request, and that this is what was billed', () => {
	const text = renderLive(liveResults());

	expect(text).toContain(
		'A session’s input tokens are summed over every request it made, cached tokens included, so a session that takes three turns sends its standing context three times.',
	);
	expect(text).toContain(
		'That is what each request was billed for, cached tokens at a lower rate, and not a share of a context window.',
	);
});

test('renderLive shows the mean and the total beside the median', () => {
	const text = renderLive(liveResults());

	expect(text).toMatch(
		/\|\s*\|\s*Smallest\s*\|\s*Median\s*\|\s*Mean\s*\|\s*Largest\s*\|\s*Total\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Input tokens, with chamoji\s*\|\s*12,345\s*\|\s*20,000\s*\|\s*20,000\.0\s*\|\s*40,000\s*\|\s*40,000\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Turns, without\s*\|\s*4\s*\|\s*9\s*\|\s*9\.0\s*\|\s*15\s*\|\s*8\s*\|/,
	);
});

test('renderLive has a table by question: whether its rule was in the brief, and each side’s median input tokens and turns', () => {
	const text = renderLive(liveResults());

	expect(text).toMatch(
		/\|\s*A new folder\s*\|\s*yes\s*\|\s*10,000\s*\|\s*1\s*\|\s*60,000\s*\|\s*5\s*\|\s*6\.0×\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*The push refspec\s*\|\s*no\s*\|\s*30,000\s*\|\s*2\s*\|\s*20,000\s*\|\s*3\s*\|\s*0\.7×\s*\|/,
	);
});

test('renderLive says the questions were written from this repo’s cards', () => {
	expect(renderLive(liveResults())).toContain(
		'We wrote the 2 questions from this repo’s own cards, so each has a rule that answers it; questions of another kind might show no difference.',
	);
});

test('a live file that did not record inBrief renders that column as not recorded, and the question text when there is no label', () => {
	const base = liveResults();
	const text = renderLive({
		...base,
		questions: base.questions.map(({question, rule, key}) => ({
			question,
			rule,
			key,
		})),
	});

	expect(text).toMatch(
		/\|\s*May I add a folder\?\s*\|\s*not recorded\s*\|\s*10,000\s*\|/,
	);
	expect(text).not.toContain('left out');
	expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
});

test('a table cell with a pipe in it is escaped, so the row keeps its columns', () => {
	const base = liveResults();
	const text = renderLive({
		...base,
		questions: [
			{...base.questions[0], label: 'Why `a || true`?'},
			base.questions[1],
		],
	});
	const row = text.split('\n').find(line => line.startsWith('| Why'));

	expect(row).toContain('Why `a \\|\\| true`?');
	expect(row?.split(/(?<!\\)\|/)).toHaveLength(9);
});

test('renderLive relates the live sample to the replay in one sentence built from both files', () => {
	const text = renderLive(liveResults(), replayResults());

	expect(text).toContain(
		'The replay below counts what an agent with git alone would read if it read the whole log and each commit in full, and gets 25.7×. The sessions without chamoji searched instead, and in total spent 80,000 input tokens against 40,000 with it: 2.0× as many. By question, at the median, the ratio ran from 0.7× to 6.0×. On the 1 question whose rule the default brief left out, the sessions with chamoji needed a tool call as well.',
	);
});

test('without a replay, or with every rule in the brief, the relating sentence leaves that part out', () => {
	const base = liveResults();
	const text = renderLive({
		...base,
		questions: base.questions.map(q => ({...q, inBrief: true})),
	});

	expect(text).not.toContain('The replay below');
	expect(text).toContain(
		'In total the sessions without chamoji spent 80,000 input tokens against 40,000 with it: 2.0× as many.',
	);
	expect(text).not.toContain('left out');
});

test('renderLive with no results says the live sample has not been run', () => {
	expect(renderLive(null)).toBe('The live sample has not been run yet.\n');
});

test('renderLive names the model and the date and shows the spread (min to max) of input tokens on each side', () => {
	const text = renderLive(liveResults());

	expect(text).toContain('claude-sonnet-5-5');
	expect(text).toContain('2026-11-19 UTC');
	expect(text).toContain('`0123456`');
	expect(text).toMatch(
		/\|\s*Input tokens, with chamoji\s*\|\s*12,345\s*\|\s*20,000\s*\|\s*20,000\.0\s*\|\s*40,000\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Input tokens, without\s*\|\s*55,000\s*\|\s*90,000\s*\|\s*90,000\.0\s*\|\s*150,500\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Tool calls, without\s*\|\s*3\s*\|\s*8\s*\|\s*8\.0\s*\|\s*14\s*\|/,
	);
	expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
});

test('renderLive says the answers are unchecked while checked is false, and shows the count of right answers once it is true', () => {
	expect(renderLive(liveResults())).toContain(
		'The answers have not been checked against the key yet.',
	);

	const checked: ReturnType<typeof liveResults> = liveResults({checked: true});
	checked.runs = [
		{...checked.runs[0], correct: true},
		{...checked.runs[1], correct: true},
		{...checked.runs[2], correct: true},
		{...checked.runs[3], correct: false},
	];
	const text = renderLive(checked);

	expect(text).not.toContain('have not been checked');
	expect(text).toContain(
		'Checked against the key by hand: 2 of 2 answers with chamoji were right, and 1 of 2 without.',
	);
});

test('renderLive counts the runs that failed and leaves them out of the figures', () => {
	const base = liveResults();
	const text = renderLive({
		...base,
		runs: [
			...base.runs,
			{question: 3, side: 'without', run: 1, error: 'timed out', correct: null},
		],
		summary: {...base.summary, without: {...base.summary.without, errors: 1}},
	});

	expect(text).toContain('1 of 5 runs failed and is left out of the figures.');
});

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

test('the live runner without claude on PATH prints "claude is not on PATH, so the live sample was not run." and exits 2', async () => {
	const empty = mkdtempSync(path.join(tmpdir(), 'chamoji-no-claude-'));
	try {
		const env: NodeJS.ProcessEnv = {};
		for (const [name, value] of Object.entries(process.env)) {
			if (name.toUpperCase() !== 'PATH') env[name] = value;
		}
		env.PATH = empty;

		const error = await execFileAsync(
			process.execPath,
			[path.join(root, 'scripts', 'memory-benchmark-live.mjs')],
			{cwd: empty, env},
		).then(
			() => undefined,
			(error: {code: number; stderr: string}) => error,
		);

		expect(error?.code).toBe(2);
		expect(error?.stderr).toContain(
			'claude is not on PATH, so the live sample was not run.',
		);
	} finally {
		rmSync(empty, {recursive: true, force: true});
	}
});

test('questions.json has five questions, each with a well-formed, unique rule id and a key', () => {
	const questions = JSON.parse(
		readFileSync(
			new URL('./memory-benchmark/questions.json', import.meta.url),
			'utf8',
		),
	);

	expect(questions).toHaveLength(5);
	for (const {question, label, rule, key} of questions) {
		expect(question).toMatch(/\?$/);
		expect(label.length).toBeGreaterThan(5);
		expect(label.length).toBeLessThan(40);
		expect(rule).toMatch(/^[cgf]-[0-9a-f]{8}$/);
		expect(key.length).toBeGreaterThan(10);
	}
	expect(new Set(questions.map((q: {rule: string}) => q.rule)).size).toBe(5);
});

test('markInBrief says, for each question, whether its rule’s id is in the text of the brief', () => {
	const questions = [
		{question: 'One?', label: 'One', rule: 'c-00000001', key: 'Yes, one.'},
		{question: 'Two?', label: 'Two', rule: 'g-00000002', key: 'No, two.'},
	];
	const brief =
		'Constraints\n  open       c-00000001  keep it one.  (abc1234)\n  and 6 more: the constraints section lists them.\n';

	expect(markInBrief(questions, brief)).toEqual([
		{...questions[0], inBrief: true},
		{...questions[1], inBrief: false},
	]);
});

const BRIEF =
	'2026-11-19T07:21:12.686Z [DEBUG] Hook SessionStart (chamoji agent-hook || true) provided additionalContext (5913 chars)';
const dispatch = (id: string, tool = 'Bash') =>
	[
		`2026-11-19T07:18:01.609Z [INFO] [Stall] tool_dispatch_start tool=${tool} toolUseId=${id} permissionDecisionMs=9`,
		`2026-11-19T07:18:02.193Z [INFO] [Stall] tool_dispatch_end tool=${tool} toolUseId=${id} outcome=ok durationMs=584`,
	].join('\n');

/** A result as claude -p --output-format json prints one, trimmed to what is read. */
function claudeResult(overrides: Record<string, unknown> = {}) {
	return {
		type: 'result',
		subtype: 'success',
		is_error: false,
		num_turns: 5,
		result: ' Probably not. ',
		total_cost_usd: 0.04,
		permission_denials: [],
		usage: {
			input_tokens: 10,
			cache_creation_input_tokens: 6952,
			cache_read_input_tokens: 39_931,
			output_tokens: 934,
		},
		modelUsage: {
			'claude-sonnet-5-5': {
				inputTokens: 10,
				outputTokens: 934,
				cacheReadInputTokens: 39_931,
				cacheCreationInputTokens: 6952,
				costUSD: 0.04,
			},
		},
		...overrides,
	};
}

const record = (result: unknown, debug = '') =>
	recordFromResult({
		stdout: JSON.stringify(result),
		stderr: '',
		error: null,
		debug,
	});

test('a check session that failed stops the run, even when its debug log shows the brief', () => {
	const problem = checkProblem({
		record: {error: 'error_during_execution: not signed in'},
		debug: BRIEF,
	});

	expect(problem).toContain('The check session failed');
	expect(problem).toContain('not signed in');
	expect(checkProblem({record: {inputTokens: 1}, debug: 'nothing'})).toContain(
		'did not hand over the brief',
	);
	expect(checkProblem({record: {inputTokens: 1}, debug: BRIEF})).toBeNull();
});

test('a side with no successful runs has no figures, not zeros, and renderLive says so', () => {
	const side = summarizeSide([
		{question: 1, side: 'without', run: 1, error: 'x'},
		{question: 2, side: 'without', run: 1, error: 'y'},
	]);

	expect(side.errors).toBe(2);
	expect(side.inputTokens).toBeNull();
	expect(side.turns).toBeNull();
	expect(side.toolCalls).toBeNull();

	const base = liveResults();
	const text = renderLive({
		...base,
		summary: {...base.summary, without: side},
	});
	expect(text).toContain(
		'No run without chamoji succeeded, so that side has no figures.',
	);
	expect(text).not.toMatch(/\|\s*Input tokens, without/);
	expect(text).toMatch(/\|\s*Input tokens, with chamoji/);
	expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
});

test('countToolCalls counts distinct dispatched tool use ids, and is null when a session took more than one turn and the log shows none', () => {
	const debug = [
		dispatch('toolu_01'),
		dispatch('toolu_02', 'mcp__chamoji__brief'),
		dispatch('toolu_01'),
	].join('\n');

	expect(countToolCalls(debug, 3)).toBe(2);
	expect(countToolCalls('no dispatch lines', 1)).toBe(0);
	expect(countToolCalls('no dispatch lines', 5)).toBeNull();
});

test('a run whose tool calls are unknown is left out of the tool-call figures, and renderLive says how many were', () => {
	const ok = {inputTokens: 10, outputTokens: 1, turns: 2, toolCalls: 4};
	const side = summarizeSide([
		{...ok, question: 1, side: 'without', run: 1},
		{...ok, question: 1, side: 'without', run: 2, toolCalls: null},
	]);

	expect(side.toolCalls).toEqual({mean: 4, median: 4, min: 4, max: 4});
	expect(side.toolCallsUnknown).toBe(1);
	expect(side.turns).toEqual({mean: 2, median: 2, min: 2, max: 2});

	const base = liveResults();
	const text = renderLive({
		...base,
		summary: {
			...base.summary,
			without: {...base.summary.without, toolCallsUnknown: 1},
		},
	});
	expect(text).toContain(
		'1 run took more than one turn but showed no tool call in the debug log, so it is left out of the tool-call figures.',
	);
});

test('input tokens are every input field of every model the result reports, cached ones included', () => {
	const one = record(claudeResult(), dispatch('toolu_01'));

	expect(one).toMatchObject({
		inputTokens: 10 + 6952 + 39_931,
		outputTokens: 934,
		turns: 5,
		toolCalls: 1,
		answer: 'Probably not.',
	});
	expect(one).not.toHaveProperty('usageInputTokens');

	const two = record(
		claudeResult({
			modelUsage: {
				...claudeResult().modelUsage,
				'claude-haiku-4-5': {
					inputTokens: 500,
					outputTokens: 20,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					costUSD: 0.001,
				},
			},
		}),
	);
	expect(two.inputTokens).toBe(10 + 6952 + 39_931 + 500);
	expect(two.outputTokens).toBe(954);
	expect(two.usageInputTokens).toBe(10 + 6952 + 39_931);
	expect(two.usageOutputTokens).toBe(934);
	expect(Object.keys(two.usageByModel as object)).toEqual([
		'claude-sonnet-5-5',
		'claude-haiku-4-5',
	]);
});

test('a result that is not an object, or not JSON, or a failure, is recorded as an error with no figures', () => {
	for (const stdout of ['null', '42', '"text"', 'not json', '']) {
		const r = recordFromResult({stdout, stderr: '', error: null, debug: ''});
		expect(typeof r.error).toBe('string');
		expect(r).not.toHaveProperty('inputTokens');
	}

	const failed = record(
		claudeResult({is_error: true, subtype: 'error_max_turns'}),
	);
	expect(failed.error).toContain('error_max_turns');
	expect(failed).not.toHaveProperty('inputTokens');
});

test('the side that goes first alternates from one run to the next', () => {
	const order = [0, 1].flatMap(question =>
		[1, 2, 3].map(run => firstSide(question, run)),
	);

	expect(order).toEqual([
		'with',
		'without',
		'with',
		'without',
		'with',
		'without',
	]);
});
