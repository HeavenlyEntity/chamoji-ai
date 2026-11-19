#!/usr/bin/env node
// How many tokens an agent spends recovering this project's context, with
// chamoji and with git alone: what stands (the brief against the log) and why
// a line is the way it is (the card against blame-then-show and the file's
// history), on a fixed sample of lines. It measures in a throwaway clone of
// the checkout, so the checkout is never written to. Token figures are
// estimates at 4 characters a token.
//
//   pnpm benchmark:memory                 print the figures
//   pnpm benchmark:memory --pick-sample   write scripts/memory-benchmark/sample.json
import {execFileSync} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {
	assertFullHistory,
	locateSample,
	measureFileHistory,
	measureWhatStands,
	measureWhy,
	sampleCandidates,
} from './lib/memory-measure.mjs';
import {
	CHARS_PER_TOKEN,
	pickSample,
	ratio,
	summarize,
	typicalSwitch,
	windowShares,
} from './lib/memory-tokens.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const sampleFile = path.join(root, 'scripts/memory-benchmark/sample.json');
const SAMPLE_SIZE = 20;
const LOOKUPS = 5;
const CHAT_EXAMPLE = 'packages/core/src/release.ts';

/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 512 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

/**
 * Every figure the benchmark reports, measured in `repo` at its HEAD.
 * @param {{repo: string, sample: import('./lib/memory-measure.mjs').SampleLine[], ranAt: {tag: string | null, commit: string, date: string}}} input
 */
function buildResults({repo, sample, ranAt}) {
	const whatStands = measureWhatStands(repo, cli);
	const {found, dropped} = locateSample(repo, sample);
	const perLine = found.map(line => measureWhy(repo, cli, line));
	const card = summarize(perLine.map(line => line.card));
	const blameShow = summarize(perLine.map(line => line.blameShow));
	const fileHistory = summarize(perLine.map(line => line.fileHistory));
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
		method: {charsPerToken: CHARS_PER_TOKEN, lookups: LOOKUPS},
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
	};
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

function main() {
	if (!existsSync(cli)) {
		console.error('Run pnpm build first.');
		return 2;
	}

	const args = process.argv.slice(2);
	const unknown = args.filter(arg => arg !== '--pick-sample');
	if (unknown.length > 0) {
		console.error(
			`Unknown option ${unknown[0]}. Usage: pnpm benchmark:memory [--pick-sample]`,
		);
		return 2;
	}

	const picking = args.includes('--pick-sample');
	const checkout = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
	try {
		assertFullHistory(checkout);
	} catch (error) {
		console.error(/** @type {Error} */ (error).message);
		return 2;
	}

	if (!picking && !existsSync(sampleFile)) {
		console.error(
			'There is no sample yet: run pnpm benchmark:memory --pick-sample first.',
		);
		return 2;
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
		printSummary(
			buildResults({
				repo,
				sample,
				ranAt: {
					tag: tagAtHead(checkout),
					commit,
					date: new Date().toISOString().slice(0, 10),
				},
			}),
		);
		return 0;
	} finally {
		rmSync(scratch, {recursive: true, force: true});
	}
}

process.exitCode = main();
