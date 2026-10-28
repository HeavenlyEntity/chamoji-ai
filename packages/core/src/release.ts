import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import {buildChangelog} from './changelog.js';
import {assertGitRepo, assertRevision, listReleaseTags, runGit} from './git.js';
import {renderMarkdown} from './render/markdown.js';
import type {
	ChamojiConfig,
	CommitClassifier,
	Release,
	SemverBump,
} from './types.js';

export const CHANGELOG_FILE = 'CHANGELOG.md';
const MANIFESTS = [
	'*package.json',
	'*package-lock.json',
	'*pyproject.toml',
	'*Cargo.toml',
];

/** A check that failed before anything changed; the message says what to do. */
export class ReleaseError extends Error {
	constructor(
		readonly code:
			| 'dirty'
			| 'branch'
			| 'shallow'
			| 'first-release'
			| 'not-newer'
			| 'tag-exists'
			| 'invalid-version',
		message: string,
	) {
		super(message);
		this.name = 'ReleaseError';
	}
}

export type ReleaseOptions = {
	cwd: string;
	config: ChamojiConfig;
	/** The version to release, with or without `v`. Defaults to the one the commits imply. */
	version?: string;
	/** Release from a branch other than origin's default. */
	anyBranch?: boolean;
	/** Fetch tags from origin first, so the version accounts for them. Default true. */
	fetch?: boolean;
	/** Plan despite uncommitted changes, for dry runs. */
	allowDirty?: boolean;
	/** `YYYY-MM-DD` for the new section; defaults to the current UTC date. */
	today?: string;
	classify?: CommitClassifier;
};

export type FileChange = {file: string; text: string; how: string};

export type ReadyPlan = {
	status: 'ready';
	/** Repository root; `changes` paths are relative to it. */
	root: string;
	version: string;
	tag: string;
	lastTag: string | null;
	bump: SemverBump | 'prerelease' | 'first';
	/** The new CHANGELOG.md section, without the `# Changelog` heading. */
	notes: string;
	/** CHANGELOG.md first, then any bumped manifests. */
	changes: FileChange[];
	subject: string;
	/** HEAD before the release, for rolling back. */
	start: string;
	warnings: string[];
};

export type ReleasePlan =
	{status: 'nothing'; lastTag: string; unreleased: string[]} | ReadyPlan;

/**
 * Works out a release without changing anything: checks the repository,
 * picks the version, renders the notes and computes every file change.
 */
