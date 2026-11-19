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

/** @param {number} n */
const oneDecimal = n => Math.round(n * 10) / 10;

/**
 * `summarize` with each figure to 1 decimal, as the results files keep it.
 * @param {number[]} numbers
 */
export function roundedSummary(numbers) {
	const {mean, median, min, max} = summarize(numbers);
	return {
		mean: oneDecimal(mean),
		median: oneDecimal(median),
		min: oneDecimal(min),
		max: oneDecimal(max),
	};
}

/**
 * One "what stands" plus `lookups` whys at the mean cost, rounded to a whole token.
 * @param {{whatStands: number, whyMean: number, lookups?: number}} input
 * @returns {number}
 */
export function typicalSwitch({whatStands, whyMean, lookups = 5}) {
	return Math.round(whatStands + lookups * whyMean);
}

/**
 * The typical switch on each side, from the results file's own parts. With
 * chamoji it is the brief and the MCP tool definitions plus the mean card;
 * with git alone it is the log plus the mean commit read in full, and, as
 * `messagesOnly`, the log plus the mean commit message. Null when no line
 * was measured, since a why figure of no lines means nothing.
 * @param {{whatStands: {brief: {tokens: number}, mcpTools: {tokens: number}, log: {tokens: number}}, why: {sampleSize: number, card: {mean: number}, blameShow: {mean: number}, blameMessage: {mean: number}}, lookups: number}} input
 */
