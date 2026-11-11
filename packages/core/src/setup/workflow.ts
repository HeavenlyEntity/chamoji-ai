import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
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

/** What a step must hold to count as running chamoji's release. */
const RUNS_CHAMOJI = [
	'HeavenlyEntity/chamoji-ai@',
	'chamoji release',
	'@chamoji/cli release',
];
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** An `npm-token:` input that isn't commented out. */
const TOKEN_LINE = /^[ \t]*(?:-[ \t]+)?npm-token[ \t]*:/m;

/** Whether an `on.push` filter covers `branch`: no filter, or a list that names it. */
function pushCovers(push: unknown, branch: string): boolean {
	if (!isObject(push)) return true;
	const list = (value: unknown): string[] | null =>
		Array.isArray(value) ? value.map(String) : null;
	const only = list(push['branches']);
	const ignored = list(push['branches-ignore']);
	if (only)
		return only.some(each => each === branch || each === '**' || each === '*');
	// A tags-only filter never runs on a branch push.
	if (push['tags'] !== undefined || push['tags-ignore'] !== undefined) {
		return false;
	}

	return ignored ? !ignored.includes(branch) : true;
}

/** What a workflow's `on:` runs on, or null when the text isn't a workflow we can read. */
function triggersOf(
	body: string,
	branch: string,
): {push: boolean; dispatch: boolean; runs: boolean} | null {
	let doc: unknown;
	try {
		doc = parse(body);
	} catch {
		return null;
	}

	if (!isObject(doc)) return null;
	const on = doc['on'];
	let push = false;
	let dispatch = false;
	if (typeof on === 'string') {
		push = on === 'push';
		dispatch = on === 'workflow_dispatch';
	} else if (Array.isArray(on)) {
		push = on.includes('push');
		dispatch = on.includes('workflow_dispatch');
	} else if (isObject(on)) {
		push = 'push' in on && pushCovers(on['push'], branch);
		dispatch = 'workflow_dispatch' in on;
	}

	const jobs = isObject(doc['jobs']) ? Object.values(doc['jobs']) : [];
	const runs = jobs.some(job => {
		if (!isObject(job)) return false;
		const parts: unknown[] = [job['uses']];
		if (Array.isArray(job['steps'])) {
			for (const step of job['steps']) {
				if (isObject(step)) parts.push(step['uses'], step['run']);
			}
		}

		return parts.some(
			part =>
				typeof part === 'string' &&
				RUNS_CHAMOJI.some(needle => part.includes(needle)),
		);
	});
	return {push, dispatch, runs};
}

/**
 * The tracked workflow that already runs chamoji's release, with how it signs
 * in to npm: `token` when it has an uncommented `npm-token:` line. Only
 * tracked `.github/workflows/*.yml` and `*.yaml` count, in path order. A
 * workflow counts when a step uses the Action or runs `chamoji release`, and
 * it runs on a push to `branch` (default: the default branch) or on
 * `workflow_dispatch`; a notes or PR-comment workflow doesn't. A file that
 * doesn't parse is matched by its text alone.
 */
export async function findReleaseWorkflow(
	root: string,
	branch?: string,
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

	const onBranch = branch ?? (await defaultBranch(root));
	for (const file of listed) {
		let body: string;
		try {
			// eslint-disable-next-line no-await-in-loop -- first match wins, in order
			body = await readFile(path.join(root, file), 'utf8');
		} catch {
			continue;
		}

		const facts = triggersOf(body, onBranch);
		const counts = facts
			? facts.runs && (facts.push || facts.dispatch)
			: RUNS_CHAMOJI.some(needle => body.includes(needle));
		if (counts) return {file, ciAuth: TOKEN_LINE.test(body) ? 'token' : 'oidc'};
	}

	return null;
}

/** Where setup writes a new release workflow. */
export const RELEASE_WORKFLOW_FILE = '.github/workflows/chamoji-release.yml';

/** A branch name as YAML holds it: bare when it's plainly safe, else quoted. */
const yamlString = (value: string): string =>
	/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) ? value : JSON.stringify(value);

/** The steps that set up the package manager and Node, then install, for publishing. */
function installSteps(
	pm: PackageManager,
	pnpmVersion: number | null,
): string[] {
	const steps: string[] = [];
	if (pm === 'pnpm') {
		steps.push('      - uses: pnpm/action-setup@v4');
		if (pnpmVersion !== null) {
			steps.push('        with:', `          version: ${pnpmVersion}`);
		}
	} else if (pm === 'bun') {
		steps.push('      - uses: oven-sh/setup-bun@v2');
	} else if (pm === 'yarn') {
		steps.push('      - run: corepack enable');
	}

	// No registry-url: the .npmrc it writes would stand in for the credentials
	// chamoji passes, and trusted publishing would fail.
	if (pm !== 'bun') {
		steps.push(
			'      - uses: actions/setup-node@v4',
			'        with:',
			'          node-version: 24',
			`          cache: ${pm}`,
		);
	}

	const install: Record<PackageManager, string> = {
		npm: 'npm ci',
		pnpm: 'pnpm install --frozen-lockfile',
		yarn: 'yarn install --immutable',
		bun: 'bun install --frozen-lockfile',
	};
	steps.push(`      - run: ${install[pm]}`);
	return steps;
}

