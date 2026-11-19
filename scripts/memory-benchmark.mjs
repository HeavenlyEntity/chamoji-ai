#!/usr/bin/env node
// How many tokens an agent spends recovering this project's context, with
// chamoji and with git alone: what stands (the brief against the log) and why
// a line is the way it is (the card against blame-then-show and the file's
// history), on a fixed sample of lines, and what stands at each release tag
// from v0.11.0. It measures in a throwaway clone of the checkout, so the
// checkout is never written to except by --write. Token figures are
// estimates at 4 characters a token, except the exact column.
//
//   pnpm benchmark:memory                 print the figures
//   pnpm benchmark:memory --write         also write docs/benchmarks/memory-tokens.json
//                                         and the tables on the docs page
//   pnpm benchmark:memory --exact         add exact counts (needs ANTHROPIC_API_KEY)
//   pnpm benchmark:memory --pick-sample   write scripts/memory-benchmark/sample.json
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
import {fileURLToPath} from 'node:url';
import {
	assertFullHistory,
	exactCounts,
	isolatedGitEnv,
	locateSample,
	measureFileHistory,
	measureGrowth,
	measureWhatStands,
	measureWhy,
	releaseTags,
	sampleCandidates,
	textsForExact,
} from './lib/memory-measure.mjs';
import {
	CHARS_PER_TOKEN,
	pickSample,
	ratio,
	renderTables,
	replaceSection,
	summarize,
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
const PAGE_FILE = 'docs/site/guides/memory-tokens.mdx';
const NUMBERS_HEADING = '## The numbers';

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

/** @param {number} n */
const oneDecimal = n => Math.round(n * 10) / 10;

/**
 * `summarize` with each figure to 1 decimal, as the results file keeps it.
 * @param {number[]} numbers
 */
function summary(numbers) {
	const {mean, median, min, max} = summarize(numbers);
	return {
		mean: oneDecimal(mean),
		median: oneDecimal(median),
		min: oneDecimal(min),
		max: oneDecimal(max),
	};
}

/**
 * Every figure the benchmark reports, measured in `repo` at its HEAD, and what
 * stands at each of `tags`. The typical switch is worked out from the rounded
 * means, so the file agrees with itself.
 * @param {{repo: string, sample: import('./lib/memory-measure.mjs').SampleLine[], tags: string[], ranAt: {tag: string | null, commit: string, date: string}}} input
 */
function buildResults({repo, sample, tags, ranAt}) {
	const whatStands = measureWhatStands(repo, cli);
	const {found, dropped} = locateSample(repo, sample);
	const perLine = found.map(line => measureWhy(repo, cli, line));
	const card = summary(perLine.map(line => line.card));
	const blameShow = summary(perLine.map(line => line.blameShow));
	const fileHistory = summary(perLine.map(line => line.fileHistory));
	const withTokens = typicalSwitch({
		whatStands: whatStands.brief.tokens,
		whyMean: card.mean,
		lookups: LOOKUPS,
	});
	const withoutTokens = typicalSwitch({
		whatStands: whatStands.log.tokens,
		whyMean: blameShow.mean,
		lookups: LOOKUPS,
	});
	return {
		version: 1,
		ranAt,
		method: {
			charsPerToken: CHARS_PER_TOKEN,
			lookups: LOOKUPS,
			refsAsOf: 'HEAD',
		},
		whatStands,
		why: {
			sampleSize: found.length,
			dropped: dropped.length,
			card,
			blameShow,
			fileHistory,
			perLine,
		},
		typicalSwitch: {
			with: withTokens,
			without: withoutTokens,
			saved: withoutTokens - withTokens,
			ratio: ratio(withTokens, withoutTokens),
		},
		windows: windowShares({withTokens, withoutTokens}),
		chatExample: {
			file: CHAT_EXAMPLE,
			fileHistory: measureFileHistory(repo, CHAT_EXAMPLE),
		},
		growth: measureGrowth(repo, cli, tags, {
			onTag: (tag, index) =>
				console.error(`Reading ${tag} (${index + 1} of ${tags.length})`),
		}),
		/** @type {{model: string, typicalSwitch: {with: number, without: number}} | null} */
		exact: null,
	};
}

/**
 * The typical switch in exact tokens: the brief plus five times the mean exact
 * why, against the log plus five times the mean exact blame-then-show. Null,
 * with one line saying why, when there is no key or a request fails.
 * @param {string} repo
 * @param {Array<{location: string, commit: string}>} perLine
 */
async function exactColumn(repo, perLine) {
	try {
		const texts = textsForExact(repo, cli, perLine);
		const counts = await exactCounts(
			[texts.brief, texts.log, ...texts.why, ...texts.blameShow],
			EXACT_MODEL,
		);
		if (!counts) {
			console.error(
				'No API key in the environment, so the exact column was skipped.',
			);
			return null;
		}

		const [brief, log, ...lines] = counts;
		const why = lines.slice(0, perLine.length);
		const blameShow = lines.slice(perLine.length);
		return {
			model: EXACT_MODEL,
			typicalSwitch: {
				with: typicalSwitch({
					whatStands: brief,
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
	row('chamoji memory brief', count(whatStands.brief.tokens));
	row('git log', count(whatStands.log.tokens));
	row('notes file', count(whatStands.notesFile.tokens));

	console.log(
		`\nWhy, per line (${why.sampleSize} lines measured, ${why.dropped} dropped)`,
	);
	row('', 'mean', 'median');
	for (const [label, figures] of /** @type {const} */ ([
		['chamoji why', why.card],
		['git blame, then git show', why.blameShow],
		['git log -p on the file', why.fileHistory],
	])) {
		row(label, count(figures.mean), count(figures.median));
	}

	console.log(`\nTypical switch: what stands plus ${LOOKUPS} whys`);
	row('with chamoji', count(change.with));
	row('git alone', count(change.without));
	row(
		'saved',
		count(change.saved),
		change.ratio === null ? '' : `${change.ratio}x`,
	);

	console.log('\nShare of a context window');
	row('', 'with', 'without');
	for (const window of windows) {
		row(
			`${count(window.window)} tokens`,
			percent(window.withShare),
			percent(window.withoutShare),
		);
	}

	if (results.growth.length > 0) {
		console.log('\nWhat stands at each release');
		row('', 'commits', 'brief', 'git log', 'notes');
		for (const tag of results.growth) {
			row(
				tag.tag,
				count(tag.commits),
				count(tag.brief),
				count(tag.log),
				count(tag.notesFile),
			);
		}
	}

	if (results.exact) {
		console.log(`\nTypical switch in exact tokens (${results.exact.model})`);
		row('with chamoji', count(results.exact.typicalSwitch.with));
		row('git alone', count(results.exact.typicalSwitch.without));
	}
}

/**
 * @param {string[]} args
 * @returns {{picking: boolean, writing: boolean, exact: boolean, sampleFile: string} | {error: string}}
 */
function parseArgs(args) {
	let picking = false;
	let writing = false;
	let exact = false;
	let sampleFile = defaultSampleFile;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--pick-sample') picking = true;
		else if (args[i] === '--write') writing = true;
		else if (args[i] === '--exact') exact = true;
		else if (args[i] === '--sample') {
			const file = args[++i];
			if (!file) return {error: '--sample needs a file.'};
			sampleFile = path.resolve(file);
		} else return {error: `Unknown option ${args[i]}.`};
	}

	if (picking && (sampleFile !== defaultSampleFile || writing || exact)) {
		return {error: '--pick-sample goes on its own.'};
	}

	return {picking, writing, exact, sampleFile};
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

async function main() {
	if (!existsSync(cli)) {
		console.error('Run pnpm build first.');
		return 2;
	}

	const options = parseArgs(process.argv.slice(2));
	if ('error' in options) {
		console.error(
			`${options.error} Usage: pnpm benchmark:memory [--write] [--exact] [--sample <file>] | --pick-sample`,
		);
		return 2;
	}

	const {picking, writing, exact, sampleFile} = options;
	const checkout = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
	if (picking && realpathSync(checkout) !== realpathSync(root)) {
		console.error(
			"Run --pick-sample from this repo, since it writes this repo's sample.",
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

	// --write also fills in the page, so check the page is there and has its
	// heading before measuring: a run that can't write both writes neither.
	const pageFile = path.join(checkout, ...PAGE_FILE.split('/'));
	if (writing) {
		if (!existsSync(pageFile)) {
			console.error(
				`There is no page at ${PAGE_FILE} in this checkout, so --write has nowhere to put the tables, and nothing was written.`,
			);
			return 2;
		}

		if (
			replaceSection(readFileSync(pageFile, 'utf8'), NUMBERS_HEADING, '') ===
			null
		) {
			console.error(
				`${PAGE_FILE} has no "${NUMBERS_HEADING}" heading, so --write has nowhere to put the tables, and nothing was written.`,
			);
			return 2;
		}
	}

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
			console.log(
				`Wrote ${sample.length} sample lines to ${path.relative(root, sampleFile).split(path.sep).join('/')}.`,
			);
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
		});
		if (exact) results.exact = await exactColumn(repo, results.why.perLine);
		printSummary(results);
		if (writing) {
			// The page is built from the file's own text, so the two agree
			// exactly. The results go first, then the page.
			const text = `${JSON.stringify(results, null, '\t')}\n`;
			const page = replaceSection(
				readFileSync(pageFile, 'utf8'),
				NUMBERS_HEADING,
				renderTables(JSON.parse(text)),
			);
			if (page === null) throw new Error(`${PAGE_FILE} lost its heading.`);
			const file = path.join(checkout, ...RESULTS_FILE.split('/'));
			mkdirSync(path.dirname(file), {recursive: true});
			writeFileSync(file, text);
			writeFileSync(pageFile, page);
			console.log(`\nWrote ${RESULTS_FILE} and ${PAGE_FILE}.`);
		}

		return 0;
	} finally {
		rmSync(scratch, {recursive: true, force: true});
	}
}

process.exitCode = await main();
