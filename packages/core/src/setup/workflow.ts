import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from '../git.js';
import type {FileChange} from '../release.js';
import type {PackageManager} from '../publish/pack.js';

async function rootScripts(root: string): Promise<Set<string>> {
	try {
		const manifest: unknown = JSON.parse(
			await readFile(path.join(root, 'package.json'), 'utf8'),
		);
		const scripts =
			typeof manifest === 'object' && manifest !== null
				? (manifest as {scripts?: unknown}).scripts
				: undefined;
		if (typeof scripts !== 'object' || scripts === null) return new Set();
		return new Set(
			Object.entries(scripts)
				.filter(([, body]) => typeof body === 'string')
				.map(([name]) => name),
		);
	} catch {
		return new Set();
	}
}

/**
 * How `pm` runs a root script. A bare `yarn check` or `bun test` is a command
 * of the tool itself, so those two spell out `run`.
 */
function run(pm: PackageManager, script: string): string {
	if (pm === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`;
	if (pm === 'pnpm') return `pnpm ${script}`;
	return `${pm} run ${script}`;
}

/**
 * The command a release runs before publishing: the root `check` and `test`
 * scripts that exist, joined with `&&`; else `build`; else null.
 */
export async function checkCommand(
	root: string,
	pm: PackageManager,
): Promise<string | null> {
	const scripts = await rootScripts(root);
	const checks = ['check', 'test'].filter(name => scripts.has(name));
	if (checks.length > 0) return checks.map(name => run(pm, name)).join(' && ');
	return scripts.has('build') ? run(pm, 'build') : null;
}

/** The branch a merge release runs on: origin's HEAD, else the current branch, else main. */
export async function defaultBranch(root: string): Promise<string> {
	try {
		const head = (
			await runGit(
				['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
				root,
			)
		).trim();
		if (head.startsWith('origin/') && head.length > 'origin/'.length) {
			return head.slice('origin/'.length);
		}
	} catch {
		// No origin, or it has no HEAD yet.
	}

	try {
		const current = (await runGit(['branch', '--show-current'], root)).trim();
		if (current) return current;
	} catch {
		// Not a repo we can read; main is the usual name.
	}

	return 'main';
}

/** What a tracked workflow must hold to count as running chamoji's release. */
const RUNS_CHAMOJI = [
	'HeavenlyEntity/chamoji-ai@',
	'chamoji release',
	'@chamoji/cli release',
];
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** An `npm-token:` input that isn't commented out. */
const TOKEN_LINE = /^[ \t]*(?:-[ \t]+)?npm-token[ \t]*:/m;

/**
 * The tracked workflow that already runs chamoji, with how it signs in to
 * npm: `token` when it has an uncommented `npm-token:` line. Only tracked
 * `.github/workflows/*.yml` and `*.yaml` count; the first in path order wins.
 */
export async function findReleaseWorkflow(
	root: string,
): Promise<{file: string; ciAuth: 'oidc' | 'token'} | null> {
	let listed: string[];
	try {
		listed = (await runGit(['ls-files', '-z', '--', '.github/workflows'], root))
			.split('\0')
			.filter(file => WORKFLOW_FILE.test(file))
			.sort();
	} catch {
		return null;
	}

	for (const file of listed) {
		let body: string;
		try {
			// eslint-disable-next-line no-await-in-loop -- first match wins, in order
			body = await readFile(path.join(root, file), 'utf8');
		} catch {
			continue;
		}

		if (RUNS_CHAMOJI.some(needle => body.includes(needle))) {
			return {file, ciAuth: TOKEN_LINE.test(body) ? 'token' : 'oidc'};
		}
	}

	return null;
}

/** Where setup writes a new release workflow. */
export const RELEASE_WORKFLOW_FILE = '.github/workflows/chamoji-release.yml';

/** A branch name as YAML holds it: bare when it's plainly safe, else quoted. */
const yamlString = (value: string): string =>
	/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) ? value : JSON.stringify(value);

/** The step that sets up the project's package manager, or none for npm. */
function managerStep(pm: PackageManager): string[] {
	if (pm === 'pnpm') return ['      - uses: pnpm/action-setup@v4'];
	if (pm === 'bun') return ['      - uses: oven-sh/setup-bun@v2'];
	if (pm === 'yarn') return ['      - run: corepack enable'];
	return [];
}

/**
 * The workflow that releases on a push to `branch` and on "Run workflow".
 * The Action is pinned to `cliVersion`, the CLI that writes the file.
 * `id-token: write` stays with the token method, for provenance.
 */
export function releaseWorkflow(options: {
	branch: string;
	cliVersion: string;
	ciAuth: 'oidc' | 'token';
	packageManager: PackageManager;
}): string {
	const {branch, cliVersion, ciAuth, packageManager} = options;
	if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(cliVersion)) {
		throw new Error(`can't pin the Action to version "${cliVersion}"`);
	}

	const branchName = yamlString(branch);
	return `${[
		'name: release',
		'on:',
		'  push:',
		`    branches: [${branchName}]`,
		'  workflow_dispatch:',
		'    inputs:',
		'      version:',
		'        description: The version to release; empty picks it from the commits',
		'        required: false',
		'concurrency:',
		'  group: chamoji-release',
		'  cancel-in-progress: false',
		'permissions:',
		'  contents: write',
		'  id-token: write',
		'jobs:',
		'  release:',
		'    runs-on: ubuntu-latest',
		'    steps:',
		'      - uses: actions/checkout@v4',
		'        with:',
		`          ref: ${branchName}`,
		'          fetch-depth: 0',
		...managerStep(packageManager),
		`      - uses: HeavenlyEntity/chamoji-ai@v${cliVersion}`,
		'        with:',
		'          release-version: ${{ inputs.version }}',
		ciAuth === 'token'
			? '          npm-token: ${{ secrets.NPM_TOKEN }}'
			: '          # npm-token: ${{ secrets.NPM_TOKEN }}',
	].join('\n')}\n`;
}

