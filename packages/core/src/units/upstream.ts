import semver from 'semver';
import {runGit, runGitWithInput, type ReleaseTag} from '../git.js';
import type {ParsedCommit} from '../types.js';
import type {ReleaseSettings} from './settings.js';
import {isIgnoredTag} from './tags.js';

export type Upstream = {
	commits: Set<string>;
	syncs: ParsedCommit[];
	/** Set when `upstream.remote` names a remote with nothing fetched. */
	warning?: string;
};

const FIELD = '\u001F';
// A tag that reads as a version: `v?`, digits and dots, then nothing or a prerelease.
export const VERSION_LIKE = /^v?\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

const isInheritedTag = (tag: string, settings: ReleaseSettings): boolean =>
	VERSION_LIKE.test(tag) && isIgnoredTag(tag, settings);

async function upstreamCommits(
	cwd: string,
	settings: ReleaseSettings,
	tags: ReleaseTag[],
): Promise<Pick<Upstream, 'commits' | 'warning'>> {
	const remote = settings.upstream?.remote;
	let warning: string | undefined;
	if (remote) {
		const fromRemote = lines(
			await runGit(['rev-list', `--glob=refs/remotes/${remote}/*`], cwd),
		);
		if (fromRemote.length > 0) return {commits: new Set(fromRemote)};
		warning = `upstream remote "${remote}" has no fetched branches here, so template history is recognised only by ignored version tags; run git remote add ${remote} <url> && git fetch ${remote} before chamoji`;
	}

	const withWarning = warning ? {warning} : {};
	const names = tags
		.map(tag => tag.name)
		.filter(name => isInheritedTag(name, settings));
	if (names.length === 0) return {commits: new Set(), ...withWarning};
	// Tag names go in on stdin, so there is no limit on how many.
	const out = await runGitWithInput(
		['rev-list', '--stdin'],
		cwd,
		names.map(name => `refs/tags/${name}\n`).join(''),
	);
	return {commits: new Set(lines(out)), ...withWarning};
}

/** The newest inherited tag the upstream parent brings in over the first parent, else its short hash. */
async function syncTarget(
	cwd: string,
	settings: ReleaseSettings,
	first: string,
	other: string,
): Promise<string> {
	const reachable = lines(
		await runGit(['tag', `--merged=${other}`, `--no-merged=${first}`], cwd),
	).filter(name => isInheritedTag(name, settings));
	const newest = reachable
		.map(name => ({
			name,
			version: semver.coerce(name, {includePrerelease: true}),
		}))
		.filter(entry => entry.version !== null)
		.sort(
			(a, b) =>
				semver.rcompare(a.version!, b.version!) || a.name.localeCompare(b.name),
		)[0];
	if (newest) return newest.name;
	return (
		await runGit(['rev-parse', '--short', '--end-of-options', other], cwd)
	).trim();
}

/** Upstream commit hashes (reachable from refs/remotes/<remote>/* or an ignored tag), one synthetic commit per sync merge in `range`, and a warning when the remote has nothing fetched. */
export async function readUpstream(
	cwd: string,
	range: string,
	settings: ReleaseSettings,
	tags: ReleaseTag[],
): Promise<Upstream> {
	const {commits, warning} = await upstreamCommits(cwd, settings, tags);
	const withWarning = warning ? {warning} : {};
	const base = settings.upstream?.name;
	if (commits.size === 0 || base === undefined) {
		return {commits, syncs: [], ...withWarning};
	}

	const merges = await runGit(
		[
			'log',
			'--merges',
			`--format=%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%P`,
			'--end-of-options',
			range,
		],
		cwd,
	);

	const syncs: ParsedCommit[] = [];
	for (const line of lines(merges)) {
		const [hash, shortHash, authorName, authorEmail, date, parentList] =
			line.split(FIELD) as [string, string, string, string, string, string];
		const [first, ...others] = parentList.split(' ');
		const other = others.find(parent => commits.has(parent));
		// Upstream's own merges (e.g. template PR merges) are not syncs.
		if (commits.has(hash) || !first || other === undefined) continue;

		const to = await syncTarget(cwd, settings, first, other);
		const description = `Updated the ${base} base to ${to}`;
		syncs.push({
			hash,
			shortHash,
			authorName,
			authorEmail,
			date,
			subject: `⬆️ ${description}`,
			body: '',
			gitmoji: 'arrow_up',
			gitmojiSource: 'gitmoji',
			type: null,
			scope: null,
			description,
			breaking: false,
			trailers: [],
			sync: {base, to},
		});
	}

	return {commits, syncs, ...withWarning};
}

/** The window for a unit with no tag before `to`: commits after upstream.since up to `to`, or undefined. */
export async function sinceRange(
	cwd: string,
	settings: ReleaseSettings,
	to = 'HEAD',
): Promise<string | undefined> {
	const since = settings.upstream?.since;
	if (!since) return undefined;
	const [, ...parents] = lines(
		await runGit(
			['rev-list', '--parents', '-n', '1', '--end-of-options', since],
			cwd,
		),
	)[0]!.split(' ');
	return parents.length > 0 ? `${since}^..${to}` : to;
}

/** Files the merge changed compared with its first parent. */
export async function syncFiles(
	cwd: string,
	sync: ParsedCommit,
): Promise<string[]> {
	const out = await runGit(
		['diff', '--name-only', '-z', `${sync.hash}^1`, sync.hash, '--'],
		cwd,
	);
	return out.split('\0').filter(Boolean);
}
