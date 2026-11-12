import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {readTextIfExists} from '../fs-read.js';
import {runGit} from '../git.js';
import type {ReleaseSettings, UnitSettings} from './settings.js';
import {isObject, type Obj} from '../util/object.js';

export type WorkspacePackage = {
	name: string;
	/** '/'-separated, relative to root. */
	path: string;
	version: string | null;
	private: boolean;
	/** Names in dependencies + peerDependencies. */
	runtimeDeps: string[];
	/** Dep name -> range as written, all dep kinds. */
	ranges: Record<string, string>;
};

export type ResolvedUnit = UnitSettings & {
	/** The package at unit.path, if any. */
	pkg: WorkspacePackage | null;
	/** Paths of internal packages used, transitively, sorted. */
	uses: string[];
};

const stringList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];

const isMissing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === 'ENOENT';

async function readJson(file: string): Promise<Obj | undefined> {
	const text = await readTextIfExists(file);
	if (text === null) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Can't parse ${file}: ${(error as Error).message}`);
	}

	if (!isObject(value)) throw new Error(`Can't use ${file}: not an object`);
	return value;
}

async function workspaceGlobs(root: string): Promise<string[]> {
	const file = path.join(root, 'pnpm-workspace.yaml');
	const text = await readTextIfExists(file);
	if (text !== null) {
		let yaml: unknown;
		try {
			yaml = parse(text);
		} catch (error) {
			throw new Error(`Can't parse ${file}: ${(error as Error).message}`);
		}

		if (isObject(yaml) && Array.isArray(yaml['packages'])) {
			return stringList(yaml['packages']);
		}
	}

	const manifest = await readJson(path.join(root, 'package.json'));
	const workspaces = manifest?.['workspaces'];
	if (Array.isArray(workspaces)) return stringList(workspaces);
	if (isObject(workspaces)) return stringList(workspaces['packages']);
	return [];
}

const clean = (glob: string): string =>
	glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const segmentsOf = (value: string): string[] =>
	value.split('/').filter(Boolean);

const segmentPattern = (segment: string): RegExp =>
	new RegExp(
		`^${segment
			.split('*')
			.map(part => part.replace(/[$()+.?[\\\]^{|}]/g, '\\$&'))
			.join('[^/]*')}$`,
	);

function matchSegments(glob: string[], parts: string[]): boolean {
	if (glob.length === 0) return parts.length === 0;
	const [head, ...rest] = glob as [string, ...string[]];
	if (head === '**') {
		for (let skip = 0; skip <= parts.length; skip++) {
			if (matchSegments(rest, parts.slice(skip))) return true;
		}

		return false;
	}

	const [first, ...others] = parts;
	if (first === undefined || !segmentPattern(head).test(first)) return false;
	return matchSegments(rest, others);
}

/** Does `glob` match `file` exactly? */
function matchesGlob(glob: string, file: string): boolean {
	return matchSegments(segmentsOf(clean(glob)), segmentsOf(file));
}

/** Does `glob` match `file` or any folder above it? */
function coversPath(glob: string, file: string): boolean {
	const parts = segmentsOf(file);
	for (let end = 1; end <= parts.length; end++) {
		if (matchSegments(segmentsOf(clean(glob)), parts.slice(0, end))) {
			return true;
		}
	}

	return false;
}

/** Folders pnpm never looks inside below a glob's fixed prefix. */
const IGNORED_SEGMENTS = new Set([
	'node_modules',
	'bower_components',
	'test',
	'tests',
]);

/** Does `parts` pass through an ignored folder below the glob's fixed prefix? */
function ignoredBy(glob: string[], parts: string[]): boolean {
	let fixed = 0;
	while (fixed < glob.length && !glob[fixed]!.includes('*')) fixed++;
	return parts.slice(fixed).some(part => IGNORED_SEGMENTS.has(part));
}

/** Could a folder at `parts` hold, or sit above, something `glob` matches? */
function canReach(glob: string[], parts: string[]): boolean {
	if (parts.length === 0 || glob.length === 0) return parts.length === 0;
	const [head, ...rest] = glob as [string, ...string[]];
	if (head === '**') return true;
	if (!segmentPattern(head).test(parts[0]!)) return false;
	return parts.length === 1 || canReach(rest, parts.slice(1));
}

async function findManifests(
	root: string,
	globs: string[][],
	dir = '',
): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(path.join(root, dir), {withFileTypes: true});
	} catch (error) {
		if (isMissing(error)) return [];
		throw new Error(
			`Can't read ${path.join(root, dir)}: ${(error as Error).message}`,
		);
	}

	const found: string[] = [];
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue;
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			const parts = segmentsOf(rel);
			if (globs.some(glob => canReach(glob, parts))) {
				found.push(...(await findManifests(root, globs, rel)));
			}
		} else if (entry.name === 'package.json' && dir) {
			found.push(dir);
		}
	}

	return found;
}

/** A unit's name is its folder's last segment: 'apps/e2e' -> 'e2e', 'tooling/*' -> 'tooling'. */
export const unitNameOf = (folder: string): string =>
	folder
		.replace(/\/\*+$/, '')
		.split('/')
		.filter(Boolean)
		.pop() ?? folder;

