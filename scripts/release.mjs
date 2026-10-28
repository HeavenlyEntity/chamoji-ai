#!/usr/bin/env node
// Cuts a release with chamoji itself: next-version → bump packages →
// CHANGELOG.md → commit → annotated tag. Never pushes or publishes.
//
//   pnpm release [--dry-run] [--trailer "Key: value"]...
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const packages = ['packages/core/package.json', 'packages/cli/package.json'];
const changelog = 'CHANGELOG.md';
const NOTHING_TO_RELEASE = 3;

// Tools run through Node rather than through pnpm/npx shims, so this works
// on Windows too, where those are .cmd files.
const require = createRequire(path.join(root, 'package.json'));
const tsc = require.resolve('typescript/bin/tsc');
const prettier = require.resolve('prettier/bin/prettier.cjs');

const fail = (message, code = 1) => {
	console.error(`release: ${message}`);
	process.exit(code);
};

// Strict, so a typo like --dryrun stops instead of cutting a real release.
let flags;
try {
	({values: flags} = parseArgs({
		options: {
			'dry-run': {type: 'boolean', default: false},
			trailer: {type: 'string', multiple: true, default: []},
		},
	}));
} catch (error) {
	fail(
		`${error.message}\nusage: pnpm release [--dry-run] [--trailer "Key: value"]...`,
	);
}

const dryRun = flags['dry-run'];
const trailers = flags.trailer.flatMap(trailer => ['--trailer', trailer]);

const run = (command, commandArgs, options = {}) =>
	execFileSync(command, commandArgs, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		...options,
	});

// 1. Check everything before changing anything.
if (run('git', ['status', '--porcelain']).trim()) {
	fail('the working tree has uncommitted changes; commit or stash them first');
}

const branch = run('git', ['branch', '--show-current']).trim();
if (branch !== 'main') {
	if (dryRun) {
		console.log(`(dry run on ${branch}; a real release must run on main)`);
	} else {
		fail(`releases are cut from main, not ${branch}`);
	}
}

for (const project of ['packages/core', 'packages/cli']) {
	run(process.execPath, [tsc, '-p', project], {
		stdio: ['ignore', 'inherit', 'inherit'],
	});
}

const next = spawnSync(process.execPath, [cli, 'next-version'], {
	cwd: root,
	encoding: 'utf8',
});
if (next.status === NOTHING_TO_RELEASE) {
	console.log(
		'Nothing to release: no commits since the last tag imply a version bump.',
	);
	process.exit(NOTHING_TO_RELEASE);
}

if (next.status !== 0) {
	fail(next.stderr.trim() || 'next-version failed');
}

const version = next.stdout.trim();
const tag = `v${version}`;
if (run('git', ['tag', '--list', tag]).trim()) {
	fail(`tag ${tag} already exists`);
}

// 2. Build the new changelog in memory.
const markdown = run(process.execPath, [cli, 'changelog', '--release', tag]);

if (dryRun) {
	const section = markdown.split(/\n(?=## )/)[1] ?? '';
	console.log(`Would release ${tag}:\n\n${section.trim()}`);
	process.exit(0);
}

// 3. Write files, commit, tag. Any failure undoes everything: the tree was
// clean when we started, so resetting to the starting commit loses nothing.
const touched = [changelog, ...packages];
const start = run('git', ['rev-parse', 'HEAD']).trim();
try {
	writeFileSync(path.join(root, changelog), markdown);
	for (const file of packages) {
		const data = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
		data.version = version;
		writeFileSync(
			path.join(root, file),
			`${JSON.stringify(data, null, '\t')}\n`,
		);
	}

	run(process.execPath, [prettier, '--write', ...touched], {
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	run('git', ['add', ...touched]);
	run('git', ['commit', '-q', '-m', `🔖 Release ${tag}`, ...trailers]);
	run('git', ['tag', '-a', tag, '-m', tag]);
} catch (error) {
	try {
		run('git', ['reset', '-q', '--hard', start]);
	} catch (undoError) {
		fail(
			`release failed (${error.message}) and could not be undone (${undoError.message}); reset to ${start} by hand`,
		);
	}

	fail(`release failed and was undone: ${error.message}`);
}

console.log(`Released ${tag} locally. Next:

  git push --follow-tags
  pnpm publish -r`);
