import {applyClassifier, buildRelease} from '../changelog.js';
import {assertGitRepo, getRemoteWebUrl, listTags, runGit} from '../git.js';
import type {
	ChamojiConfig,
	Changelog,
	CommitClassifier,
	Release,
} from '../types.js';
import {inWindowOrder, sortWindow, unitSettings, windowReader} from './plan.js';
import {unitTagHistory} from './tags.js';
import {readUpstream, sinceRange} from './upstream.js';
import {readWorkspace, resolveUnits} from './workspace.js';

export type UnitChangelogOptions = {
	cwd: string;
	config: ChamojiConfig;
	unit: string;
	classify?: CommitClassifier;
};

/**
 * One unit's whole changelog: a section per release, rebuilt from each pair
 * of consecutive unit tags, newest first, under an Unreleased section for
 * what came after the last tag. The oldest release starts at the repo's
 * starting point (`upstream.since`), or its first commit. Commits are read,
 * filtered and attributed as `planUnitReleases` does, so a section holds the
 * unit's own commits and the shared ones that rode along with it.
 *
 * A section's `version` is the plain version and its `tag` the unit's tag.
 * Lines the release itself added, such as dependency ranges, aren't commits
 * and so aren't rebuilt.
 */
export async function unitChangelog(
	options: UnitChangelogOptions,
): Promise<Changelog> {
	const {config} = options;
	const settings = unitSettings(config, [options.unit]);
	await assertGitRepo(options.cwd);
	const root = (
		await runGit(['rev-parse', '--show-toplevel'], options.cwd)
	).trim();
	const packages = await readWorkspace(root);
	const units = resolveUnits(settings, packages);
	const unit = units.find(item => item.name === options.unit)!;
	const tags = await listTags(root, 'HEAD');
	const history = unitTagHistory(tags, unit, settings);

	type Pending = {
		fields: Pick<Release, 'version' | 'tag' | 'previousTag' | 'date'>;
		range: string;
		ref: string;
	};
	const pending: Pending[] = [
		{
			fields: {
				version: 'Unreleased',
				tag: null,
				previousTag: history[0]?.tag ?? null,
				date: null,
			},
			range: history[0]
				? `refs/tags/${history[0].tag}..HEAD`
				: ((await sinceRange(root, settings)) ?? 'HEAD'),
			ref: 'HEAD',
		},
	];
	for (const [index, tag] of history.entries()) {
		const previous = history[index + 1];
		const ref = `refs/tags/${tag.tag}`;
		pending.push({
			fields: {
				version: tag.version,
				tag: tag.tag,
				previousTag: previous?.tag ?? null,
				date: tag.date.slice(0, 10) || null,
			},
			range: previous
				? `refs/tags/${previous.tag}..${ref}`
				: ((await sinceRange(root, settings, ref)) ?? ref),
			ref,
		});
	}

	const upstream = await readUpstream(root, 'HEAD', settings, tags);
	const reader = windowReader(root, upstream);
	for (const {range} of pending) await reader.read(range);
	if (options.classify) {
		await applyClassifier(options.classify, reader.parsed());
	}

	const atHead = new Set(
		(await runGit(['tag', '--points-at', 'HEAD'], root)).split('\n'),
	);
	const releases: Release[] = [];
	for (const {fields, range, ref} of pending) {
		const read = await reader.read(range);
		const {own, shared} = await sortWindow(
			reader,
			read,
			unit,
			units,
			packages,
			settings,
		);
		const isUnreleased = fields.tag === null;
		if (isUnreleased && own.length + shared.length === 0) continue;
		const built = await buildRelease(
			root,
			config,
			fields,
			inWindowOrder([...own, ...shared], read.position),
			ref,
			isUnreleased,
			isUnreleased || atHead.has(fields.tag!),
		);
		// Unit versions follow the unit's own rules; next-version works them out.
		releases.push({...built, nextVersion: null});
	}

	const repositoryUrl = config.repositoryUrl ?? (await getRemoteWebUrl(root));
	return {...(repositoryUrl ? {repositoryUrl} : {}), releases};
}
