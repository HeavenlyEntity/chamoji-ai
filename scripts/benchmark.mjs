#!/usr/bin/env node
// How much of each benchmark repo's history chamoji can sort without --ai:
// the share of commits that land in Miscellaneous. The roadmap's activation
// metric is the median of these. Clones go to .benchmarks/ without file
// contents (--filter=blob:none), and later runs just fetch.
//
//   pnpm benchmark [owner/repo ...]
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const cache = path.join(root, '.benchmarks');

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
		for (const group of release.groups) {
			total += group.commits.length;
			if (group.group === 'misc') misc += group.commits.length;
		}
	}

	return {total, misc};
}

if (!existsSync(cli)) {
	console.error('benchmark: build first (pnpm build)');
	process.exit(1);
}

mkdirSync(cache, {recursive: true});
const repos = process.argv.slice(2).length > 0 ? process.argv.slice(2) : REPOS;
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
