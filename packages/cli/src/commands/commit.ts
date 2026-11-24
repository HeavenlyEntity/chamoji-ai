import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {clearPendingWhy, loadComposeConfig, runGit} from '@chamoji/core';
import {readAiSettings} from '../ai.js';
import {composeImpact} from '../impact.js';
import {PREFLIGHT_FAILED, type CommandContext} from './context.js';
import {
	adviceFor,
	draftFor,
	realTerminal,
	stamp,
	whyCheckFor,
} from './compose.js';

export async function commit(ctx: CommandContext): Promise<number> {
	const {io, flags} = ctx;
	const root = (await runGit(['rev-parse', '--show-toplevel'], io.cwd)).trim();
	const config = await loadComposeConfig(root);
	const terminal = (io.terminal ?? realTerminal)();
	if (!terminal) {
		io.stderr(
			'chamoji: commit needs a terminal to ask on; in scripts, use git commit -m\n',
		);
		return PREFLIGHT_FAILED;
	}

	const settings = await readAiSettings(root);
	const advice = adviceFor(ctx, root, settings, '');
	const {now, later} = await draftFor(ctx, root, settings);
	let message: string | null;
	try {
		message = await terminal.compose(
			config,
			advice,
			await composeImpact(root),
			await whyCheckFor(ctx, root, settings),
			now ?? later,
		);
	} finally {
		terminal.close();
	}

	if (message === null) {
		io.stderr('Cancelled; nothing was committed.\n');
		return 1;
	}

	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-commit-'));
	const file = path.join(dir, 'COMMIT_EDITMSG');
	try {
		await writeFile(file, `${message}\n`);
		try {
			const gitDir = (
				await runGit(['rev-parse', '--absolute-git-dir'], io.cwd)
			).trim();
			// `git commit -F` keeps `#` lines like -m does.
			await stamp(ctx, file, gitDir, 'message');
		} catch (error) {
			io.stderr(
				`chamoji: not stamped with a workstream (${(error as Error).message})\n`,
			);
		}

		// gitmoji-cli's autoAdd stages everything, as `git add .` does.
		if (config.autoAdd) await runGit(['add', '--all'], io.cwd);
		io.stdout(
			await runGit(
				['commit', '-F', file, ...(flags.all ? ['--all'] : [])],
				io.cwd,
			),
		);
		// The reason is spent once a commit carries it.
		if (now && message.includes(`Why: ${now.text}`)) {
			await clearPendingWhy(root);
		}

		return 0;
	} catch (error) {
		const {stdout = '', stderr = ''} = error as {
			stdout?: string;
			stderr?: string;
		};
		io.stderr(`${`${stdout}${stderr}`.trim() || (error as Error).message}\n`);
		return 1;
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}
