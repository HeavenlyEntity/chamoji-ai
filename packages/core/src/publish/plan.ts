import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import semver from 'semver';
import {assertGitRepo, runGit} from '../git.js';
import {ReleaseError} from '../release.js';
import type {ChamojiConfig} from '../types.js';
import {dependencyOrder, unitSettings} from '../units/plan.js';
import type {PublishSettings, ReleaseSettings} from '../units/settings.js';
import {unitTagHistory} from '../units/tags.js';
import {
	isExcluded,
	readPackage,
	readWorkspace,
	resolveUnits,
	type ResolvedUnit,
	type WorkspacePackage,
} from '../units/workspace.js';
import {
	appRefusal,
	checkClean,
	checkDependencies,
	checkDependenciesOnNpm,
	mask,
	packChecked,
	runCheckCommand,
	scrubEnv,
	tail,
	type Lookup,
	type Manifest,
} from './checks.js';
import {distTagFor} from './dist-tags.js';
import {classifyPackage} from './kind.js';
import {publishedVersions, type NpmRunner} from './npm.js';
import {detectPackageManager, spawnSpec, type PackageManager} from './pack.js';
import {registryFor} from './registry.js';

const execFileAsync = promisify(execFile);

export type PublishTarget = {
	name: string;
	path: string;
	version: string;
	/** The git tag that released it. */
	tag: string;
	registry: string;
	distTag: string;
	/** Absolute path; empty when `published`, since nothing is packed then. */
	tarball: string;
	access: 'public' | 'restricted' | null;
	/** Already on the registry. */
	published: boolean;
	/** The registry has no version of it at all. */
	firstVersion: boolean;
};

export type PublishPlan = {
	/** Where it was planned and packed: the repo, or the temporary worktree. */
	root: string;
	pm: PackageManager;
	/** In dependency order. */
	targets: PublishTarget[];
	skipped: Array<{name: string; reason: string}>;
	/** The tarball folder; `discardPublishPlan` removes it. */
	workdir: string;
	/** The temporary worktree of a `--from` tag not at HEAD, else null. */
	worktree: string | null;
};

export type PublishOptions = {
	cwd: string;
	config: ChamojiConfig;
	/** Publish what these tags released, instead of the tags at HEAD. */
	from?: string[];
	/** Only these units. */
	units?: string[];
	/** The dist-tag, instead of the one the version implies. */
	tag?: string;
	npm: NpmRunner;
	env: Record<string, string>;
	/**
	 * For `release --publish`: tag -> version for releases set in the working
	 * tree and not tagged yet. They replace the tags at HEAD, and the tree may
	 * be dirty.
	 */
	versions?: Map<string, string>;
	/** Don't compare manifest versions with the tags. */
	skipTagCheck?: boolean;
};

const DEFAULT_PUBLISH: PublishSettings = {
	check: null,
	prereleaseTag: 'next',
	packages: [],
};

const INSTALL: Record<PackageManager, string[]> = {
	pnpm: ['install', '--frozen-lockfile'],
	yarn: ['install', '--immutable'],
	bun: ['install', '--frozen-lockfile'],
	npm: ['ci'],
};

type Scrubbed = ReturnType<typeof scrubEnv>;

/** A tag being published, and the unit it belongs to in a units repo. */
type Release = {tag: string; version: string; unit: ResolvedUnit | null};

/** A package in the run, with its own manifest. */
type Chosen = {pkg: WorkspacePackage; release: Release; manifest: Manifest};

const fail = (message: string): never => {
	throw new ReleaseError('publish-check', message);
};

/**
 * Works out what a publish covers and runs every check before anything is
 * published: a clean tree, versions that match their tags, no apps, no
 * dependency npm can't install, the repo's own `publish.check`, and a
 * tarball for each package not on the registry yet. The first failure
 * throws `ReleaseError('publish-check', …)` and leaves nothing behind.
 */
export async function planPublish(
	options: PublishOptions,
): Promise<PublishPlan> {
	await assertGitRepo(options.cwd);
	const top = (
		await runGit(['rev-parse', '--show-toplevel'], options.cwd)
	).trim();
	if (options.units?.length) unitSettings(options.config, options.units);

	// Installs, packs and the check run the repo's scripts: no npm credentials.
	const scrubbed = scrubEnv({...process.env, ...options.env});
	const worktree = await checkoutFor(top, options.from ?? [], scrubbed);
	try {
		return await planIn(worktree ?? top, worktree, options, scrubbed);
	} catch (error) {
		if (worktree) await removeWorktree(worktree);
		throw error;
	}
}

/** Removes a plan's tarballs and its temporary worktree, if any. */
export async function discardPublishPlan(plan: PublishPlan): Promise<void> {
	await rm(plan.workdir, {recursive: true, force: true});
	if (plan.worktree) await removeWorktree(plan.worktree);
}