export async function planRelease(
	options: ReleaseOptions,
): Promise<ReleasePlan> {
	const {config} = options;
	await assertGitRepo(options.cwd);
	await assertRevision(options.cwd, 'HEAD');
	const root = (
		await runGit(['rev-parse', '--show-toplevel'], options.cwd)
	).trim();
	const git = async (...args: string[]) => (await runGit(args, root)).trim();
	const tryGit = async (...args: string[]) => git(...args).catch(() => null);
	const warnings: string[] = [];

	const dirty = await git('status', '--porcelain');
	if (dirty && !options.allowDirty) {
		throw new ReleaseError(
			'dirty',
			`the working tree has uncommitted changes; commit or stash them first:\n${dirty}`,
		);
	}

	const branch = await git('branch', '--show-current');
	const originHead = await tryGit(
		'symbolic-ref',
		'--short',
		'refs/remotes/origin/HEAD',
	);
	const defaultBranch = originHead?.replace(/^origin\//, '');
	if (defaultBranch && branch !== defaultBranch && !options.anyBranch) {
		throw new ReleaseError(
			'branch',
			`on ${branch || 'a detached HEAD'}, not the default branch ${defaultBranch}; release from ${defaultBranch}, or pass --any-branch`,
		);
	}

	if ((await git('rev-parse', '--is-shallow-repository')) === 'true') {
		if ((await tryGit('fetch', '--quiet', '--unshallow', '--tags')) === null) {
			throw new ReleaseError(
				'shallow',
				'this is a shallow clone and fetching the full history failed; chamoji needs every commit and tag (in CI, check out with fetch-depth: 0)',
			);
		}
	} else if (
		options.fetch !== false &&
		(await tryGit('remote', 'get-url', 'origin')) !== null &&
		(await tryGit('fetch', '--quiet', '--tags')) === null
	) {
		warnings.push('could not fetch tags from origin; used the local tags');
	}

	const tags = await listReleaseTags(root, 'HEAD');
	const lastTag = tags[0]?.name ?? null;
	const previous = lastTag ? semver.valid(lastTag) : null;
	const changelog = await buildChangelog({
		cwd: root,
		config,
		...(lastTag ? {from: lastTag} : {}),
		classify: options.classify,
		classifyReleases: 'unreleased',
	});
	const unreleased: Release | undefined = changelog.releases.find(
		release => release.tag === null,
	);

	let version: string;
	if (options.version !== undefined) {
		const wanted = semver.valid(options.version);
		if (!wanted) {
			throw new ReleaseError(
				'invalid-version',
				`${options.version} is not a semver version`,
			);
		}

		if (previous && semver.lte(wanted, previous)) {
			throw new ReleaseError(
				'not-newer',
				`${wanted} is not newer than the last release, ${lastTag}`,
			);
		}

		version = wanted;
	} else if (!lastTag) {
		throw new ReleaseError(
			'first-release',
			'no release tags yet, so this is the first release: give the version, for example the one in your manifest, or 0.1.0',
		);
	} else if (unreleased?.nextVersion) {
		version = unreleased.nextVersion;
	} else {
		const subjects = await git(
			'log',
			'--no-merges',
			'--format=%s',
			`${lastTag}..HEAD`,
		);
		return {
			status: 'nothing',
			lastTag,
			unreleased: subjects ? subjects.split('\n') : [],
		};
	}

	const tag = `${tagPrefix(tags.map(item => item.name))}${version}`;
	if (await git('tag', '--list', tag)) {
		throw new ReleaseError(
			'tag-exists',
			`tag ${tag} already exists, though not on this branch; pick another version`,
		);
	}

	const today = options.today ?? new Date().toISOString().slice(0, 10);
	const section: Release = {
		version: tag,
		tag,
		previousTag: lastTag,
		date: today,
		bump: unreleased?.bump ?? null,
		nextVersion: null,
		groups: unreleased?.groups ?? [],
	};
	const notes = stripTitle(renderMarkdown({...changelog, releases: [section]}));

	const changes: FileChange[] = [];
	const existing = await readFile(
		path.join(root, CHANGELOG_FILE),
		'utf8',
	).catch(() => null);
	if (existing === null) {
		const full = lastTag
			? await buildChangelog({
					cwd: root,
					config,
					release: tag,
					today,
					classify: options.classify,
				})
			: {...changelog, releases: [section]};
		changes.push({
			file: CHANGELOG_FILE,
			text: renderMarkdown(full),
			how: 'created from the full history',
		});
	} else {
		changes.push({
			file: CHANGELOG_FILE,
			text: insertSection(existing, notes),
			how: 'new section added above the previous release; older entries untouched',
		});
	}

	const tracked = await git('ls-files', '--', ...MANIFESTS);
	for (const file of tracked.split('\n')) {
		if (!file || file.split('/').includes('node_modules')) {
			continue;
		}

		const text = await readFile(path.join(root, file), 'utf8');
		const bumped = bumpManifest(file, text, previous, version);
		if (bumped !== null) {
			changes.push({file, text: bumped, how: `version ${version}`});
		}
	}

	return {
		status: 'ready',
		root,
		version,
		tag,
		lastTag,
		bump: !previous
			? 'first'
			: semver.prerelease(version)
				? 'prerelease'
				: ((semver.diff(previous, version) as SemverBump | null) ?? 'patch'),
		notes,
		changes,
		subject: releaseSubject(
			(await git('log', '-30', '--no-merges', '--format=%s')).split('\n'),
			tag,
		),
		start: await git('rev-parse', 'HEAD'),
		warnings,
	};
}

/**
 * Writes the plan's changes, commits them with the release subject (and any
 * trailers) and makes the annotated tag. If anything fails before the tag
 * exists, the repository is reset to where it started and the error says so.
 */
export async function applyRelease(
	plan: ReadyPlan,
	options: {trailers?: string[]} = {},
): Promise<{commit: string}> {
	const git = async (...args: string[]) =>
		(await runGit(args, plan.root)).trim();
	try {
		for (const change of plan.changes) {
			await writeFile(path.join(plan.root, change.file), change.text);
		}

		await git('add', '--', ...plan.changes.map(change => change.file));
		await git(
			'commit',
			'--quiet',
			'-m',
			plan.subject,
			...(options.trailers ?? []).flatMap(trailer => ['--trailer', trailer]),
		);
		await git('tag', '-a', plan.tag, '-m', plan.tag);
	} catch (error) {
		await git('tag', '-d', plan.tag).catch(() => undefined);
		await git('reset', '--quiet', '--hard', plan.start).catch(() => undefined);
		throw new Error(
			`${gitMessage(error)}\nRolled back to ${plan.start.slice(0, 7)}; nothing was released.`,
		);
	}

	return {commit: await git('rev-parse', '--short', 'HEAD')};
}

/** Pushes HEAD and the release tag, by name, to origin. A failure keeps the local release. */
export async function pushRelease(plan: ReadyPlan): Promise<void> {
	try {
		await runGit(['push', '--quiet', 'origin', 'HEAD', plan.tag], plan.root);
	} catch (error) {
		throw new Error(
			`released ${plan.tag} locally, but the push failed; the release commit and tag are kept:\n${gitMessage(error)}`,
		);
	}
}

function gitMessage(error: unknown): string {
	const {stderr, message} = error as Error & {stderr?: string};
	return stderr?.trim() || message;
}

function stripTitle(markdown: string): string {
	return markdown.replace(/^# Changelog\s*\n/, '').trim();
}

/**
 * Puts `section` above the first release heading, below the title and any
 * Unreleased section. Everything after it is kept byte for byte.
 */
export function insertSection(changelog: string, section: string): string {
	const lines = changelog.split('\n');
	const index = lines.findIndex(
		line => line.startsWith('## ') && !/^## \[?unreleased\]?/i.test(line),
	);
	if (index === -1) {
		return `${changelog.trimEnd()}\n\n${section}\n`;
	}

	return [
		...lines.slice(0, index),
		...section.split('\n'),
		'',
		...lines.slice(index),
	].join('\n');
}

const JSON_VERSION = /("version"\s*:\s*")([^"]+)(")/;
const TOML_VERSION = /^(version\s*=\s*")([^"]+)(")/m;
// The lockfile repeats the root version under packages[""].
const LOCK_ROOT_VERSION =
	/("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]+)(")/;

/**
 * `text` with the manifest's own version set to `to`, or null when the file
 * doesn't carry `from` (or, for a first release with no `from`, already says
 * `to`). Works on the text, so formatting survives; only the first version
 * field (and the lockfile's root entry) changes, never a dependency's.
 */
export function bumpManifest(
	file: string,
	text: string,
	from: string | null,
	to: string,
): string | null {
	const pattern = file.endsWith('.json') ? JSON_VERSION : TOML_VERSION;
	const current = pattern.exec(text)?.[2];
	if (current === undefined || (from ? current !== from : current === to)) {
		return null;
	}

	let next = text.replace(pattern, `$1${to}$3`);
	if (file.endsWith('package-lock.json')) {
		next = next.replace(LOCK_ROOT_VERSION, `$1${to}$3`);
	}

	return next;
}

/**
 * The release commit's subject in the style of `recentSubjects`, worded so
 * chamoji leaves it out of later changelogs.
 */
export function releaseSubject(recentSubjects: string[], tag: string): string {
	const share = (pattern: RegExp) =>
		recentSubjects.filter(subject => pattern.test(subject)).length /
		Math.max(1, recentSubjects.length);
	const gitmoji = share(/^(?:\p{Extended_Pictographic}|:[a-z\d_+-]+:)/u);
	const conventional = share(/^[a-z]+(?:\([^)]*\))?!?: /);
	if (conventional > gitmoji && conventional >= 1 / 3) {
		return `chore(release): 🔖 ${tag}`;
	}

	return gitmoji >= 1 / 3 ? `🔖 Release ${tag}` : `Release ${tag}`;
}

/** The newest tag's prefix, so new tags match: `v`, or none. `v` with no tags. */
export function tagPrefix(newestFirst: string[]): 'v' | '' {
	const newest = newestFirst[0];
	return newest === undefined || newest.startsWith('v') ? 'v' : '';
}
