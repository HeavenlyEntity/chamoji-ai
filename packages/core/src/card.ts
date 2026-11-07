import type {Changelog, Group, Release} from './types.js';

/** Where the repo card is rendered. */
export const CARD_ENDPOINT = 'https://chamoji.dev/api/card';

/** The numbers on a repo card. Nothing here comes from commit text. */
export type RepoStats = {
	/** Latest tagged release, or null when the repo has no tags. */
	version: string | null;
	date: string | null;
	/** Tagged releases. */
	releases: number;
	/** Non-merge commits the changelog lists; commits in hidden groups aren't counted. */
	commits: number;
	/** Percent of commits that landed outside Miscellaneous, rounded down. */
	sorted: number;
	/** Commits in the latest release's Added, Fixed and Changed groups. */
	added: number;
	fixed: number;
	changed: number;
};

/** A release's groups, with those folded into its highlights counted too. */
const allGroups = (release: Release): Group[] => [
	...(release.highlights ?? []).flatMap(highlight => highlight.groups),
	...release.groups,
];

const groupSize = (changelog: Changelog, tag: string | null, id: string) => {
	const release = changelog.releases.find(item => item.tag === tag);
	return release
		? allGroups(release)
				.filter(group => group.group === id)
				.reduce((sum, group) => sum + group.commits.length, 0)
		: 0;
};

/**
 * Summarises a changelog for the repo card. `commits` and `sorted` are counted
 * the way `scripts/benchmark.mjs` does; the rest comes from the latest tagged
 * release.
 */
export function repoStats(changelog: Changelog): RepoStats {
	let commits = 0;
	let misc = 0;
	for (const release of changelog.releases) {
		for (const group of allGroups(release)) {
			commits += group.commits.length;
			if (group.group === 'misc') misc += group.commits.length;
		}
	}

	const tagged = changelog.releases.filter(release => release.tag !== null);
	const latest = tagged[0];
	const tag = latest?.tag ?? null;

	return {
		version: tag,
		date: latest?.date ?? null,
		releases: tagged.length,
		commits,
		sorted: commits === 0 ? 0 : Math.floor((100 * (commits - misc)) / commits),
		added: groupSize(changelog, tag, 'added'),
		fixed: groupSize(changelog, tag, 'fixed'),
		changed: groupSize(changelog, tag, 'changed'),
	};
}

/**
 * The card's URL. The renderer rejects `version` without `date` and the
 * reverse, so both are left out together when there is no release.
 */
export function cardUrl(
	endpoint: string,
	repo: string,
	stats: RepoStats,
): string {
	const query = new URLSearchParams({repo});
	if (stats.version !== null && stats.date !== null) {
		query.set('version', stats.version);
		query.set('date', stats.date);
	}

	query.set('releases', String(stats.releases));
	query.set('commits', String(stats.commits));
	query.set('sorted', String(stats.sorted));
	query.set('added', String(stats.added));
	query.set('fixed', String(stats.fixed));
	query.set('changed', String(stats.changed));
	return `${endpoint}?${query}`;
}
