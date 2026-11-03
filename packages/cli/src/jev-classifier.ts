import {
	GITMOJIS,
	type CommitClassifier,
	type JudgmentCache,
	type ParsedCommit,
} from '@chamoji/core';
import {runStep, type Face, type Step} from './face.js';

/**
 * Names the question and options below. Change it whenever they change, so
 * cached judgments from the old question are never reused.
 */
export const JUDGMENT_VERSION = 'jev-latest:gitmoji-v1';

/** The slice of the TypeSafe client this classifier uses (easy to fake in tests). */
export type JevClient = {
	systemOne(request: {
		state: {commits: Array<{subject: string; body: string}>};
		questions: Record<
			string,
			{type: 'choice'; instructions: string; criteria: Record<string, string>}
		>;
	}): Promise<{
		answers: Record<string, {choice: string; confidence: number}>;
	}>;
};

export type JevClassifierOptions = {
	/** Commits per request; each question carries all the gitmoji options. */
	batchSize?: number;
	/** Requests in flight at once. */
	concurrency?: number;
	/** Picks below this confidence are dropped and the commit stays unsorted. */
	minConfidence?: number;
	/** Receives one-line progress notes: failures and a final summary. */
	report?: (line: string) => void;
	/** Judgments from earlier runs; commits found here aren't sent again. */
	cache?: JudgmentCache;
	/**
	 * Called once with 0 before the first batch, then after each finished
	 * batch, with the commits sent so far and the number to send, which leaves
	 * out the ones the cache already knew. Not called when nothing is sent.
	 */
	progress?: (done: number, total: number) => void;
};

/** Characters of each subject and body sent. */
const MAX_CHARS = 300;

/**
 * Upper bound on batch size. Each question repeats the ~75 gitmoji options
 * (about 1.4k tokens), and a request may hold 64k tokens, state included.
 */
const MAX_BATCH = 30;

const NONE = 'none';

/**
 * Not offered: 💥, because only an author can declare a breaking change, and
 * the codes the default config hides, so a wrong pick can't make a commit
 * vanish from the changelog.
 */
const NOT_OFFERED = new Set(['boom', 'bookmark', 'twisted_rightwards_arrows']);

const CRITERIA: Record<string, string> = Object.fromEntries([
	...GITMOJIS.filter(gitmoji => !NOT_OFFERED.has(gitmoji.code)).map(gitmoji => [
		gitmoji.code,
		gitmoji.description,
	]),
	[
		NONE,
		'None of these fit, or the message is too vague to tell what changed.',
	],
]);

/**
 * Sorts commits with Jev (TypeSafe System One): one `choice` question per
 * commit over the gitmoji list. Only subjects and the start of each body are
 * sent, never diffs or code.
 */