async function removeWorktree(dir: string): Promise<void> {
	// Git removes a worktree from inside it as well as from the main checkout.
	await runGit(['worktree', 'remove', '--force', dir], dir).catch(() => {});
	await rm(dir, {recursive: true, force: true});
}

const commitOf = async (root: string, ref: string): Promise<string> =>
	(
		await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)
	).trim();

/**
 * The temporary worktree to plan `from` in, installed with the lockfile, or
 * null when the tags are at HEAD.
 */
async function checkoutFor(
	top: string,
	from: string[],
	scrubbed: Scrubbed,
): Promise<string | null> {
	if (from.length === 0) return null;
	const commits = new Set<string>();
	for (const tag of from) {
		// eslint-disable-next-line no-await-in-loop
		const commit = await commitOf(top, `refs/tags/${tag}`).catch(() => '');
		if (!commit) throw new Error(`there's no tag ${tag}`);
		commits.add(commit);
	}

	if (commits.size > 1) {
		throw new Error(
			`the --from tags are on different commits; publish them one at a time`,
		);
	}

	const commit = [...commits][0]!;
	if (commit === (await commitOf(top, 'HEAD'))) return null;

	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-publish-'));
	try {
		await runGit(['worktree', 'add', '--detach', dir, commit], top);
		const pm = await detectPackageManager(dir);
		const run = spawnSpec(pm, INSTALL[pm]);
		await execFileAsync(run.file, run.args, {
			cwd: dir,
			env: scrubbed.env,
			maxBuffer: 64 * 1024 * 1024,
		}).catch((error: unknown) => {
			const failed = error as {stderr?: string; message: string};
			throw new Error(
				mask(
					`${pm} ${INSTALL[pm].join(' ')} failed in the worktree of ${from[0]}:\n${tail(failed.stderr || failed.message)}`,
					scrubbed.secrets,
				),
			);
		});
	} catch (error) {
		await removeWorktree(dir);
		throw error;
	}

	return dir;
}

async function planIn(
	root: string,
	worktree: string | null,
	options: PublishOptions,
	scrubbed: Scrubbed,
): Promise<PublishPlan> {
	const settings = options.config.release;
	const publish = settings?.publish ?? DEFAULT_PUBLISH;

	if (!options.versions && !worktree) await checkClean(root);

	const packages = await readWorkspace(root);
	const top = await rootPackage(root);
	const all = top ? [...packages, top] : packages;
	const releases = await releasesFor(root, options, settings, packages);
	const {chosen, skipped} = await choose(root, releases, all, options);
	const ordered = dependencyOrder(
		chosen,
		item => item.pkg.name,
		item =>
			chosen.filter(
				other =>
					other !== item && item.pkg.runtimeDeps.includes(other.pkg.name),
			),
	);
	const units =
		settings && settings.shape !== 'single'
			? new Set(settings.units.map(unit => unit.path))
			: null;
	for (const {pkg, manifest} of ordered) {
		checkDependencies(pkg, manifest, all, units);
	}

	const pm = await detectPackageManager(root);
	const known = new Map<string, Promise<Lookup>>();
	const lookup = async (pkg: WorkspacePackage): Promise<Lookup> => {
		let found = known.get(pkg.name);
		if (!found) {
			found = (async () => {
				const registry = await registryFor(root, pkg);
				const versions = await publishedVersions(
					options.npm,
					pkg.name,
					registry,
					root,
				);
				return {registry, versions};
			})();
			known.set(pkg.name, found);
		}

		return found;
	};

	const targets: PublishTarget[] = [];
	for (const {pkg, release, manifest} of ordered) {
		// eslint-disable-next-line no-await-in-loop
		const {registry, versions} = await lookup(pkg);
		const published = versions?.versions.includes(release.version) ?? false;
		let distTag = '';
		try {
			distTag = distTagFor(
				release.version,
				published ? null : (versions?.latest ?? null),
				{tag: options.tag, prereleaseTag: publish.prereleaseTag},
			);
		} catch (error) {
			if (error instanceof ReleaseError) fail(`${pkg.name}: ${error.message}`);
			throw error;
		}

		const access = (manifest.publishConfig as Manifest | undefined)?.access;
		targets.push({
			name: pkg.name,
			path: pkg.path,
			version: release.version,
			tag: release.tag,
			registry,
			distTag,
			tarball: '',
			access: access === 'public' || access === 'restricted' ? access : null,
			published,
			firstVersion: versions === null,
		});
	}

	const workdir = await mkdtemp(path.join(tmpdir(), 'chamoji-tarballs-'));
	try {
		const fresh = targets.filter(target => !target.published);
		if (fresh.length > 0) {
			await runCheckCommand(root, publish.check, scrubbed);
		}

		const packed = new Map<string, Manifest>();
		for (const target of fresh) {
			const pkg = ordered.find(item => item.pkg.name === target.name)!.pkg;
			// eslint-disable-next-line no-await-in-loop
			const tarball = await packChecked(root, pkg, pm, workdir, scrubbed);
			target.tarball = tarball.file;
			packed.set(target.name, tarball.manifest);
		}

		await checkDependenciesOnNpm(targets, packed, all, lookup);
	} catch (error) {
		await rm(workdir, {recursive: true, force: true});
		throw error;
	}

	return {root, pm, targets, skipped, workdir, worktree};
}

