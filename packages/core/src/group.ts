import type {Group, GroupConfig, ParsedCommit} from './types.js';

const BREAKING_GROUP = 'breaking_changes';
const FALLBACK_GROUP = 'misc';
const SYNC_GROUP = 'changed';

/**
 * Sorts commits into the configured sections. Breaking commits go to
 * Breaking changes whatever their gitmoji; unmatched ones go to misc.
 * Returns groups in config order, without empty or hidden ones.
 */
export function groupCommits(
	commits: ParsedCommit[],
	config: GroupConfig,
): Group[] {
	const buckets = new Map(
		config.map(item => [item.group, [] as ParsedCommit[]]),
	);
	const groupByCode = new Map<string, string>();
	for (const item of config) {
		for (const code of item.emojis) {
			if (!groupByCode.has(code)) {
				groupByCode.set(code, item.group);
			}
		}
	}

	for (const commit of commits) {
		// A sync is its own line under Changed, never part of a collapsed group.
		const target =
			commit.sync && buckets.has(SYNC_GROUP)
				? SYNC_GROUP
				: commit.breaking && buckets.has(BREAKING_GROUP)
					? BREAKING_GROUP
					: (commit.gitmoji && groupByCode.get(commit.gitmoji)) ||
						FALLBACK_GROUP;
		buckets.get(target)?.push(commit);
	}

	return config
		.filter(item => !item.hidden && buckets.get(item.group)!.length > 0)
		.map(item => ({
			group: item.group,
			label: item.label,
			...(item.collapse ? {collapse: true} : {}),
			commits: buckets.get(item.group)!,
		}));
}