export function createJevClassifier(
	client: JevClient,
	options: JevClassifierOptions = {},
): CommitClassifier {
	const {
		batchSize = 25,
		concurrency = 4,
		// A starting point; tune it against labelled history.
		minConfidence = 0.6,
		report,
		cache,
		progress,
	} = options;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
		throw new RangeError(`batchSize must be an integer from 1 to ${MAX_BATCH}`);
	}

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new RangeError('concurrency must be a positive integer');
	}

	const classifyBatch = async (batch: ParsedCommit[]) => {
		const questions: Parameters<JevClient['systemOne']>[0]['questions'] = {};
		for (const index of batch.keys()) {
			questions[`commit_${index}`] = {
				type: 'choice',
				instructions: `Which gitmoji best describes the change made by commit \`commits[${index}]\`, judging from its subject and body? Pick the one a maintainer would use when sorting it into a changelog, or ${NONE} if the message is too vague to tell.`,
				criteria: CRITERIA,
			};
		}

		const {answers} = await client.systemOne({
			state: {
				commits: batch.map(commit => ({
					subject: redact(commit.subject).slice(0, MAX_CHARS),
					body: redact(withoutTrailers(commit.body)).trim().slice(0, MAX_CHARS),
				})),
			},
			questions,
		});

		const picks: Array<[string, string]> = [];
		for (const [index, commit] of batch.entries()) {
			const answer = answers[`commit_${index}`];
			if (!answer) continue;
			const gitmoji = answer.choice === NONE ? null : answer.choice;
			cache?.set(commit.hash, {gitmoji, confidence: answer.confidence});
			if (gitmoji && answer.confidence >= minConfidence) {
				picks.push([commit.hash, gitmoji]);
			}
		}

		return picks;
	};

	return async commits => {
		const result = new Map<string, string>();
		const unknown: ParsedCommit[] = [];
		for (const commit of commits) {
			const known = cache?.get(commit.hash);
			if (!known) {
				unknown.push(commit);
			} else if (known.gitmoji && known.confidence >= minConfidence) {
				result.set(commit.hash, known.gitmoji);
			}
		}

		const cached = commits.length - unknown.length;
		const batches: ParsedCommit[][] = [];
		for (let start = 0; start < unknown.length; start += batchSize) {
			batches.push(unknown.slice(start, start + batchSize));
		}

		let next = 0;
		let sent = 0;
		if (unknown.length > 0) progress?.(0, unknown.length);
		let failure: Error | undefined;
		// `--ai` only improves the output, so a failed request stops further
		// requests but keeps what earlier ones returned.
		const worker = async () => {
			while (next < batches.length && !failure) {
				const batch = batches[next++]!;
				try {
					for (const [hash, code] of await classifyBatch(batch)) {
						result.set(hash, code);
					}

					sent += batch.length;
					progress?.(sent, unknown.length);
				} catch (error) {
					failure ??= error as Error;
				}
			}
		};

		await Promise.all(
			Array.from({length: Math.min(concurrency, batches.length)}, worker),
		);
		if (failure) {
			report?.(
				`Jev request failed (${failure.message}); ${unknown.length - sent} commits left unsorted`,
			);
		}

		await cache?.save().catch(() => undefined);
		report?.(
			`Jev sorted ${result.size} of ${commits.length} commits no rule could place${cached ? ` (${cached} from the cache, not asked again)` : ''}`,
		);
		return result;
	};
}

const SORTING = 'Jev is sorting commits';

/**
 * Shows Jev's work on the face, counting commits as batches come back. Pass
 * `progress` to createJevClassifier, and `wrap` the classifier it makes.
 * `host` gives a step the command is already running, such as release's;
 * Jev then relabels that one and leaves it running. Without one, Jev gets a
 * step of its own, which ends with a warning when a failed request left
 * commits unsorted.
 */
export function jevFace(
	face: Face,
	host: () => Step | undefined = () => undefined,
): {
	progress: (done: number, total: number) => void;
	wrap: (classify: CommitClassifier) => CommitClassifier;
} {
	let target: Step | undefined;
	let done = 0;
	let total = 0;
	return {
		progress(sent, of) {
			done = sent;
			total = of;
			target?.update(`Jev is sorting ${sent} of ${of} commits`);
		},
		wrap: classify => async commits => {
			done = 0;
			total = 0;
			const own = host();
			if (own) {
				target = own;
				own.update(SORTING);
				try {
					return await classify(commits);
				} finally {
					target = undefined;
				}
			}

			return runStep(
				face,
				SORTING,
				async step => {
					target = step;
					try {
						return await classify(commits);
					} finally {
						target = undefined;
					}
				},
				() =>
					done < total
						? {
								outcome: 'warn',
								text: `Jev left ${total - done} of ${total} commits unsorted`,
							}
						: {
								outcome: 'ok',
								text:
									total === 0
										? 'Jev had nothing new to sort'
										: `Jev sorted ${total} ${total === 1 ? 'commit' : 'commits'}`,
							},
			);
		},
	};
}

/**
 * A match may only start where a run of address characters starts. Without
 * the lookbehind the pattern is quadratic on a long run of word characters,
 * and commit text can hold one. A length cap would do too, but it leaves the
 * start of a longer address behind.
 */
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TRAILER_LINE = /^[\w-]+:\s/;

/** Replaces email addresses, which often appear in commit text. */
export function redact(text: string): string {
	return text.replaceAll(EMAIL, '<email>');
}

/** Drops the final paragraph when it is all `Key: value` trailer lines. */
export function withoutTrailers(body: string): string {
	const paragraphs = body.trim().split(/\n\s*\n/);
	const last = paragraphs.at(-1)?.split('\n') ?? [];
	if (last.length > 0 && last.every(line => TRAILER_LINE.test(line.trim()))) {
		paragraphs.pop();
	}

	return paragraphs.join('\n\n');
}
