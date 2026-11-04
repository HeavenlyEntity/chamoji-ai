import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import type {ReleaseSettings, UnitSettings} from './settings.js';

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

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];

async function readJson(file: string): Promise<Obj | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(file, 'utf8'));
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function workspaceGlobs(root: string): Promise<string[]> {
	try {
		const yaml: unknown = parse(
			await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
		);
		if (isObject(yaml) && Array.isArray(yaml['packages'])) {
			return stringList(yaml['packages']);
		}
	} catch {
		// No pnpm workspace file; fall back to package.json.
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

async function findManifests(root: string, dir = ''): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(path.join(root, dir), {withFileTypes: true});
	} catch {
		return [];
	}

	const found: string[] = [];
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue;
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			found.push(...(await findManifests(root, rel)));
		} else if (entry.name === 'package.json' && dir) {
			found.push(dir);
		}
	}

	return found;
}

function readPackage(folder: string, manifest: Obj): WorkspacePackage | null {
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

	const folders = (await findManifests(root))
		.filter(folder => include.some(glob => matchesGlob(glob, folder)))
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

const isExcluded = (file: string, exclude: string[]): boolean =>
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
