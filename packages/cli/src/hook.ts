import {chmod, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from '@chamoji/core';

/** The line that marks a hook as chamoji's, so uninstall never removes another. */
export const HOOK_MARKER = '# chamoji';

/**
 * The prepare-commit-msg hook. `chamoji hook run` decides whether to prompt
 * and opens the terminal itself, so the script only finds chamoji, and its
 * `exit 0` means the hook can never block a commit.
 */
export const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}: offers the commit composer on a plain \`git commit\`.
# Remove it with \`chamoji hook uninstall\`.
if command -v chamoji >/dev/null 2>&1; then
	chamoji hook run "$@"
else
	npx --yes @chamoji/cli hook run "$@"
fi
exit 0
`;

/** The line to add to a hook that another tool manages. */
export const HOOK_LINE = 'chamoji hook run "$@"';

const LEFTHOOK_SNIPPET = `prepare-commit-msg:
  commands:
    chamoji:
      run: chamoji hook run {1} {2} {3}
      interactive: true`;

export class HookError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HookError';
	}
}

export type InstallResult =
	| {status: 'installed'; path: string; replaced: 'chamoji' | 'gitmoji' | null}
	| {status: 'snippet'; hooksPath: string; snippet: string};

/**
 * Writes chamoji's prepare-commit-msg hook. It replaces chamoji's own hook
 * or gitmoji-cli's, and refuses any other. When `core.hooksPath` is set
 * (husky), nothing is written and the line to add is returned instead.
 */
export async function installHook(cwd: string): Promise<InstallResult> {
	const hooksPath = (
		await runGit(['config', '--get', 'core.hooksPath'], cwd).catch(() => '')
	).trim();
	if (hooksPath) {
		return {status: 'snippet', hooksPath, snippet: huskySnippet(hooksPath)};
	}

	const file = await hookPath(cwd);
	const existing = await readFile(file, 'utf8').catch(() => null);
	let replaced: 'chamoji' | 'gitmoji' | null = null;
	if (existing !== null) {
		if (existing.includes(HOOK_MARKER)) {
			replaced = 'chamoji';
		} else if (existing.includes('gitmoji --hook')) {
			replaced = 'gitmoji';
		} else if (existing.includes('lefthook')) {
			throw new HookError(
				`${file} is lefthook's. Add chamoji to lefthook.yml instead:\n\n${LEFTHOOK_SNIPPET}\n\nthen run \`lefthook install\`.`,
			);
		} else {
			throw new HookError(
				`${file} already has a prepare-commit-msg hook that isn't chamoji's or gitmoji's, so it was left alone. Add this line to it instead:\n\n  ${HOOK_LINE}`,
			);
		}
	}

	await writeFile(file, HOOK_SCRIPT);
	await chmod(file, 0o755);
	return {status: 'installed', path: file, replaced};
}

/** Removes chamoji's hook. Returns false, touching nothing, when there isn't one. */
export async function uninstallHook(cwd: string): Promise<boolean> {
	const file = await hookPath(cwd);
	const existing = await readFile(file, 'utf8').catch(() => null);
	if (existing === null || !existing.includes(HOOK_MARKER)) {
		return false;
	}

	await rm(file);
	return true;
}

async function hookPath(cwd: string): Promise<string> {
	const hooks = (
		await runGit(['rev-parse', '--git-path', 'hooks'], cwd)
	).trim();
	return path.resolve(cwd, hooks, 'prepare-commit-msg');
}

function huskySnippet(hooksPath: string): string {
	// husky v9 points core.hooksPath at .husky/_ and runs the scripts in .husky.
	const dir = hooksPath.replace(/[\\/]_$/, '');
	return `Add this line to ${dir}/prepare-commit-msg:\n\n  ${HOOK_LINE}`;
}
