import {
	assertGitRepo,
	assertRevision,
	getRemoteWebUrl,
	listReleaseTags,
	readCommits,
} from './git.js';
import {groupCommits} from './group.js';
import {parseCommit} from './parse.js';
import type {ChamojiConfig, Changelog, RawCommit, Release} from './types.js';
import {bumpFor, nextVersion} from './version.js';

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
};

export async function buildChangelog(
	options: BuildChangelogOptions,
): Promise<Changelog> {
	const {cwd, config, to = 'HEAD', from, release} = options;
	const today = options.today ?? new Date().toISOString().slice(0, 10);

	await assertGitRepo(cwd);
	await assertRevision(cwd, to);
	const tags = await listReleaseTags(cwd, to);
	if (from && !tags.some(tag => tag.name === from)) {
		throw new Error(`Unknown release tag for --from: ${from}`);
	}

	const makeRelease = (
		fields: Pick<Release, 'version' | 'tag' | 'previousTag' | 'date'>,
		raw: RawCommit[],
		isUnreleased: boolean,
	): Release => {
		const commits = raw.map(parseCommit);
		const bump = bumpFor(commits);
		return {
			...fields,
			bump,
			nextVersion: isUnreleased ? nextVersion(fields.previousTag, bump) : null,
			groups: groupCommits(commits, config.groups),
		};
	};

	const releases: Release[] = [];
	const latest = tags[0]?.name ?? null;
	const unreleased = await readCommits(cwd, latest ? `${latest}..${to}` : to);
	if (unreleased.length > 0) {
		releases.push(
			makeRelease(
				{
					version: release ?? 'Unreleased',
					tag: null,
					previousTag: latest,
					date: release ? today : null,
				},
				unreleased,
				true,
			),
		);
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
		releases.push(
			makeRelease(
				{
					version: tag.name,
					tag: tag.name,
					previousTag,
					date: tag.date.slice(0, 10) || null,
				},
				raw,
				false,
			),
		);
	}

	const repositoryUrl = config.repositoryUrl ?? (await getRemoteWebUrl(cwd));
	return {...(repositoryUrl ? {repositoryUrl} : {}), releases};
}
