import {groupCommits} from './group.js';
import type {GroupConfig, Highlight, ParsedCommit} from './types.js';
import type {Workstream} from './workstreams.js';

/**
 * Folds the commits of shipped workstreams into one highlight each.
 *
 * Only `shipped` workstreams fold; active, dropped and unknown slugs stay
 * loose. A breaking commit stays loose so it still reads under Breaking
 * changes, and so does a commit in a hidden group. A workstream left with
 * nothing visible gets no highlight. Highlights come newest first, by each
 * one's newest commit; `commits` are expected newest first, as `git log`
 * gives them.
 */
export function splitHighlights(
	commits: ParsedCommit[],
	workstreams: Workstream[],
	config: GroupConfig,
): {highlights: Highlight[]; loose: ParsedCommit[]} {
	const shipped = new Map(
		workstreams
			.filter(workstream => workstream.status === 'shipped')
			.map(workstream => [workstream.slug, workstream]),
	);
	const candidates = new Map<
		string,
		{commits: ParsedCommit[]; newest: number}
	>();
	for (const [index, commit] of commits.entries()) {
		if (
			commit.workstream !== undefined &&
			!commit.breaking &&
			shipped.has(commit.workstream)
		) {
			const entry = candidates.get(commit.workstream) ?? {
				commits: [],
				newest: index,
			};
			entry.commits.push(commit);
			candidates.set(commit.workstream, entry);
		}
	}

	const folded = new Set<ParsedCommit>();
	const found: Array<{highlight: Highlight; newest: number}> = [];
	for (const [slug, {commits: list, newest}] of candidates) {
		const groups = groupCommits(list, config);
		if (groups.length === 0) continue;
		for (const group of groups) {
			for (const commit of group.commits) folded.add(commit);
		}

		const {title, emoji, description, links} = shipped.get(slug)!;
		found.push({
			highlight: {
				slug,
				title,
				...(emoji === undefined ? {} : {emoji}),
				...(description === undefined ? {} : {description}),
				...(links === undefined ? {} : {links}),
				groups,
			},
			newest,
		});
	}

	return {
		highlights: found
			.sort((a, b) => a.newest - b.newest)
			.map(({highlight}) => highlight),
		loose: commits.filter(commit => !folded.has(commit)),
	};
}
