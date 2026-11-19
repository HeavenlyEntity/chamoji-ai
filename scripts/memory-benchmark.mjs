#!/usr/bin/env node
// How many tokens an agent would read to recover this project's context,
// with chamoji and with git alone, if it read everything: what stands (the
// brief and chamoji's MCP tool definitions against the log) and why a line
// is the way it is (the card against blame-then-show, the commit's message
// and the file's history), on a fixed sample of lines, and what stands at
// each release tag from v0.11.0. It measures in a throwaway clone of the
// checkout. Token figures are estimates at 4 characters a token, except the
// exact column.
//
// The checkout is written to only by these flags: --write (the results file
// and the page), --page-only (the page) and --pick-sample (a sample file).
//
//   pnpm benchmark:memory                 print the figures
//   pnpm benchmark:memory --write         also write docs/benchmarks/memory-tokens.json
//                                         and both data sections of the docs page,
//                                         the live one from the live sample's file
//   pnpm benchmark:memory --page-only     measure nothing; re-render both data
//                                         sections of the page from the two
//                                         results files as they are
//   pnpm benchmark:memory --exact         add exact counts (needs ANTHROPIC_API_KEY)
//   pnpm benchmark:memory --pick-sample   write scripts/memory-benchmark/sample.json
//                                         (this repo only)
//   pnpm benchmark:memory --pick-sample --sample <file>
//                                         write a sample for the repo you run it in
//   pnpm benchmark:memory --sample <file> read the sample from another file
import {execFileSync} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
	assertFullHistory,
	exactCounts,
	isolatedGitEnv,
	locateSample,
	measureFileHistory,
	measureGrowth,
	measureMcpTools,
	measureWhatStands,
	measureWhy,
	releaseTags,
	sampleCandidates,
	textsForExact,
} from './lib/memory-measure.mjs';
import {
	CHARS_PER_TOKEN,
	NO_LINES_MEASURED,
	pickSample,
	renderLive,
	renderTables,
	replaceSection,
	roundedSummary,
	summarize,
	switchFigures,
	typicalSwitch,
	windowShares,
} from './lib/memory-tokens.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const defaultSampleFile = path.join(
	root,
	'scripts/memory-benchmark/sample.json',
);
const SAMPLE_SIZE = 20;
const LOOKUPS = 5;
const CHAT_EXAMPLE = 'packages/core/src/release.ts';
const EXACT_MODEL = 'claude-sonnet-5-5';
const RESULTS_FILE = 'docs/benchmarks/memory-tokens.json';
const LIVE_FILE = 'docs/benchmarks/memory-tokens-live.json';
const PAGE_FILE = 'docs/site/guides/memory-tokens.mdx';
const LIVE_HEADING = '## What real sessions spent';
const REPLAY_HEADING = '## The replay: reading everything';

/**
 * The runner's own git calls (finding the checkout, making the clone), in the
 * same isolated environment as the measured ones.
 * @param {string[]} args @param {string} cwd
 */
const git = (args, cwd) =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: isolatedGitEnv(),
		maxBuffer: 512 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

/**
 * Every figure the benchmark reports, measured in `repo` at its HEAD, and what
 * stands at each of `tags`. The typical switch is worked out from the rounded
 * means, so the file agrees with itself. With no line measured there is no
 * typical switch and no window.
 * @param {{repo: string, sample: import('./lib/memory-measure.mjs').SampleLine[], tags: string[], ranAt: {tag: string | null, commit: string, date: string}, budgets: {briefBudget: number, uncutBudget: number}}} input
 */
function buildResults({repo, sample, tags, ranAt, budgets}) {
	const whatStands = {
		...measureWhatStands(repo, cli, budgets.uncutBudget),
		mcpTools: measureMcpTools(repo, cli),
	};
	const {found, dropped} = locateSample(repo, sample);
	const perLine = found.map(line => measureWhy(repo, cli, line));
	const why = {
		sampleSize: found.length,
		dropped: dropped.length,
		card: roundedSummary(perLine.map(line => line.card)),
		blameShow: roundedSummary(perLine.map(line => line.blameShow)),
		blameMessage: roundedSummary(perLine.map(line => line.blameMessage)),
		fileHistory: roundedSummary(perLine.map(line => line.fileHistory)),
		perLine,
	};
	const change = switchFigures({whatStands, why, lookups: LOOKUPS});
	return {
		version: 2,
		ranAt,
		method: {
			charsPerToken: CHARS_PER_TOKEN,
			lookups: LOOKUPS,
			refsAsOf: 'HEAD',
			...budgets,
		},
		whatStands,
		why,
		typicalSwitch: change,
		windows: change
			? windowShares({withTokens: change.with, withoutTokens: change.without})
			: [],
		chatExample: {
			file: CHAT_EXAMPLE,
			fileHistory: measureFileHistory(repo, CHAT_EXAMPLE),
		},
		growth: measureGrowth(repo, cli, tags, {
			uncutBudget: budgets.uncutBudget,
			onTag: (tag, index) =>
				console.error(`Reading ${tag} (${index + 1} of ${tags.length})`),
		}),
		/** @type {{model: string, typicalSwitch: {with: number, without: number}} | null} */
		exact: null,
	};
}