/** The package a manifest describes, or null without a name. */
export function readPackage(
	folder: string,
	manifest: Obj,
): WorkspacePackage | null {
	const {name} = manifest;
	if (typeof name !== 'string' || name === '') return null;

	const kinds = [
		'dependencies',
		'peerDependencies',
		'devDependencies',
		'optionalDependencies',
	];
	const ranges: Record<string, string> = {};
	for (const kind of kinds) {
		const deps = manifest[kind];
		if (!isObject(deps)) continue;
		for (const [dep, range] of Object.entries(deps)) {
			if (typeof range === 'string' && !(dep in ranges)) ranges[dep] = range;
		}
	}

	const runtime = new Set<string>();
	for (const kind of ['dependencies', 'peerDependencies']) {
		const deps = manifest[kind];
		if (isObject(deps)) for (const dep of Object.keys(deps)) runtime.add(dep);
	}

	return {
		name,
		path: folder,
		version:
			typeof manifest['version'] === 'string' ? manifest['version'] : null,
		private: manifest['private'] === true,
		runtimeDeps: [...runtime],
		ranges,
	};
}

/**
 * The root `package.json` as a package, or null when there is none or it has
 * no name. A file that can't be read or parsed throws.
 */
export async function readRootPackage(
	root: string,
): Promise<WorkspacePackage | null> {
	let text: string;
	try {
		text = await readFile(path.join(root, 'package.json'), 'utf8');
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}

	const parsed: unknown = JSON.parse(text);
	return typeof parsed === 'object' && parsed !== null
		? readPackage('', parsed as Obj)
		: null;
}

/**
 * Folders holding a package.json. In a git repo they come from git's file
 * list, so ignored build output never counts; otherwise the folders are walked.
 */
async function candidateFolders(
	root: string,
	globs: string[][],
): Promise<string[]> {
	if (existsSync(path.join(root, '.git'))) {
		const listed = await runGit(
			['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
			root,
		);
		const folders = new Set<string>();
		for (const file of listed.split('\0')) {
			if (file.endsWith('/package.json')) {
				folders.add(file.slice(0, -'/package.json'.length));
			}
		}

		return [...folders];
	}

	return findManifests(root, globs);
}

/**
 * The workspace packages of the repo at `root`, from pnpm-workspace.yaml or
 * package.json `workspaces`. `!` globs exclude; `node_modules` never matches.
 */
export async function readWorkspace(root: string): Promise<WorkspacePackage[]> {
	const globs = await workspaceGlobs(root);
	const include = globs.filter(glob => !glob.startsWith('!'));
	const negated = globs
		.filter(glob => glob.startsWith('!'))
		.map(glob => glob.slice(1));
	if (include.length === 0) return [];

	const globSegments = include.map(glob => segmentsOf(clean(glob)));
	const candidates = await candidateFolders(root, globSegments);
	const folders = candidates
		.filter(folder =>
			globSegments.some(
				glob =>
					matchSegments(glob, segmentsOf(folder)) &&
					!ignoredBy(glob, segmentsOf(folder)),
			),
		)
		.filter(folder => !negated.some(glob => matchesGlob(glob, folder)))
		.sort();

	const packages: WorkspacePackage[] = [];
	for (const folder of folders) {
		const manifest = await readJson(path.join(root, folder, 'package.json'));
		const pkg = manifest ? readPackage(folder, manifest) : null;
		if (pkg) packages.push(pkg);
	}

	return packages;
}

/** Does an `exclude` glob cover `file` or a folder above it? */
export const isExcluded = (file: string, exclude: string[]): boolean =>
	exclude.some(glob => coversPath(glob, file));

/** Does folder `dir` hold `file`, on a segment boundary? */
const holds = (dir: string, file: string): boolean =>
	file === dir || file.startsWith(`${dir}/`);

export function resolveUnits(
	settings: ReleaseSettings,
	packages: WorkspacePackage[],
): ResolvedUnit[] {
	const unitPaths = new Set(settings.units.map(unit => unit.path));
	const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
	const internal = (pkg: WorkspacePackage): boolean =>
		!unitPaths.has(pkg.path) && !isExcluded(pkg.path, settings.exclude);

	return settings.units.map(unit => {
		const pkg = packages.find(item => item.path === unit.path) ?? null;
		const uses = new Set<string>();
		const queue = pkg ? [...pkg.runtimeDeps] : [];
		while (queue.length > 0) {
			const dep = byName.get(queue.shift()!);
			if (!dep || !internal(dep) || uses.has(dep.path)) continue;
			uses.add(dep.path);
			queue.push(...dep.runtimeDeps);
		}

		return {...unit, pkg, uses: [...uses].sort()};
	});
}

/** The unit or internal package whose path holds `file`, or 'root', or 'excluded'. */
export function ownerOf(
	file: string,
	units: ResolvedUnit[],
	packages: WorkspacePackage[],
	exclude: string[],
):
	| {kind: 'unit'; unit: string}
	| {kind: 'internal'; path: string}
	| {kind: 'root'}
	| {kind: 'excluded'} {
	const unitPaths = new Set(units.map(unit => unit.path));
	type Candidate =
		| {depth: number; owner: {kind: 'unit'; unit: string}}
		| {depth: number; owner: {kind: 'internal'; path: string}};
	let best: Candidate | undefined;
	const consider = (candidate: Candidate) => {
		if (!best || candidate.depth > best.depth) best = candidate;
	};

	for (const unit of units) {
		if (holds(unit.path, file)) {
			consider({
				depth: segmentsOf(unit.path).length,
				owner: {kind: 'unit', unit: unit.name},
			});
		}
	}

	for (const pkg of packages) {
		if (
			holds(pkg.path, file) &&
			!unitPaths.has(pkg.path) &&
			!isExcluded(pkg.path, exclude)
		) {
			consider({
				depth: segmentsOf(pkg.path).length,
				owner: {kind: 'internal', path: pkg.path},
			});
		}
	}

	const found = best as Candidate | undefined;
	if (found?.owner.kind === 'unit') return found.owner;
	if (isExcluded(file, exclude)) return {kind: 'excluded'};
	return found ? found.owner : {kind: 'root'};
}
