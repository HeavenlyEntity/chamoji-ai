import {execFile} from 'node:child_process';
import type {CommitClassifier} from '@chamoji/core';
import type {Face, Step} from '../face.js';
import type {jevFace} from '../jev-classifier.js';
import type {GhRunner, Io} from '../run.js';

export const NO_RELEASE_NEEDED = 3;

/** Exit code for a release check that failed before anything changed. */
export const PREFLIGHT_FAILED = 2;

/** The flags the commands under commands/ read, as run.ts parses them. */
export type CommandFlags = {
	format: string;
	output?: string;
	to: string;
	release?: string;
	since?: string;
	config?: string;
	dryRun?: boolean;
	push?: boolean;
	onMerge?: boolean;
	publish?: boolean;
	trailer?: string[];
	anyBranch?: boolean;
	unit: string[];
	tag?: string;
	catchUp?: boolean;
	forTag?: string;
	json?: boolean;
	repo?: string;
	endpoint?: string;
	all?: boolean;
};

/**
 * What a command shares with `run`: the parsed command line, the Io with the
 * face swapped in, Jev's face and the step it shows its progress on, and the
 * `--ai` classifier, if any.
 */
export type CommandContext = {
	/** The command line's words: the command, then its arguments. */
	input: string[];
	flags: CommandFlags;
	io: Io;
	face: Face;
	/** `--from`, once per tag. */
	froms: string[];
	jev: ReturnType<typeof jevFace>;
	/** A step a command is running that Jev's progress shows on, if any. */
	jevHost: {step?: Step};
	classify: CommitClassifier | undefined;
	/** run.ts's `run`, for a command that runs another one. */
	run: (argv: string[], io: Io) => Promise<number>;
};

/**
 * The GitHub CLI, without a shell, run in `cwd`: gh picks the GitHub repo from
 * the git remotes there, so it must be the repo chamoji works on. Missing `gh`
 * is a soft failure.
 */
export const ghIn =
	(cwd: string): GhRunner =>
	async (args, options) =>
		new Promise(resolve => {
			execFile(
				'gh',
				args,
				{cwd, timeout: options?.timeoutMs ?? 0},
				(error, stdout, stderr) => {
					if (!error) {
						resolve({ok: true, message: stdout.trim()});
					} else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						resolve({ok: false, message: 'no gh CLI, so no GitHub release'});
					} else {
						resolve({ok: false, message: stderr.trim() || error.message});
					}
				},
			);
		});
