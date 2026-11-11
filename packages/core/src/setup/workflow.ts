import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from '../git.js';
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
