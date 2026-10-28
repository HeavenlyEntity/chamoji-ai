import {
	GITMOJIS,
	type CommitClassifier,
	type ParsedCommit,
} from '@chamoji/core';

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
	/** Receives a one-line summary when done. */
	report?: (line: string) => void;
};

/** Characters of each commit body sent; subjects are always sent whole. */
const BODY_CHARS = 300;

const NONE = 'none';

/**
 * Every gitmoji except 💥: an AI may sort a commit, but only its author can
 * declare a breaking change.
 */
const CRITERIA: Record<string, string> = Object.fromEntries([
	...GITMOJIS.filter(gitmoji => gitmoji.code !== 'boom').map(gitmoji => [
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
	} = options;

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
					subject: commit.subject,
					body: commit.body.trim().slice(0, BODY_CHARS),
				})),
			},
			questions,
		});

		const picks: Array<[string, string]> = [];
		for (const [index, commit] of batch.entries()) {
			const answer = answers[`commit_${index}`];
			if (
				answer &&
				answer.choice !== NONE &&
				answer.confidence >= minConfidence
			) {
				picks.push([commit.hash, answer.choice]);
			}
		}

		return picks;
	};

	return async commits => {
		const batches: ParsedCommit[][] = [];
		for (let start = 0; start < commits.length; start += batchSize) {
			batches.push(commits.slice(start, start + batchSize));
		}

		const result = new Map<string, string>();
		let next = 0;
		const worker = async () => {
			while (next < batches.length) {
				const batch = batches[next++]!;
				for (const [hash, code] of await classifyBatch(batch)) {
					result.set(hash, code);
				}
			}
		};

		await Promise.all(
			Array.from({length: Math.min(concurrency, batches.length)}, worker),
		);
		report?.(
			`Jev sorted ${result.size} of ${commits.length} commits no rule could place`,
		);
		return result;
	};
}