/**
 * The typical switch in exact tokens: the brief and the MCP tool definitions
 * plus five times the mean exact why, against the log plus five times the
 * mean exact blame-then-show. Null,
 * with one line saying why, when there is no key or a request fails.
 * @param {string} repo
 * @param {Array<{location: string, commit: string}>} perLine
 */
async function exactColumn(repo, perLine) {
	try {
		const texts = textsForExact(repo, cli, perLine);
		const counts = await exactCounts(
			[
				texts.brief,
				texts.mcpTools,
				texts.log,
				...texts.why,
				...texts.blameShow,
			],
			EXACT_MODEL,
		);
		if (!counts) {
			console.error(
				'No API key in the environment, so the exact column was skipped.',
			);
			return null;
		}

		const [brief, mcpTools, log, ...lines] = counts;
		const why = lines.slice(0, perLine.length);
		const blameShow = lines.slice(perLine.length);
		return {
			model: EXACT_MODEL,
			typicalSwitch: {
				with: typicalSwitch({
					whatStands: brief + mcpTools,
					whyMean: summarize(why).mean,
					lookups: LOOKUPS,
				}),
				without: typicalSwitch({
					whatStands: log,
					whyMean: summarize(blameShow).mean,
					lookups: LOOKUPS,
				}),
			},
		};
	} catch (error) {
		console.error(
			`The exact column was skipped: ${/** @type {Error} */ (error).message}.`,
		);
		return null;
	}
}

/** @param {number} n */
const count = n => Math.round(n).toLocaleString('en-US');
/** @param {number} share */
const percent = share => `${(share * 100).toFixed(1)}%`;

/** @param {ReturnType<typeof buildResults>} results */
function printSummary(results) {
	const {ranAt, whatStands, why, typicalSwitch: change, windows} = results;
	/** @param {string} label @param {...string} cells */
	const row = (label, ...cells) =>
		console.log(
			`  ${label.padEnd(28)}${cells.map(cell => cell.padStart(10)).join('')}`,
		);

	console.log(
		`Memory token benchmark at ${ranAt.commit.slice(0, 7)}${ranAt.tag ? ` (${ranAt.tag})` : ''}, ${ranAt.date}`,
	);
	console.log(`Tokens are estimates at ${CHARS_PER_TOKEN} characters a token.`);
	console.log('\nWhat stands');
	row(
		'chamoji memory brief',
		count(whatStands.brief.tokens),
		`  ${whatStands.briefLines} of ${whatStands.cardLines} lines`,
	);
	row(
		'brief, uncut',
		count(whatStands.briefUncut.tokens),
		`  ${whatStands.briefUncut.lines} of ${whatStands.cardLines} lines`,
	);
	row('MCP tool definitions', count(whatStands.mcpTools.tokens));
	row('git log', count(whatStands.log.tokens));
	row('notes file', count(whatStands.notesFile.tokens));

	console.log(
		`\nWhy, per line (${why.sampleSize} lines measured, ${why.dropped} dropped)`,
	);
	if (!change) {
		console.log(NO_LINES_MEASURED);
	} else {
		row('', 'mean', 'median');
		for (const [label, figures] of /** @type {const} */ ([
			['chamoji why', why.card],
			['git blame, then git show', why.blameShow],
			['git blame, then the message', why.blameMessage],
			['git log -p on the file', why.fileHistory],
		])) {
			row(label, count(figures.mean), count(figures.median));
		}

		console.log(`\nTypical switch: what stands plus ${LOOKUPS} whys`);
		row('', 'tokens', 'saved', 'ratio');
		row('with chamoji', count(change.with));
		row(
			'git alone, read in full',
			count(change.without),
			count(change.saved),
			change.ratio === null ? '' : `${change.ratio}x`,
		);
		row(
			'git alone, messages only',
			count(change.messagesOnly.without),
			count(change.messagesOnly.saved),
			change.messagesOnly.ratio === null ? '' : `${change.messagesOnly.ratio}x`,
		);

		console.log('\nShare of a context window, if git alone read in full');
		row('', 'with', 'without');
		for (const window of windows) {
			row(
				`${count(window.window)} tokens`,
				percent(window.withShare),
				percent(window.withoutShare),
			);
		}
	}

	if (results.growth.length > 0) {
		console.log('\nWhat stands at each release');
		row('', 'commits', 'brief', 'uncut', 'git log', 'notes');
		for (const tag of results.growth) {
			row(
				tag.tag,
				count(tag.commits),
				count(tag.brief),
				count(tag.briefUncut),
				count(tag.log),
				count(tag.notesFile),
			);
		}
	}

	if (results.exact) {
		console.log(`\nTypical switch in exact tokens (${results.exact.model})`);
		row('with chamoji', count(results.exact.typicalSwitch.with));
		row('git alone, read in full', count(results.exact.typicalSwitch.without));
	}
}

