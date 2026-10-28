import semver from 'semver';
import {
	assertGitRepo,
	assertRevision,
	getRemoteWebUrl,
	listReleaseTags,
	readCommits,
} from './git.js';
import {getGitmoji} from './gitmojis.js';
import {groupCommits} from './group.js';
import {parseCommit} from './parse.js';
import type {
	ChamojiConfig,
	Changelog,
	CommitClassifier,
	ParsedCommit,
	Release,
} from './types.js';
import {bumpFor, nextVersion} from './version.js';

/** The tag a `--release` version will get, following the latest tag's `v` style. */
function futureTag(release: string, latestTag: string | null): string {
	if (release.startsWith('v')) {
		return release;
	}

	return latestTag === null || latestTag.startsWith('v')
		? `v${release}`
		: release;
}

export type BuildChangelogOptions = {
	cwd: string;
	config: ChamojiConfig;
	/** Ref treated as the head of history. Defaults to `HEAD`. */
	to?: string;
	/** Stop before the release with this tag (it and older ones are left out). */
	from?: string;
	/** Version to give the Unreleased section, dated `today`. */
	release?: string;
	/** `YYYY-MM-DD`; defaults to the current UTC date. */
	today?: string;
	/**
	 * Optional AI step for commits no gitmoji, type or wording rule could
	 * sort. It never sees or overrides the others.
	 */
	classify?: CommitClassifier;
	/**
	 * Which commits `classify` sees: every release (default), or only the
	 * unreleased section, which is all `next-version` needs.
	 */
	classifyReleases?: 'all' | 'unreleased';
};

export async function buildChangelog(
	options: BuildChangelogOptions,
): Promise<Changelog> {
	const {cwd, config, to = 'HEAD', from, release} = options;
	const today = options.today ?? new Date().toISOString().slice(0, 10);

	if (release !== undefined && semver.valid(release) === null) {
		throw new Error(`Invalid release version: ${release}`);
	}

	await assertGitRepo(cwd);
	await assertRevision(cwd, to);
	const tags = await listReleaseTags(cwd, to);
	if (from && !tags.some(tag => tag.name === from)) {
		throw new Error(`Unknown release tag for --from: ${from}`);
	}

	type Pending = {
		fields: Pick<Release, 'version' | 'tag' | 'previousTag' | 'date'>;
		commits: ParsedCommit[];
		isUnreleased: boolean;
	};
	const pending: Pending[] = [];
	const latest = tags[0]?.name ?? null;
	const unreleased = await readCommits(cwd, latest ? `${latest}..${to}` : to);
	if (unreleased.length > 0) {
		pending.push({
			fields: {
				version: release ?? 'Unreleased',
				tag: release ? futureTag(release, latest) : null,
				previousTag: latest,
				date: release ? today : null,
			},
			commits: unreleased.map(parseCommit),
			isUnreleased: true,
		});
	}

	for (const [index, tag] of tags.entries()) {
		if (tag.name === from) {
			break;
		}

		const previousTag = tags[index + 1]?.name ?? null;
		const raw = await readCommits(
			cwd,
			previousTag ? `${previousTag}..${tag.name}` : tag.name,
		);
		pending.push({
			fields: {
				version: tag.name,
				tag: tag.name,
				previousTag,
				date: tag.date.slice(0, 10) || null,
			},
			commits: raw.map(parseCommit),
			isUnreleased: false,
		});
	}

	if (options.classify) {
		const scope =
			options.classifyReleases === 'unreleased'
				? pending.filter(item => item.isUnreleased)
				: pending;
		await applyClassifier(
			options.classify,
			scope.flatMap(item => item.commits),
		);
	}

	const releases = pending.map(({fields, commits, isUnreleased}): Release => {
		const bump = bumpFor(commits);
		return {
			...fields,
			bump,
			nextVersion: isUnreleased ? nextVersion(fields.previousTag, bump) : null,
			groups: groupCommits(commits, config.groups),
		};
	});

	const repositoryUrl = config.repositoryUrl ?? (await getRemoteWebUrl(cwd));
	return {...(repositoryUrl ? {repositoryUrl} : {}), releases};
}

/**
 * Runs the classifier on unsorted commits and applies its picks in place.
 * Unknown codes are ignored, and so is `boom`: only authors declare breaking
 * changes.
 */
async function applyClassifier(
	classify: CommitClassifier,
	commits: ParsedCommit[],
): Promise<void> {
	const unsorted = commits.filter(commit => commit.gitmojiSource === null);
	if (unsorted.length === 0) {
		return;
	}

	const picks = await classify(unsorted);
	for (const commit of unsorted) {
		const code = picks.get(commit.hash);
		if (code && code !== 'boom' && getGitmoji(code)) {
			commit.gitmoji = code;
			commit.gitmojiSource = 'ai';
		}
	}
}
