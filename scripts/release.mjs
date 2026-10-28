#!/usr/bin/env node
// Cuts a release with chamoji itself: next-version → bump packages →
// CHANGELOG.md → commit → annotated tag. Never pushes or publishes.
//
//   pnpm release [--dry-run] [--trailer "Key: value"]...
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const packages = ['packages/core/package.json', 'packages/cli/package.json'];
const changelog = 'CHANGELOG.md';
const NOTHING_TO_RELEASE = 3;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const trailers = args.flatMap((arg, index) =>
	arg === '--trailer' && args[index + 1] ? ['--trailer', args[index + 1]] : [],
);

const run = (command, commandArgs, options = {}) =>
	execFileSync(command, commandArgs, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		...options,
	});

const fail = (message, code = 1) => {
	console.error(`release: ${message}`);
	process.exit(code);
};

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

run('pnpm', ['build'], {stdio: ['ignore', 'ignore', 'inherit']});

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

// 3. Write files, then commit and tag. Undo the file changes on failure.
const touched = [changelog, ...packages];
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

	run('pnpm', ['exec', 'prettier', '--write', ...touched], {
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	run('git', ['add', ...touched]);
	run('git', ['commit', '-q', '-m', `🔖 Release ${tag}`, ...trailers]);
} catch (error) {
	run('git', ['restore', '--staged', '--worktree', '--', ...touched]);
	fail(`release failed and was undone: ${error.message}`);
}

run('git', ['tag', '-a', tag, '-m', tag]);
console.log(`Released ${tag} locally. Next:

  git push --follow-tags
  pnpm publish -r`);
