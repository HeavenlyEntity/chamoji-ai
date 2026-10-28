#!/usr/bin/env node
// Cuts a release in one go with chamoji: preflight → version → CHANGELOG.md →
// manifest bumps → release commit → annotated tag, then prints a short report.
// Pushes and creates the GitHub release only with --push. Any failure after the
// first change resets the repo to where it started.
//
//   node release.mjs [--version <x.y.z>] [--dry-run] [--push] [--ai] [--any-branch]
//
// Exit codes: 0 released (or dry run), 3 nothing to release, 2 a preflight check
// failed (the message says what to do), 1 anything else.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {parseArgs} from 'node:util';

const NOTHING_TO_RELEASE = 3;
const PREFLIGHT = 2;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/;
const windows = process.platform === 'win32';

const {values: flags} = parseArgs({
	options: {
		version: {type: 'string'},
		'dry-run': {type: 'boolean', default: false},
		push: {type: 'boolean', default: false},
		ai: {type: 'boolean', default: false},
		'any-branch': {type: 'boolean', default: false},
	},
});

const warnings = [];
class Stop extends Error {
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}
const stop = (message, code = 1) => {
	throw new Stop(message, code);
};
// Set once files start changing; a failure before the tag is made resets to it.
let rollbackTo;
let tag;
process.on('uncaughtException', error => {
	if (rollbackTo) {
		run('git', ['tag', '-d', tag], {allowFail: true});
		run('git', ['reset', '--quiet', '--hard', rollbackTo], {allowFail: true});
	}
	const undone = rollbackTo
		? `\nRolled back to ${rollbackTo.slice(0, 7)}; nothing was released.`
		: '';
	console.error(`chamoji-release: ${error.message}${undone}`);
	process.exit(error instanceof Stop ? error.code : 1);
});

// Commands run without a shell, so no argument is ever parsed as shell syntax. The one
// exception is chamoji on Windows (`shell: true` below): npx and npm-installed commands are
// .cmd files there, and Node starts those only through cmd.exe.
// NoDefaultCurrentDirectoryInExePath stops Windows from running a git.exe or chamoji.cmd
// that sits in the repo itself.
const childEnv = windows
	? {...process.env, NoDefaultCurrentDirectoryInExePath: '1'}
	: process.env;
// What cmd.exe may see in an argument: letters, digits and . _ @ / : = + -
const SHELL_SAFE = /^[\w.@/:=+-]+$/;

function run(command, args, {allowFail = false, shell = false} = {}) {
	if (shell) {
		const unsafe = args.find(arg => !SHELL_SAFE.test(arg));
		if (unsafe !== undefined)
			stop(`refusing to pass ${JSON.stringify(unsafe)} through the shell`);
	}
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		shell,
		env: childEnv,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error && !allowFail) stop(`${command}: ${result.error.message}`);
	if (result.status !== 0 && !allowFail) {
		stop(
			`${command} ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`,
		);
	}
	return result;
}

const git = (...args) => run('git', args).stdout.trim();
const gitTry = (...args) => run('git', args, {allowFail: true});

// chamoji: a global install if there is one, else the published package via npx.
const chamojiBase =
	run('chamoji', ['--version'], {allowFail: true, shell: windows}).status === 0
		? ['chamoji', []]
		: ['npx', ['--yes', '@chamoji/cli@latest']];
const chamoji = (args, options = {}) =>
	run(
		chamojiBase[0],
		[
			...chamojiBase[1],
			...args,
			...(flags.ai ? ['--ai'] : []),
			'--no-update-check',
		],
		{...options, shell: windows},
	);

// 1. Preflight.
if (gitTry('rev-parse', '--is-inside-work-tree').status !== 0)
	stop('not inside a git repository', PREFLIGHT);
process.chdir(git('rev-parse', '--show-toplevel'));

const dirty = git('status', '--porcelain');
if (dirty && !flags['dry-run']) {
	stop(
		`the working tree has uncommitted changes; commit or stash them first:\n${dirty}`,
		PREFLIGHT,
	);
}