/**
 * @param {string[]} args
 * @returns {{picking: boolean, writing: boolean, pageOnly: boolean, exact: boolean, sampleFile: string} | {error: string}}
 */
function parseArgs(args) {
	let picking = false;
	let writing = false;
	let pageOnly = false;
	let exact = false;
	let sampleFile = defaultSampleFile;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--pick-sample') picking = true;
		else if (args[i] === '--write') writing = true;
		else if (args[i] === '--page-only') pageOnly = true;
		else if (args[i] === '--exact') exact = true;
		else if (args[i] === '--sample') {
			const file = args[++i];
			if (!file) return {error: '--sample needs a file.'};
			sampleFile = path.resolve(file);
		} else return {error: `Unknown option ${args[i]}.`};
	}

	if (picking && (writing || exact || pageOnly)) {
		return {error: '--pick-sample goes on its own, or with --sample.'};
	}

	if (pageOnly && (writing || exact || sampleFile !== defaultSampleFile)) {
		return {error: '--page-only goes on its own.'};
	}

	return {picking, writing, pageOnly, exact, sampleFile};
}

/** The tag at HEAD, or null. @param {string} checkout */
function tagAtHead(checkout) {
	try {
		return git(
			['describe', '--tags', '--exact-match', 'HEAD'],
			checkout,
		).trim();
	} catch {
		return null;
	}
}

/**
 * Why the page can't take both data sections, or null when it can.
 * @param {string} pageFile @param {string} flag
 */
function pageProblem(pageFile, flag) {
	if (!existsSync(pageFile)) {
		return `There is no page at ${PAGE_FILE} in this checkout, so ${flag} has nowhere to put the tables, and nothing was written.`;
	}

	for (const heading of [LIVE_HEADING, REPLAY_HEADING]) {
		if (replaceSection(readFileSync(pageFile, 'utf8'), heading, '') === null) {
			return `${PAGE_FILE} has no "${heading}" heading, so ${flag} has nowhere to put the tables, and nothing was written.`;
		}
	}

	return null;
}

/** The live sample's results in the checkout, or null. @param {string} checkout */
function readLive(checkout) {
	const liveFile = path.join(checkout, ...LIVE_FILE.split('/'));
	return existsSync(liveFile)
		? JSON.parse(readFileSync(liveFile, 'utf8'))
		: null;
}

/**
 * The page with both data sections rendered: the live sample's from its
 * file, with the sentence that relates it to the replay, and the replay's
 * from its results.
 * @param {string} pageFile @param {any} results @param {any} live
 */