/** The pnpm major `pnpm-lock.yaml`'s `lockfileVersion` was written by. */
const PNPM_BY_LOCKFILE: Array<[RegExp, number]> = [
	[/^9\./, 10],
	[/^6\./, 8],
	[/^5\./, 7],
];

/**
 * The pnpm major `pnpm/action-setup` needs as `version`, or null when the
 * root `package.json` has a `packageManager` field, which the action reads.
 * Otherwise it comes from `pnpm-lock.yaml`'s `lockfileVersion`: 9.x is 10,
 * 6.x is 8, 5.x is 7, and anything else, or no lockfile, is 10.
 */
export async function pnpmSetupVersion(root: string): Promise<number | null> {
	try {
		const manifest: unknown = JSON.parse(
			await readFile(path.join(root, 'package.json'), 'utf8'),
		);
		if (
			isObject(manifest) &&
			typeof manifest['packageManager'] === 'string' &&
			manifest['packageManager'] !== ''
		) {
			return null;
		}
	} catch {
		// No readable manifest: the lockfile still says.
	}

	try {
		const head = (await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'))
			.split('\n', 20)
			.find(line => line.startsWith('lockfileVersion:'));
		const found = /^lockfileVersion:\s*['"]?([0-9][0-9.]*)/.exec(head ?? '');
		if (found) {
			for (const [pattern, major] of PNPM_BY_LOCKFILE) {
				if (pattern.test(found[1]!)) return major;
			}
		}
	} catch {
		// No lockfile.
	}

	return 10;
}

/**
 * The workflow that releases on a push to `branch` and on "Run workflow".
 * The Action and the CLI it runs are pinned to `cliVersion`, the CLI that
 * writes the file. With `publishing`, the job sets up the package manager and
 * Node and installs first, since packing needs the dependencies; `pnpmVersion`
 * is the `version` for pnpm/action-setup, or null when `packageManager` says.
 * `id-token: write` stays with the token method, for provenance.
 */
export function releaseWorkflow(options: {
	branch: string;
	cliVersion: string;
	ciAuth: 'oidc' | 'token';
	packageManager: PackageManager;
	publishing: boolean;
	pnpmVersion?: number | null;
}): string {
	const {branch, cliVersion, ciAuth, packageManager, publishing} = options;
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
		...(publishing
			? installSteps(packageManager, options.pnpmVersion ?? null)
			: []),
		`      - uses: HeavenlyEntity/chamoji-ai@v${cliVersion}`,
		'        with:',
		`          chamoji-version: '${cliVersion}'`,
		'          release-version: ${{ inputs.version }}',
		ciAuth === 'token'
			? '          npm-token: ${{ secrets.NPM_TOKEN }}'
			: '          # npm-token: ${{ secrets.NPM_TOKEN }}',
	].join('\n')}\n`;
}

/**
 * What an existing workflow lacks for a release, as lines to add: the push
 * trigger (only when `merge`) and `workflow_dispatch`, write access to
 * contents, `id-token: write` (only when publishing), the `release-version` input, and with the
 * token method an uncommented `npm-token:`. A file that doesn't parse is
 * never said to lack a trigger.
 */
export function workflowLacking(
	text: string,
	options: {
		ciAuth: 'oidc' | 'token';
		branch: string;
		merge: boolean;
		publishing: boolean;
	},
): string[] {
	const {ciAuth, branch, merge, publishing} = options;
	const facts = triggersOf(text, branch);
	const lines: string[] = [];
	if (facts && merge && !facts.push) {
		lines.push(`on: push: branches: [${branch}]`);
	}

	if (facts && !facts.dispatch) lines.push('on: workflow_dispatch');
	if (!/contents:[ \t]*write/.test(text)) {
		lines.push('permissions: contents: write');
	}

	if (publishing && !/id-token:[ \t]*write/.test(text)) {
		lines.push('permissions: id-token: write');
	}

	if (!/^[ \t]*release-version[ \t]*:/m.test(text)) {
		lines.push('with: release-version: ${{ inputs.version }}');
	}

	if (ciAuth === 'token' && !TOKEN_LINE.test(text)) {
		lines.push('with: npm-token: ${{ secrets.NPM_TOKEN }}');
	}

	return lines;
}

/** The advice for an existing workflow that lacks `lines`. */
export function workflowAdvice(file: string, lines: string[]): string {
	return [
		`A workflow already runs chamoji (${file}); it needs:`,
		...lines.map(line => `  ${line}`),
	].join('\n');
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
	// A top-level `"private": false` is flipped in place: only a key at the
	// top-level indent counts, never one nested deeper.
	const flipped = new RegExp(
		`^(${indent ?? ''}"private"[ \\t]*:[ \\t]*)false`,
		'm',
	);
	if (
		indent !== undefined &&
		manifest['private'] === false &&
		flipped.test(original)
	) {
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
		// An old `private` (false, or not a boolean) is replaced, not kept.
		if (key === 'private') continue;
		next[key] = value;
		if (key === after) next['private'] = true;
	}

	const tail = original.endsWith('\n') ? eol : '';
	const text = JSON.stringify(next, null, indent ?? '\t').replaceAll('\n', eol);
	return {file, text: `${text}${tail}`, how};
}