const branch = git('branch', '--show-current');
const defaultBranch = gitTry(
	'symbolic-ref',
	'--short',
	'refs/remotes/origin/HEAD',
)
	.stdout.trim()
	.replace(/^origin\//, '');
if (
	defaultBranch &&
	branch !== defaultBranch &&
	!flags['any-branch'] &&
	!flags['dry-run']
) {
	stop(
		`on ${branch || 'a detached HEAD'}, not the default branch ${defaultBranch}; pass --any-branch to release from here anyway`,
		PREFLIGHT,
	);
}

const hasRemote = gitTry('remote', 'get-url', 'origin').status === 0;
if (gitTry('rev-parse', '--is-shallow-repository').stdout.trim() === 'true') {
	if (gitTry('fetch', '--unshallow', '--tags', '--quiet').status !== 0) {
		stop(
			'this is a shallow clone and fetching the full history failed; chamoji needs every tag',
			PREFLIGHT,
		);
	}
} else if (hasRemote && gitTry('fetch', '--tags', '--quiet').status !== 0) {
	warnings.push('could not fetch tags from origin; used the local tags');
}

const tags = git('tag', '--list', '--sort=-v:refname')
	.split('\n')
	.filter(tag => SEMVER.test(tag.replace(/^v/, '')));
const lastTag = tags[0];
const prefix = lastTag ? (lastTag.startsWith('v') ? 'v' : '') : 'v';
const previous = lastTag?.replace(/^v/, '');

// 2. Version.
let version = flags.version?.replace(/^v/, '');
if (version) {
	if (!SEMVER.test(version))
		stop(`${flags.version} is not a semver version`, PREFLIGHT);
	if (previous && compare(version, previous) <= 0)
		stop(`${version} is not newer than ${lastTag}`, PREFLIGHT);
} else if (!lastTag) {
	stop(
		'no release tags yet, so this is the first release: pass --version (for example the version in your manifest, or 0.1.0)',
		PREFLIGHT,
	);
} else {
	const next = chamoji(['next-version'], {allowFail: true});
	if (next.status === NOTHING_TO_RELEASE) {
		const unreleased = git(
			'log',
			'--no-merges',
			'--format=- %s',
			`${lastTag}..HEAD`,
		);
		console.log(
			`Nothing to release: no commit since ${lastTag} implies a version bump.`,
		);
		console.log(
			unreleased
				? `Unreleased commits:\n${unreleased}`
				: 'No commits since that tag.',
		);
		process.exit(NOTHING_TO_RELEASE);
	}
	if (next.status !== 0)
		stop(`chamoji next-version failed:\n${next.stderr.trim()}`);
	version = next.stdout.trim();
	if (!SEMVER.test(version)) {
		stop(
			`chamoji next-version printed ${JSON.stringify(version)}, not a version`,
		);
	}
}

tag = `${prefix}${version}`;
if (git('tag', '--list', tag)) stop(`tag ${tag} already exists`, PREFLIGHT);
const bump = !previous ? 'first release' : bumpKind(previous, version);

// 3. Notes: chamoji's section for this release, without the file heading.
const rendered = chamoji([
	...(lastTag ? ['changelog', '--from', lastTag] : ['changelog']),
	'--release',
	tag,
]).stdout;
const notes = rendered.replace(/^# Changelog\s*\n/, '').trim();

if (flags['dry-run']) {
	console.log(
		`Would release ${tag} (${bump}${previous ? `, from ${lastTag}` : ''}).`,
	);
	if (dirty)
		console.log(
			'The working tree has uncommitted changes; a real run would stop until they are committed or stashed.',
		);
	console.log(`\n${notes}`);
	process.exit(0);
}

// 4–6. Write, bump, commit, tag. Roll back on any failure.
const start = git('rev-parse', 'HEAD');
const changed = [];
rollbackTo = start;
{
	const file = 'CHANGELOG.md';
	let how;
	if (existsSync(file)) {
		const text = readFileSync(file, 'utf8');
		writeFileSync(file, insertSection(text, notes));
		how =
			'new section added above the previous release; older entries untouched';
	} else {
		chamoji(['changelog', '--release', tag, '--output', file]);
		how = 'created from the full history';
	}
	changed.push(file);

	for (const manifest of bumpManifests(previous, version))
		changed.push(manifest);

	git('add', '--', ...changed);
	git('commit', '--quiet', '-m', releaseSubject(tag));
	git('tag', '-a', tag, '-m', tag);
	rollbackTo = undefined;

	const notesFile = path.join(
		git('rev-parse', '--git-dir'),
		'chamoji-release-notes.md',
	);
	writeFileSync(notesFile, `${notes}\n`);

	let pushed = `no; to ship: git push origin HEAD ${tag}`;
	if (flags.push) {
		const push = gitTry('push', '--quiet', 'origin', 'HEAD', tag);
		if (push.status !== 0) {
			stop(
				`released ${tag} locally, but the push failed (the release commit and tag are kept):\n${push.stderr.trim()}`,
			);
		}
		pushed = `yes (HEAD and ${tag})`;
		if (run('gh', ['--version'], {allowFail: true}).status === 0) {
			const prerelease = version.includes('-') ? ['--prerelease'] : [];
			const release = run(
				'gh',
				[
					'release',
					'create',
					tag,
					'--title',
					tag,
					'--notes-file',
					notesFile,
					...prerelease,
				],
				{allowFail: true},
			);
			pushed +=
				release.status === 0
					? '; GitHub release created'
					: `; GitHub release failed: ${release.stderr.trim()}`;
		} else {
			pushed += '; no gh CLI, so no GitHub release';
		}
	}

	const commit = git('log', '-1', '--format=%h %s');
	console.log(
		[
			`Released ${tag} (${bump}${previous ? `, from ${lastTag}` : ''}).`,
			`changelog: ${file}, ${how}`,
			`bumped: ${changed.slice(1).join(', ') || 'no manifest carried the old version'}`,
			`commit: ${commit}`,
			`tag: ${tag} (annotated)`,
			`pushed: ${pushed}`,
			`notes file: ${notesFile}`,
			...warnings.map(warning => `warning: ${warning}`),
			`undo before pushing: git tag -d ${tag} && git reset --hard ${start.slice(0, 7)}`,
			'',
			notes,
		].join('\n'),
	);
}

// --- helpers ---

function parts(version) {
	const [, major, minor, patch, pre] = SEMVER.exec(version);
	return {major: +major, minor: +minor, patch: +patch, pre};
}

function compare(a, b) {
	const x = parts(a);
	const y = parts(b);
	for (const key of ['major', 'minor', 'patch'])
		if (x[key] !== y[key]) return x[key] - y[key];
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}

function bumpKind(from, to) {
	const x = parts(from);
	const y = parts(to);
	if (y.pre) return 'prerelease';
	if (y.major !== x.major) return 'major';
	if (y.minor !== x.minor) return 'minor';
	return 'patch';
}

/** Puts `section` above the first release heading, below the title and any Unreleased section. */
function insertSection(text, section) {
	const lines = text.split('\n');
	const index = lines.findIndex(
		line => /^## /.test(line) && !/^## \[?unreleased\]?/i.test(line),
	);
	if (index === -1) return `${text.trimEnd()}\n\n${section}\n`;
	return [
		...lines.slice(0, index),
		...section.split('\n'),
		'',
		...lines.slice(index),
	].join('\n');
}

/** Sets the version in every tracked manifest that carries the previous one. */
function bumpManifests(from, to) {
	const files = git(
		'ls-files',
		'*package.json',
		'*pyproject.toml',
		'*Cargo.toml',
		'package-lock.json',
	)
		.split('\n')
		.filter(file => file && !file.includes('node_modules/'));
	const bumped = [];
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const pattern = file.endsWith('.json')
			? /("version"\s*:\s*")([^"]+)(")/
			: /^(version\s*=\s*")([^"]+)(")/m;
		const match = pattern.exec(text);
		if (!match || (from ? match[2] !== from : match[2] === to)) continue;
		let next = text.replace(pattern, `$1${to}$3`);
		if (file.endsWith('package-lock.json')) {
			// The lockfile repeats the root version under packages[""].
			next = next.replace(
				/("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]+)(")/,
				`$1${to}$3`,
			);
		}
		writeFileSync(file, next);
		bumped.push(file);
	}
	return bumped;
}

/** A release subject in the repo's own commit style that chamoji leaves out of changelogs. */
function releaseSubject(tag) {
	const subjects = git('log', '-30', '--no-merges', '--format=%s').split('\n');
	const count = test => subjects.filter(subject => test.test(subject)).length;
	const gitmoji = count(/^(?:\p{Extended_Pictographic}|:[a-z_]+:)/u);
	const conventional = count(/^[a-z]+(?:\([^)]*\))?!?: /);
	if (conventional > gitmoji && conventional >= subjects.length / 3)
		return `chore(release): 🔖 ${tag}`;
	if (gitmoji >= subjects.length / 3) return `🔖 Release ${tag}`;
	return `Release ${tag}`;
}
