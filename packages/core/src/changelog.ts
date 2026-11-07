import semver from 'semver';
import {
	assertGitRepo,
	assertRevision,
	getRemoteWebUrl,
	listReleaseTags,
	readCommits,
	runGit,
} from './git.js';
import {getGitmoji} from './gitmojis.js';
import {groupCommits} from './group.js';
import {splitHighlights} from './highlights.js';
import {parseCommit} from './parse.js';
import type {
	ChamojiConfig,
	Changelog,
	CommitClassifier,
	ParsedCommit,
	Release,
} from './types.js';
import {bumpFor, nextVersion} from './version.js';
import {
	WorkstreamError,
	readWorkstreamsAt,
	type Workstream,
} from './workstreams.js';

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
	/**
	 * Only the commits after this ref (`since..to`), as one Unreleased
	 * section, whatever the tags. For previews such as "what this branch
	 * adds"; its `nextVersion` is the bump those commits imply on the last tag.
	 */
	since?: string;
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

	const {since} = options;
	if (since !== undefined && (from !== undefined || release !== undefined)) {
		throw new Error("--since can't be combined with --from or --release");
	}

	await assertGitRepo(cwd);
	await assertRevision(cwd, to);
	if (since !== undefined) {
		await assertRevision(cwd, since);
	}

	const tags = await listReleaseTags(cwd, to);
	if (from && !tags.some(tag => tag.name === from)) {
		throw new Error(`Unknown release tag for --from: ${from}`);
	}

	type Pending = {
		fields: Pick<Release, 'version' | 'tag' | 'previousTag' | 'date'>;
		commits: ParsedCommit[];
		isUnreleased: boolean;
		/** The ref whose workstreams file applies: `to`, or the tag. */
		ref: string;
	};
	const pending: Pending[] = [];
	const latest = tags[0]?.name ?? null;
	const unreleased = await readCommits(
		cwd,
		since === undefined
			? latest
				? `${latest}..${to}`
				: to
			: `${since}..${to}`,
	);
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
			ref: to,
		});
	}

	for (const [index, tag] of since === undefined ? tags.entries() : []) {
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
			ref: tag.name,
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

	const releases: Release[] = [];
	const tagsAtTo = new Set(
		(await runGit(['tag', '--points-at', to], cwd)).split('\n'),
	);
	for (const {fields, commits, isUnreleased, ref} of pending) {
		releases.push(
			await buildRelease(
				cwd,
				config,
				fields,
				commits,
				ref,
				isUnreleased,
				ref === to || tagsAtTo.has(ref),
			),
		);
	}

	const repositoryUrl = config.repositoryUrl ?? (await getRemoteWebUrl(cwd));
	return {...(repositoryUrl ? {repositoryUrl} : {}), releases};
}

/**
 * One release from its commits: the bump, the next version when unreleased,
 * shipped workstreams folded into highlights, and the rest grouped.
 *
 * The workstreams file is read as of `ref`, so a workstream counts as shipped
 * only in the release that marked it so. A bad file fails the build only when
 * `strict` (the release is at the head of history, which an unreleased one
 * always is); otherwise it is skipped, not fatal.
 */
export async function buildRelease(
	cwd: string,
	config: ChamojiConfig,
	fields: Pick<Release, 'version' | 'tag' | 'previousTag' | 'date'>,
	commits: ParsedCommit[],
	ref: string,
	isUnreleased: boolean,
	strict: boolean = isUnreleased,
): Promise<Release> {
	const bump = bumpFor(commits);
	const workstreams =
		strict || commits.some(commit => commit.workstream !== undefined)
			? await readWorkstreamsFor(cwd, ref, strict)
			: [];
	const {highlights, loose} = splitHighlights(
		commits,
		workstreams,
		config.groups,
	);
	return {
		...fields,
		bump,
		nextVersion: isUnreleased ? nextVersion(fields.previousTag, bump) : null,
		...(highlights.length > 0 ? {highlights} : {}),
		groups: groupCommits(loose, config.groups),
	};
}

/**
 * The workstreams file as of `ref`. An unreadable file throws when it is the
 * one at `to` (`strict`), and counts as no workstreams otherwise.
 */
async function readWorkstreamsFor(
	cwd: string,
	ref: string,
	strict: boolean,
): Promise<Workstream[]> {
	try {
		return await readWorkstreamsAt(cwd, ref);
	} catch (error) {
		if (!strict && error instanceof WorkstreamError) {
			return [];
		}

		throw error;
	}
}

/**
 * Runs the classifier on unsorted commits and applies its picks in place.
 * Unknown codes are ignored, and so is `boom`: only authors declare breaking
 * changes.
 */
export async function applyClassifier(
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
