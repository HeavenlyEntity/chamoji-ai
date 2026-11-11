import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {listTags, runGit} from '../git.js';
import {readLockfiles} from '../publish/lockfile.js';
import {sdfFramework, type DetectedFramework} from '../publish/frameworks.js';
import {inspectPackage, sdfKind, type PackageKind} from '../publish/kind.js';
import {findSdfProjects, type SdfProject} from '../units/sdf.js';
import {escapeRegExp} from '../units/tags.js';
import {detectVersionFiles, readEasRemote} from '../units/version-files.js';
import {
	readWorkspace,
	unitNameOf,
	type WorkspacePackage,
} from '../units/workspace.js';

export type AppCandidate = {
	/** Short name: the folder's last segment. */
	name: string;
	path: string;
	/** Null for a NetSuite SDF project with no `package.json`. */
	pkg: WorkspacePackage | null;
	/** False for test/tool names. */
	ticked: boolean;
	kind: PackageKind;
	framework: DetectedFramework | null;
	sdf: SdfProject | null;
};

export type UnitFacts = {
	name: string;
	path: string;
	/** From its `package.json`, else its SDF `manifest.xml`. */
	version: string | null;
	kind: PackageKind;
	framework: DetectedFramework | null;
	sdf: SdfProject | null;
	/** Set when the `package.json` and the SDF `manifest.xml` hold different versions. */
	versionMismatch: {packageJson: string; manifest: string} | null;
	/** From detectVersionFiles, without its package.json. */
	versionFiles: string[];
	/**
	 * Other tracked files under the unit holding its manifest version as a
	 * whole token; offered, never ticked.
	 */
	otherVersionFiles: string[];
	/** appVersionSource: remote. */
	easRemote: boolean;
	/** An eas.json with appVersionSource: local. */
	easLocal: boolean;
};

export type LayoutDetection = {
	root: string;
	kind: 'single' | 'apps' | 'libraries' | 'mixed';
	packages: WorkspacePackage[];
	/** Every NetSuite SDF project in the repo, sorted by path. */
	sdf: SdfProject[];
	/** Empty unless kind is apps or mixed. */
	apps: AppCandidate[];
	/** Non-private packages that aren't apps, for libraries. */
	libraries: WorkspacePackage[];
	/** Unticked apps, plus tooling/* when it exists. */
	excluded: string[];
	/** The ticked apps, or the libraries. */
	units: UnitFacts[];
	/** Facts for every app and library, ticked or not, path-sorted; `units` is a subset. */
	candidates: UnitFacts[];
	/**
	 * Since the newest tag, max 200 commits. `since` is that tag, or null when
	 * there's none and the count covers the last 200 commits.
	 */
	rootOnly: {count: number; examples: string[]; since: string | null};
};

export const TOOL_NAMES: readonly string[] = [
	'e2e',
	'test',
	'tests',
	'playwright',
	'cypress',
	'storybook',
	'docs',
	'dev-tool',
];

export const MAX_COMMITS = 200;
const MAX_LISTED_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXAMPLES = 3;
const LOCKFILE =
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml|[^/]+\.lock)$/;

/** Does folder `dir` hold `file`, on a segment boundary? */
const holds = (dir: string, file: string): boolean =>
	file === dir || file.startsWith(`${dir}/`);

const isMissing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === 'ENOENT';

async function readEasLocal(root: string, unitPath: string): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(path.join(root, unitPath, 'eas.json'), 'utf8');
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}

	try {
		const value = JSON.parse(text) as {cli?: {appVersionSource?: unknown}};
		return value?.cli?.appVersionSource === 'local';
	} catch {
		return false;
	}
}

async function findOtherVersionFiles(
	root: string,
	unit: {path: string; version: string | null},
	known: string[],
): Promise<string[]> {
	if (unit.version === null || unit.path === '') return [];
	const listed = await runGit(['ls-files', '-z', '--', unit.path], root);
	const skip = new Set([...known, `${unit.path}/package.json`]);
	const token = new RegExp(
		`(?<![\\d.])${escapeRegExp(unit.version)}(?![\\d.])`,
	);
	const found: string[] = [];
	for (const file of listed
		.split('\0')
		.filter(Boolean)
		.slice(0, MAX_LISTED_FILES)) {
		if (skip.has(file) || file.split('/').pop() === 'CHANGELOG.md') continue;
		if (LOCKFILE.test(file)) continue;
		try {
			const full = path.join(root, ...file.split('/'));
			const info = await lstat(full);
			if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
			const buffer = await readFile(full);
			if (buffer.includes(0)) continue;
			if (token.test(buffer.toString('utf8'))) found.push(file);
		} catch {
			// Unreadable or removed since it was listed: not offered.
		}
	}

	return found;
}

type Candidate = Pick<AppCandidate, 'path' | 'kind' | 'framework' | 'sdf'> & {
	pkg: WorkspacePackage | null;
};

