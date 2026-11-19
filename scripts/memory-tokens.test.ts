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
	sectionBody,
	summarize,
	typicalSwitch,
	windowShares,
	WINDOWS,
} from './lib/memory-tokens.mjs';
import {
	checkProblem,
	countToolCalls,
	firstSide,
	recordFromResult,
	summarizeSide,
} from './memory-benchmark-live.mjs';

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

const resultsUrl = new URL(
	'../docs/benchmarks/memory-tokens.json',
	import.meta.url,
);
const pageUrl = new URL(
	'../docs/site/guides/memory-tokens.mdx',
	import.meta.url,
);
const results = () => JSON.parse(readFileSync(resultsUrl, 'utf8'));

test('renderTables shows the three windows as 250k, 500k and 1M with both shares as percentages', () => {
	const base = results();
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
	const base = results();
	const text = renderTables({
		...base,
		typicalSwitch: {...base.typicalSwitch, ratio: null},
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
	const text = renderTables(results());

	expect(text).toMatch(/\d{1,3},\d{3}/);
	expect(text).toMatch(/\d+\.\d×/);
	expect(text).toMatch(/\d{4}-\d{2}-\d{2} UTC/);
});

test('renderTables rounds half up to whole tokens', () => {
	const base = results();
	const text = renderTables({
		...base,
		why: {...base.why, card: {mean: 67.5, median: 62.5, min: 44, max: 143}},
	});

	expect(text).toMatch(/\|\s+68 \|\s+63 \|\s+44 \|\s+143 \|/);
});

test('the page between its two markers equals renderTables of docs/benchmarks/memory-tokens.json', () => {
	const page = readFileSync(pageUrl, 'utf8');

	expect(sectionBody(page, '## The numbers')).toBe(
		renderTables(results()).trim(),
	);
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

	expect(sectionBody(page, '## A sample of real runs')).toBe(
		renderLive(live).trim(),
	);
});

test('replaceSection leaves other sections alone', () => {
	const page = readFileSync(pageUrl, 'utf8');
	const live = sectionBody(page, '## A sample of real runs');

	expect(live).not.toBeNull();
	const swapped = replaceSection(page, '## The numbers', 'Changed.');
	expect(sectionBody(swapped ?? '', '## The numbers')).toBe('Changed.');
	expect(sectionBody(swapped ?? '', '## A sample of real runs')).toBe(live);
	expect(replaceSection(page, '## No such heading', 'x')).toBeNull();
});

test('renderTables rounds a share that lands on a tie half up', () => {
	const base = results();
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

test('renderTables says how many times as many tokens git alone reads', () => {
	const base = results();
	const {saved, ratio} = base.typicalSwitch;
	const text = renderTables(base);

	expect(text).toContain(
		`chamoji reads ${saved.toLocaleString('en-US')} fewer tokens: git alone reads ${ratio.toFixed(1)}× as many.`,
	);
});

const figures = (min: number, median: number, max: number) => ({
	mean: median,
	median,
	min,
	max,
});

/** A live results file with made-up figures, as the live runner writes one. */
function liveResults(overrides: Record<string, unknown> = {}) {
	const run = (side: string, question: number, correct: boolean | null) => ({
		question,
		side,
		run: 1,
		inputTokens: 20_000,
		outputTokens: 300,
		turns: 2,
		toolCalls: 1,
		costUsd: 0.05,
		answer: 'No.',
		correct,
	});
	return {
		version: 1,
		model: 'claude-sonnet-5-5',
		date: '2026-11-19',
		commit: '0123456789abcdef0123456789abcdef01234567',
		method: {},
		runs: [
			run('with', 1, null),
			run('with', 2, null),
			run('without', 1, null),
			run('without', 2, null),
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

test('renderLive with no results says the live sample has not been run', () => {
	expect(renderLive(null)).toBe('The live sample has not been run yet.\n');
});

test('renderLive names the model and the date and shows the spread (min to max) of input tokens on each side', () => {
	const text = renderLive(liveResults());

	expect(text).toContain('claude-sonnet-5-5');
	expect(text).toContain('2026-11-19 UTC');
	expect(text).toContain('`0123456`');
	expect(text).toMatch(
		/\|\s*Input tokens, with chamoji\s*\|\s*12,345\s*\|\s*20,000\s*\|\s*40,000\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Input tokens, without\s*\|\s*55,000\s*\|\s*90,000\s*\|\s*150,500\s*\|/,
	);
	expect(text).toMatch(
		/\|\s*Tool calls, without\s*\|\s*3\s*\|\s*8\s*\|\s*14\s*\|/,
	);
	expect(text).not.toMatch(/NaN|Infinity|null|undefined/);
});

test('renderLive says the answers are unchecked while checked is false, and shows the count of right answers once it is true', () => {
	expect(renderLive(liveResults())).toContain(
		'The answers have not been checked against the key yet.',
	);

	const checked = liveResults({checked: true});
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
	for (const {question, rule, key} of questions) {
		expect(question).toMatch(/\?$/);
		expect(rule).toMatch(/^[cgf]-[0-9a-f]{8}$/);
		expect(key.length).toBeGreaterThan(10);
	}
	expect(new Set(questions.map((q: {rule: string}) => q.rule)).size).toBe(5);
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
