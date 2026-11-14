import {readCommits} from './git.js';
import {parseCommit} from './parse.js';
import type {ParsedCommit} from './types.js';
import {judgeWhy} from './why-quality.js';

/** A commit near the one asked about, shown as a clue. */
export type NearbyCommit = Pick<
	ParsedCommit,
	'hash' | 'shortHash' | 'subject' | 'card'
>;

/** What else git knows that may say why: a PR number and nearby explained commits. */
export type WhyClues = {pr?: number; nearby: NearbyCommit[]};

/** How good a commit's recorded reason is. `none` means there is no card. */
export type WhyQuality = 'ok' | 'thin' | 'none';

const NEARBY_LIMIT = 3;
const NEARBY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Far more than the limit, since thin and card-less commits are skipped.
const SCAN_LIMIT = 50;

/** The PR a subject names: a trailing `(#123)`, or a `Merge pull request #123`. */
export function prNumber(subject: string): number | undefined {
	const match =
		/\(#(\d+)\)\s*$/.exec(subject) ??
		/^Merge pull request #(\d+)/.exec(subject);
	return match ? Number(match[1]) : undefined;
}

/**
 * Local clues for a commit whose Why is thin or missing: its PR number, and up
 * to three earlier commits to `file` in the 14 days before it whose cards say
 * why, newest first. Never throws; a commit with no parent, or any git
 * failure, has no nearby commits.
 */
export async function findClues(
	cwd: string,
	commit: ParsedCommit,
	file: string,
): Promise<WhyClues> {
	const pr = prNumber(commit.subject);
	const clues: WhyClues = {...(pr === undefined ? {} : {pr}), nearby: []};
	try {
		const when = Date.parse(commit.date);
		if (Number.isNaN(when)) return clues;
		const raws = await readCommits(cwd, `${commit.hash}^`, {
			paths: [file],
			since: new Date(when - NEARBY_DAYS * DAY_MS).toISOString(),
			maxCount: SCAN_LIMIT,
		});
		for (const raw of raws) {
			const {hash, shortHash, subject, card, description} = parseCommit(raw);
			if (card === undefined || judgeWhy(card, description).level !== 'ok')
				continue;
			clues.nearby.push({hash, shortHash, subject, card});
			if (clues.nearby.length === NEARBY_LIMIT) break;
		}
	} catch {
		clues.nearby = [];
	}

	return clues;
}