/**
 * Whether an existing workflow's text lacks something a release needs: write
 * access to contents, `id-token: write`, the `release-version` input, or with
 * the token method an uncommented `npm-token:`.
 */
export function workflowLacks(text: string, ciAuth: 'oidc' | 'token'): boolean {
	return (
		!/contents:[ \t]*write/.test(text) ||
		!/id-token:[ \t]*write/.test(text) ||
		!/^[ \t]*release-version[ \t]*:/m.test(text) ||
		(ciAuth === 'token' && !TOKEN_LINE.test(text))
	);
}

/** The `with:` lines an existing workflow needs for these answers. */
export function workflowAdvice(file: string, ciAuth: 'oidc' | 'token'): string {
	return `${[
		`A workflow already runs chamoji (${file}); it needs:`,
		'  permissions:',
		'    contents: write',
		'    id-token: write',
		'  with:',
		'    release-version: ${{ inputs.version }}',
		...(ciAuth === 'token' ? ['    npm-token: ${{ secrets.NPM_TOKEN }}'] : []),
	].join('\n')}`;
}

/**
 * Refuses when `rel` or a folder above it, under `root`, is a symlink: git
 * commits the link, so writing through it would change a file the repo
 * doesn't hold. A part that doesn't exist yet ends the check.
 */
export async function assertNoSymlinks(
	root: string,
	rel: string,
): Promise<void> {
	let current = root;
	for (const part of rel.split('/').filter(Boolean)) {
		current = path.join(current, part);
		// eslint-disable-next-line no-await-in-loop -- each part sits under the last
		const found = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
			throw error;
		});
		if (!found) return;
		if (found.isSymbolicLink()) {
			throw new Error(
				`${path.relative(root, current).split(path.sep).join('/')} is a symlink; chamoji won't write through links`,
			);
		}
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const quoted = '"(?:[^"\\\\]|\\\\.)*"';

/**
 * `package.json` with `"private": true` after `"version"`, else after
 * `"name"`, keeping its indentation and line endings. A manifest that
 * already says `true` comes back as it is.
 */
export async function privatizeEdit(
	root: string,
	pkgPath: string,
): Promise<FileChange> {
	const file = [pkgPath, 'package.json'].filter(Boolean).join('/');
	await assertNoSymlinks(root, file);
	const original = await readFile(path.join(root, file), 'utf8');
	const manifest: unknown = JSON.parse(original);
	if (!isObject(manifest)) throw new Error(`${file} isn't a JSON object`);
	const how = 'marked private, so a publish never picks it up';
	if (manifest['private'] === true) return {file, text: original, how};

	const eol = original.includes('\r\n') ? '\r\n' : '\n';
	const indent = /^([ \t]+)"/m.exec(original)?.[1];
	// `"private": false` is flipped in place.
	const flipped = new RegExp(`^([ \\t]*"private"[ \\t]*:[ \\t]*)false`, 'm');
	if (indent !== undefined && flipped.test(original)) {
		return {file, text: original.replace(flipped, '$1true'), how};
	}

	if (indent !== undefined && !('private' in manifest)) {
		for (const key of ['version', 'name']) {
			const line = new RegExp(
				`^${indent}"${key}"[ \\t]*:[ \\t]*${quoted}(,?)[ \\t]*(?=\\r?$)`,
				'm',
			);
			const found = line.exec(original);
			if (!found) continue;
			const [whole, comma] = found as unknown as [string, string];
			const insert = comma
				? `${whole}${eol}${indent}"private": true,`
				: `${whole},${eol}${indent}"private": true`;
			// The whole line, so the replacement can't read `$` in a value.
			const text =
				original.slice(0, found.index) +
				insert +
				original.slice(found.index + whole.length);
			return {file, text, how};
		}
	}

	// Minified, or neither key on a line of its own: write it out again.
	const keys = Object.keys(manifest);
	const after = keys.includes('version') ? 'version' : 'name';
	const next: Record<string, unknown> = {};
	if (!keys.includes(after)) next['private'] = true;
	for (const [key, value] of Object.entries(manifest)) {
		next[key] = value;
		if (key === after) next['private'] = true;
	}

	const tail = original.endsWith('\n') ? eol : '';
	const text = JSON.stringify(next, null, indent ?? '\t').replaceAll('\n', eol);
	return {file, text: `${text}${tail}`, how};
}
