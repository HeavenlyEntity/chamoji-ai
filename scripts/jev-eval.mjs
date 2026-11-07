#!/usr/bin/env node
// Measures the commit advisor (milestone 5) on history that is already
// labelled: commits in the gitmoji repos carry the gitmoji their authors
// picked. Each commit's gitmoji is stripped, the advisor sees its file list
// and the rest of its subject, and its picks are scored against the label.
//
//   pnpm build && node scripts/jev-eval.mjs [count] [--files-only] [--no-bumps]
//
// --files-only leaves the title out, as when the composer opens before the
// title is written: the advisor then sees only the file list.
// --no-bumps samples only commits that aren't ⬆️ dependency bumps, which
// are most of these repos' history and easy to spot.
//
// Needs TYPESAFE_API_KEY (environment, or .env.local) and the benchmark
// clones in .benchmarks/ (pnpm benchmark). Sends file paths and subjects of
// those public repos only. Prints top-1/top-3 accuracy, latency and how
// accuracy changes with the top pick's probability.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliDir = path.join(root, 'packages/cli');
const require = createRequire(path.join(cliDir, 'package.json'));
const {TypeSafeClient} = await import(
	pathToFileURL(require.resolve('@typesafe-ai/sdk')).href
);
const {createCommitAdvisor} = await import(
	pathToFileURL(path.join(cliDir, 'dist/advisor.js')).href
);
const {findGitmoji, normalizeEmoji} = await import(
	pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href
);

const filesOnly = process.argv.includes('--files-only');
const noBumps = process.argv.includes('--no-bumps');
const COUNT = Number(
	process.argv.slice(2).find(arg => /^\d+$/.test(arg)) ?? 200,
);
const REPOS = ['carloscuesta__gitmoji', 'carloscuesta__gitmoji-cli'];
// Not offered by the advisor, so not fair to score.
const SKIP = new Set(['boom', 'bookmark', 'twisted_rightwards_arrows']);
const STATUS = {A: 'added', M: 'modified', D: 'deleted', R: 'renamed'};

function apiKey() {
	if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
	try {
		const line = readFileSync(path.join(root, '.env.local'), 'utf8')
			.split('\n')
			.find(entry => entry.startsWith('TYPESAFE_API_KEY='));
		return line?.slice('TYPESAFE_API_KEY='.length).trim();
	} catch {
		return undefined;
	}
}

const git = (dir, args) =>
	execFileSync('git', args, {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28});

/** Labelled commits: subject without its gitmoji, the label, and file names. */
function labelled(repo, wanted) {
	const dir = path.join(root, '.benchmarks', repo);
	const lines = git(dir, ['log', '--no-merges', '--format=%H%x1f%s']).split(
		'\n',
	);
	const all = [];
	for (const line of lines) {
		const [hash, subject] = line.split('\x1f');
		if (!hash || !subject) continue;
		const text = normalizeEmoji(subject);
		const found = findGitmoji(text);
		if (!found || SKIP.has(found.code)) continue;
		if (noBumps && found.code === 'arrow_up') continue;
		const rest = (
			text.slice(0, found.index) + text.slice(found.index + found.length)
		)
			.replace(/^\s*(?:\([^)]*\):)?\s*/, '')
			.trim();
		if (rest) all.push({repo, hash, label: found.code, title: rest});
	}

	// Every nth commit, spread across the history.
	const step = Math.max(1, Math.floor(all.length / wanted));
	return all
		.filter((_, index) => index % step === 0)
		.slice(0, wanted)
		.map(commit => ({...commit, files: files(dir, commit.hash)}));
}

/** Names and statuses only: the clones have no file contents, so no line counts. */
function files(dir, hash) {
	const out = git(dir, ['show', '--name-status', '--format=', '-M', hash]);
	return out
		.split('\n')
		.filter(Boolean)
		.slice(0, 50)
		.map(line => {
			const parts = line.split('\t');
			return {
				path: parts.at(-1),
				status: STATUS[parts[0][0]] ?? 'modified',
				added: 0,
				deleted: 0,
			};
		});
}

const key = apiKey();
if (!key) {
	console.error('jev-eval: set TYPESAFE_API_KEY or put it in .env.local');
	process.exit(1);
}

const client = new TypeSafeClient({apiKey: key});
const advise = createCommitAdvisor({
	systemOne: request => client.systemOne(request),
});
const commits = REPOS.flatMap(repo =>
	labelled(repo, Math.ceil(COUNT / REPOS.length)),
);

// One warm-up request, so latency reflects a warm connection.
await advise({
	staged: {files: commits[0].files, withheld: 0},
	draft: commits[0].title,
});

const results = [];
let next = 0;
async function worker() {
	while (next < commits.length) {
		const commit = commits[next++];
		const started = performance.now();
		try {
			const advice = await advise({
				staged: {files: commit.files, withheld: 0},
				draft: filesOnly ? '' : commit.title,
			});
			const codes = advice.gitmojis.map(item => item.code);
			results.push({
				...commit,
				ms: performance.now() - started,
				top1: codes[0] === commit.label,
				top3: codes.includes(commit.label),
				p: advice.gitmojis[0]?.probability ?? 0,
				top: codes[0],
			});
		} catch (error) {
			results.push({...commit, error: error.message});
		}
	}
}

await Promise.all(Array.from({length: 4}, worker));
const ok = results.filter(result => !result.error);
const pct = value => `${(100 * value).toFixed(0)}%`;
const share = (items, test) =>
	items.filter(test).length / Math.max(1, items.length);
const times = ok.map(result => result.ms).sort((a, b) => a - b);
const quantile = q =>
	times[Math.min(times.length - 1, Math.floor(q * times.length))];

console.log(
	`Commits scored: ${ok.length} (${results.length - ok.length} failed), ${filesOnly ? 'file list only' : 'file list and title'}${noBumps ? ', no ⬆️ bumps' : ''}`,
);
console.log(`Top-1 accuracy: ${pct(share(ok, result => result.top1))}`);
console.log(`Top-3 accuracy: ${pct(share(ok, result => result.top3))}`);
// Most of these repos' history is Renovate's ⬆️ bumps, which are easy to
// spot from a lockfile-and-package.json change, so report the rest apart.
const others = ok.filter(result => result.label !== 'arrow_up');
console.log(
	`Without ⬆️ bumps (${others.length} commits): top-1 ${pct(share(others, result => result.top1))}, top-3 ${pct(share(others, result => result.top3))}`,
);
console.log(
	`Latency p50 ${quantile(0.5).toFixed(0)} ms, p95 ${quantile(0.95).toFixed(0)} ms (4 in flight)`,
);
console.log('\n| Top pick probability | Commits | Top-1 accuracy |');
console.log('| -------------------- | ------- | -------------- |');
for (const floor of [0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
	const above = ok.filter(result => result.p >= floor);
	console.log(
		`| ≥ ${floor.toFixed(1)} | ${above.length} | ${pct(share(above, result => result.top1))} |`,
	);
}

const tops = new Map();
for (const result of ok) tops.set(result.top, (tops.get(result.top) ?? 0) + 1);
console.log(
	`\nMost common top picks: ${[...tops]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([code, n]) => `${code} ×${n}`)
		.join(', ')}`,
);

const misses = ok.filter(result => !result.top3).slice(0, 8);
if (misses.length > 0) {
	console.log('\nSome top-3 misses (label → subject):');
	for (const miss of misses) console.log(`  ${miss.label} → ${miss.title}`);
}
