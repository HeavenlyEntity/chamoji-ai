import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadComposeConfig, runGit, shouldPrompt} from '@chamoji/core';
import {readAiSettings} from '../ai.js';
import {uninstallHook} from '../hook.js';
import {composeImpact} from '../impact.js';
import type {ComposerTerminal} from '../run.js';
import {setUpHook} from '../setup/steps.js';
import {PREFLIGHT_FAILED, type CommandContext} from './context.js';
import {
	adviceFor,
	anyExists,
	draftFor,
	realTerminal,
	REBASE_MARKERS,
	stamp,
	whyCheckFor,
} from './compose.js';

export async function hook(
	ctx: CommandContext,
	action: string | undefined,
): Promise<number> {
	const {io, input} = ctx;
	switch (action) {
		case 'install': {
			return setUpHook(io);
		}

		case 'run': {
			return runHook(ctx, input[2], input[3]);
		}

		case 'uninstall': {
			const removed = await uninstallHook(io.cwd);
			io.stdout(
				removed
					? 'Removed the chamoji hook.\n'
					: 'There was no chamoji hook to remove.\n',
			);
			return 0;
		}

		default: {
			io.stderr(
				`chamoji: hook needs install, uninstall or run${action ? `, not "${action}"` : ''}\n`,
			);
			return PREFLIGHT_FAILED;
		}
	}
}

/**
 * What the installed prepare-commit-msg hook runs. It opens the composer
 * only when shouldPrompt says so, stamps the active workstream on the
 * message, and always exits 0 with the message file unchanged when
 * anything goes wrong, so it never blocks a commit.
 */
async function runHook(
	ctx: CommandContext,
	file: string | undefined,
	source: string | undefined,
): Promise<number> {
	const {io} = ctx;
	if (!file) return 0;
	let terminal: ComposerTerminal | null = null;
	try {
		const messageFile = path.resolve(io.cwd, file);
		const original = await readFile(messageFile, 'utf8');
		const gitDir = (
			await runGit(['rev-parse', '--absolute-git-dir'], io.cwd)
		).trim();
		terminal = (io.terminal ?? realTerminal)();
		const decision = shouldPrompt({
			source,
			message: original,
			isTTY: terminal !== null,
			env: io.env ?? process.env,
			rebasing: anyExists(gitDir, REBASE_MARKERS),
		});
		const composed =
			decision.prompt && terminal
				? await composeInto(ctx, messageFile, original, terminal)
				: false;
		// A message the composer wrote is real, whatever git's source was.
		await stamp(ctx, messageFile, gitDir, composed ? undefined : source);
		return 0;
	} catch (error) {
		io.stderr(`chamoji: hook skipped (${(error as Error).message})\n`);
		return 0;
	} finally {
		terminal?.close();
	}
}

/**
 * Replaces the message in `messageFile` with a composed one. Returns
 * whether there was one to write (false when the composer was cancelled).
 */
async function composeInto(
	ctx: CommandContext,
	messageFile: string,
	original: string,
	terminal: ComposerTerminal,
): Promise<boolean> {
	const {io} = ctx;
	const root = (await runGit(['rev-parse', '--show-toplevel'], io.cwd)).trim();
	const settings = await readAiSettings(root);
	const advice = adviceFor(
		ctx,
		root,
		settings,
		original.split('\n').find(line => line.trim() && !line.startsWith('#')) ??
			'',
	);
	const {now, later} = await draftFor(ctx, root, settings);
	const message = await terminal.compose(
		await loadComposeConfig(root),
		advice,
		await composeImpact(root),
		await whyCheckFor(ctx, root, settings),
		now ?? later,
	);
	if (message === null) return false;

	// Keep git's comment lines, such as the list of changes, below the message.
	const comments = original.split('\n').filter(line => line.startsWith('#'));
	await writeFile(
		messageFile,
		`${message}\n${comments.length > 0 ? `\n${comments.join('\n')}\n` : ''}`,
	);
	return true;
}