async function factsFor(
	root: string,
	unit: Candidate,
	all: SdfProject[],
): Promise<UnitFacts> {
	const {pkg, sdf} = unit;
	const detected = await detectVersionFiles(root, unit.path, {sdf: all});
	const versionFiles = detected.filter(
		file => file !== `${unit.path}/package.json`,
	);
	const version = pkg?.version ?? sdf?.version ?? null;
	return {
		name: unitNameOf(unit.path),
		path: unit.path,
		version,
		kind: unit.kind,
		framework: unit.framework,
		sdf,
		versionMismatch:
			pkg?.version && sdf?.version && pkg.version !== sdf.version
				? {packageJson: pkg.version, manifest: sdf.version}
				: null,
		versionFiles,
		otherVersionFiles: await findOtherVersionFiles(
			root,
			{path: unit.path, version},
			detected,
		),
		easRemote: await readEasRemote(root, unit.path),
		easLocal: await readEasLocal(root, unit.path),
	};
}

async function readRootOnly(
	root: string,
	packages: WorkspacePackage[],
): Promise<LayoutDetection['rootOnly']> {
	const none = {count: 0, examples: [], since: null};
	try {
		await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root);
	} catch {
		return none;
	}

	const newest = (await listTags(root, 'HEAD'))[0];
	const args = [
		'-c',
		'core.quotepath=off',
		'log',
		'--name-only',
		'--format=%x01',
		`--max-count=${MAX_COMMITS}`,
	];
	if (newest) args.push(`${newest.name}^{commit}..HEAD`);
	const stdout = await runGit(args, root);
	let count = 0;
	const examples = new Set<string>();
	for (const block of stdout.split('\u0001').slice(1)) {
		const files = block.split('\n').filter(Boolean);
		if (files.length === 0) continue;
		const outside = files.every(
			file => !packages.some(pkg => pkg.path !== '' && holds(pkg.path, file)),
		);
		if (!outside) continue;
		count++;
		for (const file of files) examples.add(file);
	}

	return {
		count,
		examples: [...examples].sort().slice(0, MAX_EXAMPLES),
		since: newest?.name ?? null,
	};
}

/** Works out a repo's apps, packages and version files from git and disk. */
export async function detectLayout(root: string): Promise<LayoutDetection> {
	const packages = (await readWorkspace(root)).filter(pkg => pkg.path !== '');
	const sdf = await findSdfProjects(root);
	const lockfiles = await readLockfiles(root);
	const dependedOn = new Set(packages.flatMap(pkg => pkg.runtimeDeps));
	const classified: Array<Candidate & {pkg: WorkspacePackage}> = [];
	for (const pkg of packages) {
		// eslint-disable-next-line no-await-in-loop
		const {kind, framework} = await inspectPackage(root, pkg, dependedOn, {
			sdf,
			lockfiles,
		});
		classified.push({
			path: pkg.path,
			pkg,
			kind,
			framework,
			sdf: sdf.find(project => project.path === pkg.path) ?? null,
		});
	}

	// SDF projects with no workspace package are app units of their own.
	const sdfOnly: Candidate[] = sdf
		.filter(
			project =>
				project.path !== '' && !packages.some(pkg => pkg.path === project.path),
		)
		.map(project => ({
			path: project.path,
			pkg: null,
			kind: sdfKind(project),
			framework: sdfFramework(project),
			sdf: project,
		}));

	const appUnits = [
		...classified.filter(unit => unit.kind.kind === 'app'),
		...sdfOnly,
	];
	const libraryUnits = classified.filter(
		unit => unit.kind.kind !== 'app' && !unit.pkg.private,
	);
	const libraries = libraryUnits.map(unit => unit.pkg);

	let kind: LayoutDetection['kind'];
	if (packages.length <= 1 && sdfOnly.length === 0) kind = 'single';
	else if (appUnits.length > 0 && libraries.length > 0) kind = 'mixed';
	else if (appUnits.length > 0) kind = 'apps';
	else if (libraries.length > 0) kind = 'libraries';
	else kind = 'single';

	const apps: AppCandidate[] =
		kind === 'apps' || kind === 'mixed'
			? appUnits.map(unit => {
					const name = unitNameOf(unit.path);
					return {...unit, name, ticked: !TOOL_NAMES.includes(name)};
				})
			: [];

	const excluded = apps.filter(app => !app.ticked).map(app => app.path);
	if (packages.some(pkg => pkg.path.startsWith('tooling/'))) {
		excluded.push('tooling/*');
	}

	excluded.sort();

	const unitPaths = new Set(
		kind === 'libraries'
			? libraries.map(pkg => pkg.path)
			: apps.filter(app => app.ticked).map(app => app.path),
	);
	const candidates: UnitFacts[] = [];
	const everyCandidate = [...apps, ...libraryUnits].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	for (const unit of everyCandidate) {
		// eslint-disable-next-line no-await-in-loop
		candidates.push(await factsFor(root, unit, sdf));
	}

	const units = candidates.filter(facts => unitPaths.has(facts.path));

	return {
		root,
		kind,
		packages,
		sdf,
		apps,
		libraries,
		excluded,
		units,
		candidates,
		rootOnly: await readRootOnly(root, packages),
	};
}
