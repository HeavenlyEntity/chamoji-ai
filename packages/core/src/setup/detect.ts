import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {listTags, runGit} from '../git.js';
import {detectVersionFiles, readEasRemote} from '../units/version-files.js';
import {readWorkspace, type WorkspacePackage} from '../units/workspace.js';

export type AppCandidate = {
	/** Short name: the folder's last segment. */
	name: string;
	path: string;
	pkg: WorkspacePackage;
	/** False for test/tool names. */
	ticked: boolean;
};

export type UnitFacts = {
	name: string;
	path: string;
	/** From its manifest. */
	version: string | null;
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
	/** Empty unless kind is apps or mixed. */
	apps: AppCandidate[];
	/** Non-private packages that aren't apps, for libraries. */
	libraries: WorkspacePackage[];
	/** Unticked apps, plus tooling/* when it exists. */
	excluded: string[];
	/** The ticked apps, or the libraries. */
	units: UnitFacts[];
	/** Since the newest tag, max 200 commits. */
	rootOnly: {count: number; examples: string[]};
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

const MAX_COMMITS = 200;
const MAX_LISTED_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXAMPLES = 3;
const LOCKFILE =
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml|[^/]+\.lock)$/;

const lastSegment = (folder: string): string =>
	folder.split('/').filter(Boolean).pop() ?? folder;

/** Does folder `dir` hold `file`, on a segment boundary? */
const holds = (dir: string, file: string): boolean =>
	file === dir || file.startsWith(`${dir}/`);

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
	unit: WorkspacePackage,
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

async function factsFor(
	root: string,
	pkg: WorkspacePackage,
): Promise<UnitFacts> {
	const detected = await detectVersionFiles(root, pkg.path);
	const versionFiles = detected.filter(
		file => file !== `${pkg.path}/package.json`,
	);
	return {
		name: lastSegment(pkg.path),
		path: pkg.path,
		version: pkg.version,
		versionFiles,
		otherVersionFiles: await findOtherVersionFiles(root, pkg, detected),
		easRemote: await readEasRemote(root, pkg.path),
		easLocal: await readEasLocal(root, pkg.path),
	};
}

async function readRootOnly(
	root: string,
	packages: WorkspacePackage[],
): Promise<LayoutDetection['rootOnly']> {
	const none = {count: 0, examples: []};
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

	return {count, examples: [...examples].sort().slice(0, MAX_EXAMPLES)};
}

/** Works out a repo's apps, packages and version files from git and disk. */
export async function detectLayout(root: string): Promise<LayoutDetection> {
	const packages = (await readWorkspace(root)).filter(pkg => pkg.path !== '');
	const dependedOn = new Set(packages.flatMap(pkg => pkg.runtimeDeps));
	const isApp = (pkg: WorkspacePackage): boolean =>
		pkg.path.startsWith('apps/') ||
		(!pkg.path.includes('/') && pkg.private && !dependedOn.has(pkg.name));

	const appPackages = packages.filter(isApp);
	const libraries = packages.filter(pkg => !isApp(pkg) && !pkg.private);

	let kind: LayoutDetection['kind'];
	if (packages.length <= 1) kind = 'single';
	else if (appPackages.length > 0 && libraries.length > 0) kind = 'mixed';
	else if (appPackages.length > 0) kind = 'apps';
	else if (libraries.length > 0) kind = 'libraries';
	else kind = 'single';

	const apps: AppCandidate[] =
		kind === 'apps' || kind === 'mixed'
			? appPackages.map(pkg => {
					const name = lastSegment(pkg.path);
					return {
						name,
						path: pkg.path,
						pkg,
						ticked: !TOOL_NAMES.includes(name),
					};
				})
			: [];

	const excluded = apps.filter(app => !app.ticked).map(app => app.path);
	if (packages.some(pkg => pkg.path.startsWith('tooling/'))) {
		excluded.push('tooling/*');
	}

	excluded.sort();

	const unitPackages =
		kind === 'libraries'
			? libraries
			: apps.filter(app => app.ticked).map(app => app.pkg);
	const units: UnitFacts[] = [];
	for (const pkg of unitPackages) units.push(await factsFor(root, pkg));

	return {
		root,
		kind,
		packages,
		apps,
		libraries,
		excluded,
		units,
		rootOnly: await readRootOnly(root, packages),
	};
}
