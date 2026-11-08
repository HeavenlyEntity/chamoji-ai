import semver from 'semver';
import {listReleaseTags, listTags, runGit} from '../git.js';
import type {ChamojiConfig} from '../types.js';
import {unitTagHistory} from '../units/tags.js';
import {isExcluded, readWorkspace, resolveUnits} from '../units/workspace.js';
import {checkPublishAuth, type FetchLike} from './auth.js';
import {publishMethod} from './credentials.js';
import {distTagFor} from './dist-tags.js';
import {publishedVersions} from './npm.js';
import {registryFor} from './registry.js';
import {discardPublishPlan, planPublish, type PublishOptions} from './plan.js';
import {runPublish, type PublishOutcome} from './run.js';

export type CatchUpResult = {
	tag: string;
	/** What each of the tag's packages came to; empty when `error` stopped it. */
	outcomes: PublishOutcome[];
	/** Why the tag couldn't be planned, checked or run, when it couldn't. */
	error?: string;
};

export type CatchUpOptions = Omit<PublishOptions, 'from' | 'versions'> & {
	fetch: FetchLike;
	/** Running in CI: provenance is asked for when the method allows it. */
	ci: boolean;
	/** `release.publish.registries`: the extra registries that may hold a token. */
	registries?: string[];
};

/**
 * The newest release tag of each unit, or the newest version tag in a repo
 * without units. Units in a fixed group that share a tag give it once.
 */
export async function latestReleaseTags(
	cwd: string,
	config: ChamojiConfig,
): Promise<string[]> {
	const root = (await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();
	const settings = config.release;
	if (!settings || settings.shape === 'single') {
		const [latest] = await listReleaseTags(root, 'HEAD');
		return latest ? [latest.name] : [];
	}

	const units = resolveUnits(settings, await readWorkspace(root));
	const tags = await listTags(root, 'HEAD');
	const latest = units.flatMap(unit => {
		const [newest] = unitTagHistory(tags, unit, settings);
		return newest ? [newest.tag] : [];
	});
	return [...new Set(latest)];
}

/**
 * Whether everything `tag` released is on the registry, answered without a
 * checkout or an install: the manifests are read at the tag with `git show`,
 * and the registry is asked for each public package's version. Returns the
 * `already` outcomes when so, and null whenever anything is unclear (a
 * manifest that can't be read at the tag, a version that isn't there, a
 * registry that won't answer), so the full plan decides and says why.
 */
async function nothingMissing(
	options: CatchUpOptions,
	tag: string,
): Promise<PublishOutcome[] | null> {
	try {
		const root = (
			await runGit(['rev-parse', '--show-toplevel'], options.cwd)
		).trim();
		const settings = options.config.release;
		const packages = await readWorkspace(root);
		let version: string | null;
		let paths: string[];
		if (!settings || settings.shape === 'single') {
			version = semver.valid(tag);
			paths = ['', ...packages.map(pkg => pkg.path)];
		} else {
			const owners = resolveUnits(settings, packages).filter(
				unit => !options.units?.length || options.units.includes(unit.name),
			);
			const read = owners.flatMap(unit => {
				const [found] = unitTagHistory([{name: tag, date: ''}], unit, settings);
				return found && unit.pkg
					? [{path: unit.pkg.path, version: found.version}]
					: [];
			});
			paths = read.map(item => item.path);
			version = read[0]?.version ?? null;
			if (read.some(item => item.version !== version)) return null;
		}

		if (!version || paths.length === 0) return null;
		const outcomes: PublishOutcome[] = [];
		for (const dir of paths) {
			// eslint-disable-next-line no-await-in-loop
			const text = await runGit(
				['show', `refs/tags/${tag}:${dir ? `${dir}/` : ''}package.json`],
				root,
			);
			const manifest = JSON.parse(text) as Record<string, unknown>;
			if (manifest.private === true) continue;
			if (isExcluded(dir, settings?.exclude ?? [])) continue;
			if (typeof manifest.name !== 'string' || manifest.name === '') {
				if (dir === '') continue;
				return null;
			}

			// A single repo's other versions belong to other releases.
			if (manifest.version !== version) {
				if (!settings || settings.shape === 'single') continue;
				return null;
			}

			// eslint-disable-next-line no-await-in-loop
			const registry = await registryFor(root, {
				name: manifest.name,
				path: dir,
			} as Parameters<typeof registryFor>[1]);
			// eslint-disable-next-line no-await-in-loop
			const found = await publishedVersions(
				options.npm,
				manifest.name,
				registry,
				root,
			);
			if (!found?.versions.includes(version)) return null;
			outcomes.push({
				name: manifest.name,
				version,
				distTag: distTagFor(version, null, {
					tag: options.tag,
					prereleaseTag: settings?.publish?.prereleaseTag ?? 'next',
				}),
				registry,
				status: 'already',
			});
		}

		return outcomes.length > 0 ? outcomes : null;
	} catch {
		return null;
	}
}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Publishes what each latest release tag released and npm doesn't have yet:
 * what a CI merge run does first, to finish a release that was tagged and
 * pushed but never published. A tag that can't be planned, checked or
 * published is recorded in its result's `error` and the others go on, so this
 * never throws for one tag. A failed publish is an outcome, as in `runPublish`.
 */
export async function catchUp(
	options: CatchUpOptions,
): Promise<CatchUpResult[]> {
	const {fetch, ci, registries, ...planning} = options;
	const results: CatchUpResult[] = [];
	let tags: string[];
	try {
		tags = await latestReleaseTags(options.cwd, options.config);
	} catch (error) {
		return [{tag: '', outcomes: [], error: messageOf(error)}];
	}

	for (const tag of tags) {
		// eslint-disable-next-line no-await-in-loop
		const already = await nothingMissing(options, tag);
		if (already) {
			results.push({tag, outcomes: already});
			continue;
		}

		try {
			// eslint-disable-next-line no-await-in-loop
			const plan = await planPublish({...planning, from: [tag]});
			let method;
			try {
				// Nothing missing needs no credentials.
				method = plan.targets.some(target => !target.published)
					? // eslint-disable-next-line no-await-in-loop
						await checkPublishAuth(plan, {
							env: options.env,
							npm: options.npm,
							fetch,
							ci,
							registries: registries ?? [],
						})
					: publishMethod(options.env);
			} catch (error) {
				// eslint-disable-next-line no-await-in-loop
				await discardPublishPlan(plan);
				throw error;
			}

			// eslint-disable-next-line no-await-in-loop
			const outcomes = await runPublish(plan, {
				method,
				npm: options.npm,
				env: options.env,
				ci,
				registries: registries ?? [],
			});
			results.push({tag, outcomes});
		} catch (error) {
			results.push({tag, outcomes: [], error: messageOf(error)});
		}
	}

	return results;
}
