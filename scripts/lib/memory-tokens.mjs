// The arithmetic for the memory token benchmark. Pure functions: no git, no files.

export const CHARS_PER_TOKEN = 4;
export const WINDOWS = [250_000, 500_000, 1_000_000];

/**
 * @param {string} text
 * @returns {number} Math.ceil(text.length / 4); 0 for the empty string
 */
export function estimateTokens(text) {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * @param {number[]} numbers
 * @returns {{mean: number, median: number, min: number, max: number}} of a non-empty list; all 0 for an empty one
 */
export function summarize(numbers) {
	if (numbers.length === 0) return {mean: 0, median: 0, min: 0, max: 0};
	const sorted = [...numbers].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
	const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
	return {mean, median, min: sorted[0], max: sorted[sorted.length - 1]};
}

/**
 * One "what stands" plus `lookups` whys at the mean cost, rounded to a whole token.
 * @param {{whatStands: number, whyMean: number, lookups?: number}} input
 * @returns {number}
 */
export function typicalSwitch({whatStands, whyMean, lookups = 5}) {
	return Math.round(whatStands + lookups * whyMean);
}

const toFourDecimals = (/** @type {number} */ n) =>
	Math.round(n * 10_000) / 10_000;

/**
 * Shares are fractions of the window to 4 decimals; fits is Math.floor(window / tokens),
 * or null when tokens is 0.
 * @param {{withTokens: number, withoutTokens: number}} tokens
 * @param {number[]} [windows]
 * @returns {Array<{window: number, withShare: number, withoutShare: number, withFits: number | null, withoutFits: number | null}>}
 */
export function windowShares({withTokens, withoutTokens}, windows = WINDOWS) {
	return windows.map(window => ({
		window,
		withShare: toFourDecimals(withTokens / window),
		withoutShare: toFourDecimals(withoutTokens / window),
		withFits: withTokens === 0 ? null : Math.floor(window / withTokens),
		withoutFits:
			withoutTokens === 0 ? null : Math.floor(window / withoutTokens),
	}));
}

/**
 * withoutTokens / withTokens to 1 decimal, or null when withTokens is 0.
 * @param {number} withTokens
 * @param {number} withoutTokens
 * @returns {number | null}
 */
export function ratio(withTokens, withoutTokens) {
	if (withTokens === 0) return null;
	return Math.round((withoutTokens / withTokens) * 10) / 10;
}

/**
 * Deterministic: sort candidates by `commit` (code-unit order), take the first `n`.
 * @template {{commit: string}} T
 * @param {T[]} candidates
 * @param {number} [n]
 * @returns {T[]}
 */
export function pickSample(candidates, n = 20) {
	return [...candidates]
		.sort((a, b) => (a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : 0))
		.slice(0, n);
}

/** A whole number with thousands separators, rounded half up. @param {number} n */
const tokens = n => Math.round(n).toLocaleString('en-US');

/**
 * A share of a window, rounded half up: one decimal, or two when under 1%.
 * Shares are kept to 4 decimals, so this counts in whole hundredths of a
 * percent and a tie is never lost to floating point.
 * @param {number} share
 */
const percent = share => {
	const hundredths = Math.round(share * 10_000);
	if (hundredths < 100) return `${(hundredths / 100).toFixed(2)}%`;
	return `${(Math.floor((hundredths + 5) / 10) / 10).toFixed(1)}%`;
};

/** A ratio as `27.1×`, or "not measured". @param {number | null} value */
const times = value =>
	value === null ? 'not measured' : `${value.toFixed(1)}×`;

/** A count of switches that fit, or "not measured". @param {number | null} n */
const fits = n => (n === null ? 'not measured' : tokens(n));

/** 250000 as `250k` and 1000000 as `1M`. @param {number} window */
const windowName = window =>
	window >= 1_000_000 ? `${window / 1_000_000}M` : `${window / 1000}k`;

/**
 * A Markdown table laid out as the formatter lays one out (cells padded to
 * their column, figures to the right), so formatting the page changes nothing.
 * @param {string[]} header @param {string[][]} rows
 */
function table(header, rows) {
	const widths = header.map((cell, column) =>
		Math.max(3, cell.length, ...rows.map(row => row[column].length)),
	);
	const line = (/** @type {string[]} */ cells) =>
		`| ${cells
			.map((cell, column) =>
				column === 0
					? cell.padEnd(widths[column])
					: cell.padStart(widths[column]),
			)
			.join(' | ')} |`;
	const rule = widths.map((width, column) =>
		column === 0 ? '-'.repeat(width) : `${'-'.repeat(width - 1)}:`,
	);
	return [line(header), `| ${rule.join(' | ')} |`, ...rows.map(line)].join(
		'\n',
	);
}

/**
 * The Markdown for the page's generated part, from the results file's
 * contents: the typical switch, the three windows, the why sample, the growth
 * table, and what the figures were measured at. It names no figure that is
 * not in the results.
 * @param {any} results the parsed docs/benchmarks/memory-tokens.json
 * @returns {string}
 */
export function renderTables(results) {
	const {ranAt, method, whatStands, why, windows, growth} = results;
	const change = results.typicalSwitch;
	const at = ranAt.tag
		? `${ranAt.tag} (commit \`${ranAt.commit.slice(0, 7)}\`)`
		: `commit \`${ranAt.commit.slice(0, 7)}\``;
	const out = [
		`Measured at ${at} on ${ranAt.date} UTC. Every figure is an estimate at ${method.charsPerToken} characters a token, rounded half up to whole tokens${results.exact ? ', except the exact counts at the end' : ''}.`,
		'### A typical switch',
		`A typical switch is what stands, plus ${method.lookups} why lookups at the mean cost of one. This repo has ${tokens(whatStands.commits)} commits and ${tokens(whatStands.cardLines)} card lines in its brief.`,
		table(
			['', 'What stands', 'One why, mean', 'Typical switch'],
			[
				[
					'With chamoji',
					tokens(whatStands.brief.tokens),
					tokens(why.card.mean),
					tokens(change.with),
				],
				[
					'Git alone',
					tokens(whatStands.log.tokens),
					tokens(why.blameShow.mean),
					tokens(change.without),
				],
			],
		),
		`chamoji reads ${tokens(change.saved)} fewer tokens: git alone reads ${times(change.ratio)} as many.`,
		'### Share of a context window',
		table(
			[
				'Window',
				'With chamoji',
				'Git alone',
				'Switches that fit, with chamoji',
				'Switches that fit, git alone',
			],
			windows.map((/** @type {any} */ w) => [
				windowName(w.window),
				percent(w.withShare),
				percent(w.withoutShare),
				fits(w.withFits),
				fits(w.withoutFits),
			]),
		),
		'### One why',
		`${tokens(why.sampleSize)} lines were measured and ${tokens(why.dropped)} dropped.`,
		table(
			['', 'Mean', 'Median', 'Smallest', 'Largest'],
			[
				['`chamoji why`', why.card],
				['`git blame`, then `git show`', why.blameShow],
				['`git log -p` on the file', why.fileHistory],
			].map(([label, figures]) => [
				/** @type {string} */ (label),
				tokens(/** @type {any} */ (figures).mean),
				tokens(/** @type {any} */ (figures).median),
				tokens(/** @type {any} */ (figures).min),
				tokens(/** @type {any} */ (figures).max),
			]),
		),
		'### What stands at each release',
	];
	if (growth.length === 0) {
		out.push('No release tags were measured.');
	} else {
		const first = growth[0];
		const last = growth.at(-1);
		out.push(
			table(
				['Tag', 'Commits', 'Card lines', 'Brief', 'Git log', 'Notes file'],
				growth.map((/** @type {any} */ row) => [
					row.tag,
					tokens(row.commits),
					tokens(row.cardLines),
					tokens(row.brief),
					tokens(row.log),
					tokens(row.notesFile),
				]),
			),
			`From ${first.tag} to ${last.tag} the git log went from ${tokens(first.log)} to ${tokens(last.log)} tokens, the brief from ${tokens(first.brief)} to ${tokens(last.brief)}, and the notes file from ${tokens(first.notesFile)} to ${tokens(last.notesFile)}.`,
		);
	}

	if (results.exact) {
		out.push(
			`### Exact counts`,
			`${results.exact.model} counted the same texts: ${tokens(results.exact.typicalSwitch.with)} tokens for a typical switch with chamoji and ${tokens(results.exact.typicalSwitch.without)} with git alone.`,
		);
	}

	return `${out.join('\n\n')}\n`;
}

const LIVE_NOT_RUN = 'The live sample has not been run yet.';

/**
 * The Markdown for the page's live section, from the live results file's
 * contents: the model, the date and the commit, and per side the smallest,
 * median and largest input tokens, output tokens, turns and tool calls. It
 * judges no answer itself: right answers are counted only once a person has
 * checked them. With no results it is the not-run sentence.
 * @param {any} live the parsed docs/benchmarks/memory-tokens-live.json, or null
 * @returns {string}
 */
export function renderLive(live) {
	if (!live) return `${LIVE_NOT_RUN}\n`;
	const {model, date, commit, runs, summary, checked} = live;
	const questions = new Set(runs.map((/** @type {any} */ r) => r.question))
		.size;
	const perQuestion = Math.max(
		...runs.map((/** @type {any} */ r) => r.run ?? 1),
	);
	const failed = runs.filter((/** @type {any} */ r) => r.error).length;
	const sides = /** @type {const} */ ([
		['with', 'with chamoji'],
		['without', 'without'],
	]);
	const metrics = /** @type {const} */ ([
		['inputTokens', 'Input tokens'],
		['outputTokens', 'Output tokens'],
		['turns', 'Turns'],
		['toolCalls', 'Tool calls'],
	]);
	const out = [
		`${model} answered ${questions} ${questions === 1 ? 'question' : 'questions'} about this repo ${perQuestion === 1 ? 'once' : `${perQuestion} times`} each in Claude Code, in a clone with chamoji set up and in a plain clone, on ${date} UTC at commit \`${commit.slice(0, 7)}\`. The figures are what each session reported, per run; input tokens include cached ones.`,
		table(
			['', 'Smallest', 'Median', 'Largest'],
			metrics.flatMap(([key, label]) =>
				sides.map(([side, sideLabel]) => {
					const f = summary[side][key];
					return [
						`${label}, ${sideLabel}`,
						tokens(f.min),
						tokens(f.median),
						tokens(f.max),
					];
				}),
			),
		),
	];
	if (failed > 0) {
		out.push(
			`${failed} of ${runs.length} runs failed and ${failed === 1 ? 'is' : 'are'} left out of the figures.`,
		);
	}

	if (checked) {
		const right = (/** @type {string} */ side) => {
			const answered = runs.filter(
				(/** @type {any} */ r) => r.side === side && !r.error,
			);
			return [
				answered.filter((/** @type {any} */ r) => r.correct === true).length,
				answered.length,
			];
		};
		const [withRight, withAnswered] = right('with');
		const [withoutRight, withoutAnswered] = right('without');
		out.push(
			`Checked against the key by hand: ${withRight} of ${withAnswered} answers with chamoji were right, and ${withoutRight} of ${withoutAnswered} without.`,
		);
	} else {
		out.push('The answers have not been checked against the key yet.');
	}

	return `${out.join('\n\n')}\n`;
}

/**
 * The line numbers of a page's `## ` headings, skipping code blocks.
 * @param {string[]} lines
 * @returns {number[]}
 */
function headingLines(lines) {
	let fenced = false;
	/** @type {number[]} */
	const found = [];
	lines.forEach((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		else if (!fenced && line.startsWith('## ')) found.push(index);
	});
	return found;
}

/**
 * Where a section sits: its heading line, and the line its body stops at (the
 * next `## ` heading or the end). The heading matches by its start, so one
 * with an annotation after it still counts.
 * @param {string[]} lines @param {string} heading
 * @returns {{start: number, end: number} | null}
 */
function findSection(lines, heading) {
	const headings = headingLines(lines);
	const start = headings.find(
		index => lines[index] === heading || lines[index].startsWith(`${heading} `),
	);
	if (start === undefined) return null;
	return {start, end: headings.find(index => index > start) ?? lines.length};
}

/**
 * The text between a `## ` heading and the next one, trimmed, or null when
 * the page has no such heading.
 * @param {string} page @param {string} heading
 * @returns {string | null}
 */
export function sectionBody(page, heading) {
	const lines = page.split('\n');
	const found = findSection(lines, heading);
	if (!found) return null;
	return lines
		.slice(found.start + 1, found.end)
		.join('\n')
		.trim();
}

/**
 * The page with the text under a `## ` heading replaced by `body`, up to the
 * next `## ` heading, or null when the page has no such heading.
 * @param {string} page @param {string} heading @param {string} body
 * @returns {string | null}
 */
export function replaceSection(page, heading, body) {
	const lines = page.split('\n');
	const found = findSection(lines, heading);
	if (!found) return null;
	const rest = lines.slice(found.end);
	return [
		...lines.slice(0, found.start + 1),
		'',
		...body.trim().split('\n'),
		'',
		...(rest.length === 0 ? [] : rest),
	].join('\n');
}