export function switchFigures({whatStands, why, lookups}) {
	if (why.sampleSize === 0) return null;
	const withTokens = typicalSwitch({
		whatStands: whatStands.brief.tokens + whatStands.mcpTools.tokens,
		whyMean: why.card.mean,
		lookups,
	});
	/** @param {number} whyMean */
	const gitAlone = whyMean => {
		const without = typicalSwitch({
			whatStands: whatStands.log.tokens,
			whyMean,
			lookups,
		});
		return {
			without,
			saved: without - withTokens,
			ratio: ratio(withTokens, without),
		};
	};
	return {
		with: withTokens,
		...gitAlone(why.blameShow.mean),
		messagesOnly: gitAlone(why.blameMessage.mean),
	};
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
 * A pipe in a cell is escaped, so it can't start another column.
 * @param {string[]} header @param {string[][]} cellRows
 */
function table(header, cellRows) {
	const rows = cellRows.map(row =>
		row.map(cell => cell.replaceAll('|', '\\|')),
	);
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

/** A figure to one decimal, with thousands separators. @param {number} n */
const decimal = n =>
	n.toLocaleString('en-US', {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	});

/** What the runner prints, and the page says, when no line was measured. */
export const NO_LINES_MEASURED =
	'No lines were measured, so there is no why figure and no typical switch.';

/**
 * The Markdown for the page's replay section, from the results file's
 * contents: what stands, the typical switch, the three windows, the why
 * sample, the growth table, and what the figures were measured at. It names
 * no figure that is not in the results.
 * @param {any} results the parsed docs/benchmarks/memory-tokens.json
 * @returns {string}
 */
export function renderTables(results) {
	const {ranAt, method, whatStands, why, windows, growth} = results;
	const change = results.typicalSwitch;
	const at = ranAt.tag
		? `${ranAt.tag} (commit \`${ranAt.commit.slice(0, 7)}\`)`
		: `commit \`${ranAt.commit.slice(0, 7)}\``;
	const estimate = `${method.charsPerToken} characters a token`;
	const listed =
		whatStands.briefLines < whatStands.cardLines
			? `lists ${tokens(whatStands.briefLines)} of the ${tokens(whatStands.cardLines)} card lines, and each section says how many more it has`
			: `lists all ${tokens(whatStands.cardLines)} card lines`;
	const open =
		whatStands.openLines === whatStands.cardLines
			? `All ${tokens(whatStands.cardLines)} card lines are open, so rule states made no difference to any figure here.`
			: `${tokens(whatStands.openLines)} of the ${tokens(whatStands.cardLines)} card lines are open.`;
	const out = [
		`Measured at ${at} on ${ranAt.date} UTC. Every figure is an estimate at ${estimate}, rounded half up to whole tokens${results.exact ? ', except the exact counts at the end' : ''}.${results.exact ? '' : ` No exact count has been made yet, so the estimate of ${estimate} has not been checked against a model’s own count.`}`,
		'### What stands',
		`With chamoji, what stands is the brief. \`chamoji memory brief\` cuts it to a budget of ${tokens(method.briefBudget)} tokens by default: on this repo it ${listed}. With a budget of ${tokens(method.uncutBudget)} tokens it lists ${tokens(whatStands.briefUncut.lines)} of them in ${tokens(whatStands.briefUncut.tokens)} tokens. ${open}`,
		`\`chamoji init --agents\` also registers chamoji’s MCP server, whose tool definitions are sent with every request of a session: ${tokens(whatStands.mcpTools.tokens)} tokens. The replay counts them on the chamoji side. With git alone, it counts the whole log: ${tokens(whatStands.log.tokens)} tokens for ${tokens(whatStands.commits)} commits.`,
		'### A typical switch',
	];

	if (change === null) {
		out.push(NO_LINES_MEASURED);
	} else {
		out.push(
			`A typical switch is what stands, plus ${method.lookups} why lookups at the mean cost of one. With chamoji a why is \`chamoji why\`. With git alone it is the commit that last wrote the line, read in full or as its message only.`,
			table(
				[
					'',
					'What stands',
					'Tool definitions',
					'One why, mean',
					'Typical switch',
				],
				[
					[
						'With chamoji',
						tokens(whatStands.brief.tokens),
						tokens(whatStands.mcpTools.tokens),
						decimal(why.card.mean),
						tokens(change.with),
					],
					[
						'Git alone, read in full',
						tokens(whatStands.log.tokens),
						'0',
						decimal(why.blameShow.mean),
						tokens(change.without),
					],
					[
						'Git alone, messages only',
						tokens(whatStands.log.tokens),
						'0',
						decimal(why.blameMessage.mean),
						tokens(change.messagesOnly.without),
					],
				],
			),
			`Read in full, git alone comes to ${times(change.ratio)} as many tokens as chamoji, ${tokens(change.saved)} more. With only each commit’s message for a why, it comes to ${times(change.messagesOnly.ratio)} as many, ${tokens(change.messagesOnly.saved)} more.`,
			'### Share of a context window',
			'These shares follow from the replay’s read-in-full model: each is what one typical switch above would take of the window. They are not what a live session used.',
			table(
				[
					'Window',
					'With chamoji',
					'Git alone, read in full',
					'Switches that fit, with chamoji',
					'Switches that fit, git alone, read in full',
				],
				windows.map((/** @type {any} */ w) => [
					windowName(w.window),
					percent(w.withShare),
					percent(w.withoutShare),
					fits(w.withFits),
					fits(w.withoutFits),
				]),
			),
		);
	}

	out.push(
		'### One why',
		`${tokens(why.sampleSize)} lines were measured and ${tokens(why.dropped)} dropped. The message row is \`git show -s --no-color <commit>\`: the commit’s header and message, without its diff.`,
		table(
			['', 'Mean', 'Median', 'Smallest', 'Largest'],
			[
				['`chamoji why`', why.card],
				['`git blame`, then `git show`', why.blameShow],
				['`git blame`, then the commit’s message', why.blameMessage],
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
	);
	if (growth.length === 0) {
		out.push('No release tags were measured.');
	} else {
		const first = growth[0];
		const last = growth.at(-1);
		out.push(
			table(
				[
					'Tag',
					'Commits',
					'Card lines',
					'Brief',
					'Brief, uncut',
					'Git log',
					'Notes file',
				],
				growth.map((/** @type {any} */ row) => [
					row.tag,
					tokens(row.commits),
					tokens(row.cardLines),
					tokens(row.brief),
					tokens(row.briefUncut),
					tokens(row.log),
					tokens(row.notesFile),
				]),
			),
			`From ${first.tag} to ${last.tag} the git log went from ${tokens(first.log)} to ${tokens(last.log)} tokens, the brief from ${tokens(first.brief)} to ${tokens(last.brief)}, the uncut brief from ${tokens(first.briefUncut)} to ${tokens(last.briefUncut)}, and the notes file from ${tokens(first.notesFile)} to ${tokens(last.notesFile)}. The brief is cut to its budget, so it can’t grow past it; the uncut brief shows how it would grow without the cut.`,
		);
	}

	if (results.exact) {
		out.push(
			`### Exact counts`,
			`${results.exact.model} counted the same texts: ${tokens(results.exact.typicalSwitch.with)} tokens for a typical switch with chamoji and ${tokens(results.exact.typicalSwitch.without)} with git alone, read in full.`,
		);
	}

	return `${out.join('\n\n')}\n`;
}

const LIVE_NOT_RUN = 'The live sample has not been run yet.';

/** @param {number[]} values */
const sum = values => values.reduce((total, n) => total + n, 0);

/**
 * The Markdown for the page's live section, from the live results file's
 * contents: the model, the date and the commit; per side the smallest,
 * median, mean, largest and total input tokens, output tokens, turns and tool
 * calls; per question whether its rule was in the brief and each side's
 * medians; and one sentence relating the sample to the replay, when the
 * replay's results are given. It judges no answer itself: right answers are
 * counted only once a person has checked them. With no results it is the
 * not-run sentence.
 * @param {any} live the parsed docs/benchmarks/memory-tokens-live.json, or null
 * @param {any} [replay] the parsed docs/benchmarks/memory-tokens.json, or null
 * @returns {string}
 */
export function renderLive(live, replay = null) {
	if (!live) return `${LIVE_NOT_RUN}\n`;
	const {model, date, commit, runs, summary, checked} = live;
	/** @type {Array<{question: string, label?: string, inBrief?: boolean}>} */
	const questionList = live.questions ?? [];
	const questions = new Set(runs.map((/** @type {any} */ r) => r.question))
		.size;
	const perQuestion = Math.max(
		...runs.map((/** @type {any} */ r) => r.run ?? 1),
	);
	const failed = runs.filter((/** @type {any} */ r) => r.error).length;
	/** @param {string} side @param {number} [question] */
	const answered = (side, question) =>
		runs.filter(
			(/** @type {any} */ r) =>
				r.side === side &&
				!r.error &&
				(question === undefined || r.question === question),
		);
	// A side with no successful run has no figures, and gets no rows.
	const sides = /** @type {const} */ ([
		['with', 'with chamoji'],
		['without', 'without'],
	]).filter(([side]) => summary[side].inputTokens);
	const metrics = /** @type {const} */ ([
		['inputTokens', 'Input tokens'],
		['outputTokens', 'Output tokens'],
		['turns', 'Turns'],
		['toolCalls', 'Tool calls'],
	]);
	/** @param {string} side @param {string} key */
	const total = (side, key) =>
		sum(
			answered(side)
				.map((/** @type {any} */ r) => r[key])
				.filter((/** @type {unknown} */ n) => typeof n === 'number'),
		);
	const out = [
		`${model} answered ${questions} ${questions === 1 ? 'question' : 'questions'} about this repo ${perQuestion === 1 ? 'once' : `${perQuestion} times`} each in Claude Code, in a clone with chamoji set up and in a plain clone, on ${date} UTC at commit \`${commit.slice(0, 7)}\`. We wrote ${questions === 1 ? 'the question' : `the ${questions} questions`} from this repo’s own cards, so each has a rule that answers it; questions of another kind might show no difference.`,
		'The figures are what each session reported. A session’s input tokens are summed over every request it made, cached tokens included, so a session that takes three turns sends its standing context three times. That is what each request was billed for, cached tokens at a lower rate, and not a share of a context window.',
	];
	if (sides.length > 0) {
		out.push(
			table(
				['', 'Smallest', 'Median', 'Mean', 'Largest', 'Total'],
				metrics.flatMap(([key, label]) =>
					sides.map(([side, sideLabel]) => {
						const f = summary[side][key];
						return [
							`${label}, ${sideLabel}`,
							...(f
								? [
										tokens(f.min),
										tokens(f.median),
										decimal(f.mean),
										tokens(f.max),
										tokens(total(side, key)),
									]
								: Array(5).fill('not measured')),
						];
					}),
				),
			),
		);
	}

	for (const [side, label] of /** @type {const} */ ([
		['with', 'with chamoji'],
		['without', 'without chamoji'],
	])) {
		if (!summary[side].inputTokens) {
			out.push(`No run ${label} succeeded, so that side has no figures.`);
		}
	}

	/** The median of a figure over a question's runs on one side, or null. @param {string} side @param {number} question @param {string} key */
	const median = (side, question, key) => {
		const values = answered(side, question)
			.map((/** @type {any} */ r) => r[key])
			.filter((/** @type {unknown} */ n) => typeof n === 'number');
		return values.length === 0 ? null : summarize(values).median;
	};
	/** @param {number | null} n */
	const cell = n => (n === null ? 'not measured' : tokens(n));
	/** @param {boolean | undefined} inBrief */
	const inBriefCell = inBrief =>
		inBrief === undefined ? 'not recorded' : inBrief ? 'yes' : 'no';
	const byQuestion = questionList.map((q, index) => {
		const number = index + 1;
		const withTokens = median('with', number, 'inputTokens');
		const withoutTokens = median('without', number, 'inputTokens');
		return {
			q,
			number,
			ratio:
				withTokens === null || withoutTokens === null
					? null
					: ratio(withTokens, withoutTokens),
			row: [
				q.label ?? q.question,
				inBriefCell(q.inBrief),
				cell(withTokens),
				cell(median('with', number, 'turns')),
				cell(withoutTokens),
				cell(median('without', number, 'turns')),
				withTokens === null || withoutTokens === null
					? 'not measured'
					: times(ratio(withTokens, withoutTokens)),
			],
		};
	});
	if (byQuestion.length > 0) {
		out.push(
			'### By question',
			'The tokens and turns are medians of the question’s runs on each side, and the last column divides one median by the other. The second column says whether the question’s rule was in the default brief that the sessions with chamoji received.',
			table(
				[
					'Question',
					'Rule in the brief',
					'With chamoji, input tokens',
					'With chamoji, turns',
					'Without, input tokens',
					'Without, turns',
					'Without ÷ with',
				],
				byQuestion.map(({row}) => row),
			),
		);
		if (questionList.some(q => q.inBrief === undefined)) {
			out.push(
				'This sample was run before the runner recorded which rules were in the brief, so that column reads not recorded.',
			);
		}
	}

	const totalWith = total('with', 'inputTokens');
	const totalWithout = total('without', 'inputTokens');
	if (answered('with').length > 0 && answered('without').length > 0) {
		const relating = [];
		if (replay?.typicalSwitch) {
			relating.push(
				`The replay below counts what an agent with git alone would read if it read the whole log and each commit in full, and gets ${times(replay.typicalSwitch.ratio)}.`,
			);
		}

		relating.push(
			`${relating.length > 0 ? 'The sessions without chamoji searched instead, and in total spent' : 'In total the sessions without chamoji spent'} ${tokens(totalWithout)} input tokens against ${tokens(totalWith)} with it: ${times(ratio(totalWith, totalWithout))} as many.`,
		);
		const ratios = byQuestion
			.map(({ratio}) => ratio)
			.filter(value => value !== null);
		if (ratios.length > 1) {
			relating.push(
				`By question, at the median, the ratio ran from ${times(Math.min(...ratios))} to ${times(Math.max(...ratios))}.`,
			);
		}

		const cut = byQuestion.filter(
			({q, number}) =>
				q.inBrief === false && answered('with', number).length > 0,
		);
		if (cut.length > 0) {
			const those = cut.length === 1 ? '1 question' : `${cut.length} questions`;
			const called = cut.every(
				({number}) => (median('with', number, 'toolCalls') ?? 0) >= 1,
			);
			relating.push(
				called
					? `On the ${those} whose rule the default brief left out, the sessions with chamoji needed a tool call as well.`
					: `On the ${those} whose rule the default brief left out, the brief did not hold the answer; the table by question shows what those sessions spent.`,
			);
		}

		out.push(relating.join(' '));
	}

	const unknown =
		(summary.with.toolCallsUnknown ?? 0) +
		(summary.without.toolCallsUnknown ?? 0);
	if (unknown > 0) {
		out.push(
			`${unknown} ${unknown === 1 ? 'run' : 'runs'} took more than one turn but showed no tool call in the debug log, so ${unknown === 1 ? 'it is' : 'they are'} left out of the tool-call figures.`,
		);
	}
	if (failed > 0) {
		out.push(
			`${failed} of ${runs.length} runs failed and ${failed === 1 ? 'is' : 'are'} left out of the figures.`,
		);
	}

	if (checked) {
		const right = (/** @type {string} */ side) => {
			const sideRuns = answered(side);
			return [
				sideRuns.filter((/** @type {any} */ r) => r.correct === true).length,
				sideRuns.length,
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