async function readManifest(file: string): Promise<Manifest | null> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}

	const parsed: unknown = JSON.parse(text);
	return typeof parsed === 'object' && parsed !== null
		? (parsed as Manifest)
		: {};
}

/** The repo root's own package, which a single repo publishes when public. */
async function rootPackage(root: string): Promise<WorkspacePackage | null> {
	const manifest = await readManifest(path.join(root, 'package.json'));
	return manifest ? readPackage('', manifest) : null;
}

/** The releases to publish: from `versions`, `--from`, or the tags at HEAD. */
async function releasesFor(
	root: string,
	options: PublishOptions,
	settings: ReleaseSettings | undefined,
	packages: WorkspacePackage[],
): Promise<Release[]> {
	const tags = options.versions
		? [...options.versions.keys()]
		: options.from?.length
			? options.from
			: (await runGit(['tag', '--points-at', 'HEAD'], root))
					.split('\n')
					.filter(Boolean);

	const releases: Release[] = [];
	if (!settings || settings.shape === 'single') {
		for (const tag of tags) {
			const version = options.versions?.get(tag) ?? semver.valid(tag);
			if (version) releases.push({tag, version, unit: null});
			else if (options.from?.length) {
				throw new Error(`${tag} isn't a release tag, such as v1.2.3`);
			}
		}

		return releases;
	}

	const units = resolveUnits(settings, packages).filter(
		unit => !options.units?.length || options.units.includes(unit.name),
	);
	for (const tag of tags) {
		let matched = false;
		for (const unit of units) {
			const [found] = unitTagHistory([{name: tag, date: ''}], unit, settings);
			if (!found) continue;
			matched = true;
			const version = options.versions?.get(tag) ?? found.version;
			releases.push({tag, version, unit});
		}

		if (!matched && options.from?.length) {
			throw new Error(`${tag} isn't a release tag of any unit`);
		}
	}

	return releases;
}

/** Picks each release's packages: public, not excluded, at its version, not an app. */
async function choose(
	root: string,
	releases: Release[],
	all: WorkspacePackage[],
	options: PublishOptions,
): Promise<{chosen: Chosen[]; skipped: PublishPlan['skipped']}> {
	const settings = options.config.release;
	const publish = settings?.publish ?? DEFAULT_PUBLISH;
	const exclude = settings?.exclude ?? [];
	// Only a unit named by --from or --unit is refused for being an app; a
	// single repo's tag names the release, so its apps are always skipped.
	const named = Boolean(options.from?.length || options.units?.length);
	const dependedOn = new Set(all.flatMap(pkg => pkg.runtimeDeps));
	const chosen: Chosen[] = [];
	const skipped: PublishPlan['skipped'] = [];
	const mismatch = (pkg: WorkspacePackage, release: Release): string =>
		`${pkg.name}: ${pkg.version ? `its version is ${pkg.version}` : 'it has no version'}, which doesn't match the tag ${release.tag}`;

	for (const release of releases) {
		const candidates = release.unit
			? release.unit.pkg
				? [release.unit.pkg]
				: []
			: all;
		const others: WorkspacePackage[] = [];
		let found = 0;
		for (const pkg of candidates) {
			if (pkg.private || isExcluded(pkg.path, exclude)) continue;
			if (chosen.some(item => item.pkg.name === pkg.name)) continue;
			if (pkg.version !== release.version) {
				if (!release.unit) {
					others.push(pkg);
					continue;
				}

				if (!options.skipTagCheck) fail(mismatch(pkg, release));
			}

			found++;
			if (
				!publish.packages.includes(pkg.name) &&
				!publish.packages.includes(pkg.path)
			) {
				// eslint-disable-next-line no-await-in-loop
				const kind = await classifyPackage(root, pkg, dependedOn);
				if (kind.kind === 'app') {
					if (named && release.unit) fail(appRefusal(pkg, kind));
					skipped.push({
						name: pkg.name,
						reason: `${kind.framework ? `${kind.framework} app` : 'app'} (${kind.reasons.join(', ')})`,
					});
					continue;
				}
			}

			// eslint-disable-next-line no-await-in-loop
			const manifest = await readManifest(
				path.join(root, pkg.path, 'package.json'),
			);
			chosen.push({pkg, release, manifest: manifest ?? {}});
		}

		// A single repo's packages at other versions aren't in this release,
		// unless none is, which means the tag and the manifests disagree.
		if (found === 0 && others[0] && !options.skipTagCheck) {
			fail(mismatch(others[0], release));
		}

		for (const pkg of others) {
			skipped.push({
				name: pkg.name,
				reason: `version ${pkg.version ?? 'missing'}, not ${release.version}`,
			});
		}
	}

	return {chosen, skipped};
}
