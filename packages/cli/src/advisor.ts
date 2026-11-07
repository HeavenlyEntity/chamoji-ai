import {GITMOJIS, type StagedChanges} from '@chamoji/core';

/** The slice of the TypeSafe client the advisor uses (easy to fake in tests). */
export type AdvisorClient = {
	systemOne(request: {
		state: Record<string, unknown>;
		questions: Record<
			string,
			| {type: 'choice'; instructions: string; criteria: Record<string, string>}
			| {
					type: 'noul';
					instructions: string;
					criteria?: {true: string; false: string};
			  }
		>;
	}): Promise<{
		answers: Record<
			string,
			{probabilities?: Record<string, number>; noul?: number}
		>;
	}>;
};

export type Advice = {
	/** The three likeliest gitmojis, most likely first. */
	gitmojis: Array<{code: string; probability: number}>;
	/** Probability the change breaks something users rely on. */
	breaking: number;
	/** Probability the staged changes mix unrelated work. */
	split: number;
};

/**
 * A breaking or split probability at or above this shows a hint. The
 * TypeSafe docs suggest 0.7 as a starting point for yes; tune it with the eval.
 */
export const HINT_THRESHOLD = 0.7;

/**
 * The composer moves Jev's gitmojis to the top, the first one selected, only
 * when the top pick is at least this likely; otherwise it lists them in a
 * hint. Before the title is written Jev sees only the file list, and on the
 * eval's commits other than ⬆️ bumps its top pick was right 53% of the time
 * at 0.7 and 74% at 0.9 (scripts/jev-eval.mjs --files-only --no-bumps).
 */
export const PRESELECT_THRESHOLD = 0.9;

/** Names the questions below; change it whenever they change. */
export const ADVICE_VERSION = 'jev-latest:advice-v2';

const NONE = 'none';

// The official description reads as "any changed files" when there's no
// title yet, which pulled most file-list-only commits to 📦️.
const SHARPER: Record<string, string> = {
	package:
		'Add or update compiled files, vendored code or a published package build; not ordinary source, config or docs edits.',
};

// Not offered: 💥 (only the author declares a breaking change; that's the
// breaking question's job, as a hint) and the codes hidden from changelogs.
const NOT_OFFERED = new Set(['boom', 'bookmark', 'twisted_rightwards_arrows']);

const CRITERIA: Record<string, string> = Object.fromEntries([
	...GITMOJIS.filter(gitmoji => !NOT_OFFERED.has(gitmoji.code)).map(gitmoji => [
		gitmoji.code,
		SHARPER[gitmoji.code] ?? gitmoji.description,
	]),
	[NONE, 'None of these fit, or the changes are too unclear to tell.'],
]);

// Added only when there's no title yet; with a title it cost accuracy.
const FILES_ONLY =
	'There is no title yet, so judge from which files changed and how: only docs, tests, CI, dependencies or config point to those gitmojis, ' +
	'new source files to a feature, small edits to existing source to a fix or a tweak. ';

/**
 * Asks Jev, in one request, which gitmoji fits the staged change, whether
 * it looks breaking and whether it mixes unrelated work. It sees file paths,
 * line counts and the draft title, and the diff only when the caller passes
 * one (`chamoji.sendDiffs`).
 */
export function createCommitAdvisor(client: AdvisorClient) {
	return async (input: {
		staged: StagedChanges;
		draft?: string;
	}): Promise<Advice> => {
		const {staged, draft = ''} = input;
		const {answers} = await client.systemOne({
			state: {
				files: staged.files,
				withheldFiles: staged.withheld,
				draftTitle: draft,
				...(staged.diff ? {diff: staged.diff} : {}),
			},
			questions: {
				gitmoji: {
					type: 'choice',
					instructions:
						'A developer is about to commit the changes listed in `files` (path, status, and lines added and deleted)' +
						", titled `draftTitle` if that isn't empty, with the changes themselves in `diff` when it is present. " +
						"Which gitmoji would they put at the start of the commit's title to say what kind of change it is? " +
						(draft.trim() ? '' : FILES_ONLY) +
						`Pick ${NONE} if nothing fits or it's too unclear to tell.`,
					criteria: CRITERIA,
				},
				breaking: {
					type: 'noul',
					instructions:
						'Judging from `files`, `draftTitle` and `diff` when present: would this commit break something that people using this project rely on?',
					criteria: {
						true: 'It removes or renames a public API, CLI command or flag, config key or file format, changes their behaviour incompatibly, or raises a minimum supported version.',
						false:
							'It only adds things, fixes bugs, changes internals, docs, tests or tooling, or keeps the old behaviour working.',
					},
				},
				split: {
					type: 'noul',
					instructions:
						'Do the changes in `files` (and `diff` when present) mix unrelated pieces of work that would be clearer as separate commits?',
					criteria: {
						true: 'Two or more independent changes, such as a feature plus an unrelated refactor or dependency bump, that could each be committed and understood alone.',
						false:
							'One coherent change, including its tests, docs and config, even if it touches many files.',
					},
				},
			},
		});

		const gitmojis = Object.entries(answers.gitmoji?.probabilities ?? {})
			.filter(([code]) => code !== NONE)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 3)
			.map(([code, probability]) => ({code, probability}));
		return {
			gitmojis,
			breaking: answers.breaking?.noul ?? 0,
			split: answers.split?.noul ?? 0,
		};
	};
}
