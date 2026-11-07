#!/usr/bin/env node
// How much of each benchmark repo's history chamoji can sort without --ai:
// the share of commits that land in Miscellaneous. The roadmap's activation
// metric is the median of these. Clones go to .benchmarks/ without file
// contents (--filter=blob:none), and later runs just fetch.
//
//   pnpm benchmark [owner/repo ...]
//
// With --search it times the memory index instead: how long `memory reindex`
// takes and how long a `memory search` takes against the index it built. It
// works in a throwaway clone of each repo, so the clones in .benchmarks/ are
// neither fetched nor written to. CHAMOJI_BENCHMARKS points at another folder
// of clones, such as one shared between worktrees.
//
//   pnpm benchmark --search [owner/repo ...]
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const cache = process.env.CHAMOJI_BENCHMARKS ?? path.join(root, '.benchmarks');

export const REPOS = [
	'carloscuesta/gitmoji',
	'carloscuesta/gitmoji-cli',
	'sindresorhus/meow',
	'vitejs/vite',
	// Messy, unstructured history: "Component: description" subjects, and
	// [bugfix]-style tags mixed with plain messages.
	'jquery/jquery',
	'moment/moment',
];

const run = (command, args, cwd) =>
	execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 512 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

function measure(slug) {
	const dir = path.join(cache, slug.replace('/', '__'));
	if (existsSync(dir)) {
		run('git', ['fetch', '--quiet', '--tags', 'origin'], dir);
		run('git', ['reset', '--quiet', '--hard', 'FETCH_HEAD'], dir);
	} else {
		run('git', [
			'clone',
			'--quiet',
			'--filter=blob:none',
			'--no-checkout',
			`https://github.com/${slug}.git`,
			dir,
		]);
	}

	const changelog = JSON.parse(
		run(
			process.execPath,
			[cli, 'changelog', '--format', 'json', '--no-update-check'],
			dir,
		),
	);
	let total = 0;
	let misc = 0;
	for (const release of changelog.releases) {
		const groups = [
			...(release.highlights ?? []).flatMap(highlight => highlight.groups),
			...release.groups,
		];
		for (const group of groups) {
			total += group.commits.length;
			if (group.group === 'misc') misc += group.commits.length;
		}
	}

	return {total, misc};
}

/** Wall time of one CLI run in `cwd`, in milliseconds, and what it printed. */
function timeCli(args, cwd) {
	const start = performance.now();
	const output = run(
		process.execPath,
		[cli, ...args, '--no-update-check'],
		cwd,
	);
	return {ms: performance.now() - start, output};
}

// A search is timed against an index that is already built, as a user's is.
const SEARCH_QUERY = 'fix server hmr';
const SEARCH_RUNS = 5;

function measureSearch(slug) {
	const source = path.join(cache, slug.replace('/', '__'));
	if (!existsSync(source)) {
		throw new Error('not cloned yet; run pnpm benchmark once first');
	}

	// The index goes in the clone's git dir, so use a copy that shares the objects.
	const scratch = mkdtempSync(path.join(tmpdir(), 'chamoji-bench-'));
	try {
		run('git', [
			'clone',
			'--quiet',
			'--no-checkout',
			'--shared',
			source,
			scratch,
		]);
		const build = timeCli(['memory', 'reindex'], scratch);
		const documents = Number(/Indexed (\d+)/.exec(build.output)?.[1]);
		const times = Array.from(
			{length: SEARCH_RUNS},
			() => timeCli(['memory', 'search', SEARCH_QUERY], scratch).ms,
		).sort((a, b) => a - b);
		const size = statSync(
			path.join(scratch, '.git', 'chamoji', 'memory-index.json'),
		).size;
		return {
			documents,
			build: build.ms,
			search: times[Math.floor(SEARCH_RUNS / 2)],
			size,
		};
	} finally {
		rmSync(scratch, {recursive: true, force: true});
	}
}

if (!existsSync(cli)) {
	console.error('benchmark: build first (pnpm build)');
	process.exit(1);
}

const args = process.argv.slice(2);
const searching = args.includes('--search');
const named = args.filter(arg => arg !== '--search');
const repos = named.length > 0 ? named : REPOS;

if (searching) {
	console.log(
		'| Repo | Documents | Index build | Index file | Search (median) |',
	);
	console.log(
		'| ---- | --------- | ----------- | ---------- | --------------- |',
	);
	for (const slug of repos) {
		try {
			const {documents, build, search, size} = measureSearch(slug);
			console.log(
				`| ${slug} | ${documents} | ${(build / 1000).toFixed(2)} s | ${(size / 1e6).toFixed(1)} MB | ${search.toFixed(0)} ms |`,
			);
		} catch (error) {
			const reason = (error.stderr?.toString() || error.message)
				.trim()
				.split('\n')[0];
			console.log(`| ${slug} | failed | ${reason} | | |`);
		}
	}

	console.log(
		'\nTimes are whole CLI runs, node start-up included. Targets on vitejs/vite: build under 5 s, search under 300 ms.',
	);
	process.exit(0);
}

mkdirSync(cache, {recursive: true});
const shares = [];
console.log('| Repo | Commits | Miscellaneous |');
console.log('| ---- | ------- | ------------- |');
for (const slug of repos) {
	try {
		const {total, misc} = measure(slug);
		const share = total ? (100 * misc) / total : 0;
		shares.push(share);
		console.log(`| ${slug} | ${total} | ${share.toFixed(0)}% |`);
	} catch (error) {
		const reason = (error.stderr?.toString() || error.message)
			.trim()
			.split('\n')[0];
		console.log(`| ${slug} | failed | ${reason} |`);
	}
}

shares.sort((a, b) => a - b);
const middle = Math.floor(shares.length / 2);
const median =
	shares.length % 2
		? shares[middle]
		: (shares[middle - 1] + shares[middle]) / 2;
if (shares.length > 0)
	console.log(`\nMedian Miscellaneous: ${median.toFixed(0)}%`);