function renderPage(pageFile, results, live) {
	const withLive = replaceSection(
		readFileSync(pageFile, 'utf8'),
		LIVE_HEADING,
		renderLive(live, results),
	);
	const page =
		withLive === null
			? null
			: replaceSection(withLive, REPLAY_HEADING, renderTables(results));
	if (page === null) throw new Error(`${PAGE_FILE} lost a heading.`);
	return page;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if ('error' in options) {
		console.error(
			`${options.error} Usage: pnpm benchmark:memory [--write] [--exact] [--sample <file>] | --page-only | --pick-sample [--sample <file>]`,
		);
		return 2;
	}

	const {picking, writing, pageOnly, exact, sampleFile} = options;
	if (!pageOnly && !existsSync(cli)) {
		console.error('Run pnpm build first.');
		return 2;
	}

	const checkout = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
	const pageFile = path.join(checkout, ...PAGE_FILE.split('/'));
	const resultsFile = path.join(checkout, ...RESULTS_FILE.split('/'));

	// --write and --page-only fill in the page, so check the page is there and
	// has its headings before anything else: a run that can't write both
	// writes neither.
	if (writing || pageOnly) {
		const problem = pageProblem(pageFile, writing ? '--write' : '--page-only');
		if (problem) {
			console.error(problem);
			return 2;
		}
	}

	if (pageOnly) {
		if (!existsSync(resultsFile)) {
			console.error(
				`There is no ${RESULTS_FILE} in this checkout, so --page-only has nothing to render, and nothing was written.`,
			);
			return 2;
		}

		const live = readLive(checkout);
		writeFileSync(
			pageFile,
			renderPage(pageFile, JSON.parse(readFileSync(resultsFile, 'utf8')), live),
		);
		console.log(
			`Wrote ${PAGE_FILE} from ${RESULTS_FILE}${live ? ` and ${LIVE_FILE}` : ''}.`,
		);
		return 0;
	}

	if (
		picking &&
		sampleFile === defaultSampleFile &&
		realpathSync(checkout) !== realpathSync(root)
	) {
		console.error(
			"Run --pick-sample from this repo, since it writes this repo's sample. To pick a sample for another repo, add --sample <file>.",
		);
		return 2;
	}

	try {
		assertFullHistory(checkout);
	} catch (error) {
		console.error(/** @type {Error} */ (error).message);
		return 2;
	}

	if (!picking && !existsSync(sampleFile)) {
		console.error(
			sampleFile === defaultSampleFile
				? 'There is no sample yet: run pnpm benchmark:memory --pick-sample first.'
				: `There is no sample at ${sampleFile}.`,
		);
		return 2;
	}

	/** @type {{DEFAULT_BRIEF_BUDGET: number, MAX_BRIEF_BUDGET: number}} */
	const core = await import(
		pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href
	);
	const budgets = {
		briefBudget: core.DEFAULT_BRIEF_BUDGET,
		uncutBudget: core.MAX_BRIEF_BUDGET,
	};

	const commit = git(['rev-parse', 'HEAD'], checkout).trim();
	// chamoji keeps caches in the git dir, so measure in a clone that shares
	// the checkout's objects. It is removed only after every git and chamoji
	// call has exited: they all run synchronously.
	const scratch = mkdtempSync(path.join(tmpdir(), 'chamoji-memory-bench-'));
	try {
		const repo = path.join(scratch, 'repo');
		git(
			['clone', '--quiet', '--no-checkout', '--shared', checkout, repo],
			scratch,
		);
		git(
			[
				'fetch',
				'--quiet',
				'origin',
				'refs/chamoji/*:refs/chamoji/*',
				'refs/notes/*:refs/notes/*',
			],
			repo,
		);
		git(['checkout', '--quiet', '--detach', commit], repo);

		if (picking) {
			const sample = pickSample(sampleCandidates(repo, cli), SAMPLE_SIZE).map(
				({commit, file, line, text}) => ({commit, file, line, text}),
			);
			mkdirSync(path.dirname(sampleFile), {recursive: true});
			writeFileSync(sampleFile, `${JSON.stringify(sample, null, '\t')}\n`);
			const shown =
				sampleFile === defaultSampleFile
					? path.relative(root, sampleFile).split(path.sep).join('/')
					: sampleFile;
			console.log(`Wrote ${sample.length} sample lines to ${shown}.`);
			return 0;
		}

		const sample = JSON.parse(readFileSync(sampleFile, 'utf8'));
		const results = buildResults({
			repo,
			sample,
			tags: releaseTags(repo),
			ranAt: {
				tag: tagAtHead(checkout),
				commit,
				date: new Date().toISOString().slice(0, 10),
			},
			budgets,
		});
		if (exact && results.typicalSwitch) {
			results.exact = await exactColumn(repo, results.why.perLine);
		}

		printSummary(results);
		if (writing) {
			if (!results.typicalSwitch) {
				console.error(`${NO_LINES_MEASURED} Nothing was written.`);
				return 2;
			}

			// The page is built from the file's own text, so the two agree
			// exactly, and its live section from the live sample's file when
			// there is one. The results go first, then the page.
			const text = `${JSON.stringify(results, null, '\t')}\n`;
			const page = renderPage(pageFile, JSON.parse(text), readLive(checkout));
			mkdirSync(path.dirname(resultsFile), {recursive: true});
			writeFileSync(resultsFile, text);
			writeFileSync(pageFile, page);
			console.log(`\nWrote ${RESULTS_FILE} and ${PAGE_FILE}.`);
		}

		return 0;
	} finally {
		rmSync(scratch, {recursive: true, force: true});
	}
}

process.exitCode = await main();
