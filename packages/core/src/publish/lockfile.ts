import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {readTextOrNull} from '../fs-read.js';

/** The importer key pnpm uses for a package folder: `.` for the root. */
const importerKey = (pkgPath: string): string => {
	const clean = pkgPath.replaceAll('\\', '/').replace(/^\.\//, '');
	return clean === '' || clean === '.' ? '.' : clean.replace(/\/$/, '');
};

const unquote = (text: string): string => text.replace(/^(['"])(.*)\1$/, '$2');

/** A pnpm version value without its quotes or peer-dependency suffix. */
const cleanPnpmVersion = (value: string): string | null => {
	const bare = unquote(value.trim()).replace(/\(.*$/, '').replace(/_.*$/, '');
	return /^\d/.test(bare) ? bare : null;
};

/**
 * Reads `importers.<pkgPath>` from a pnpm lockfile, for the v5 shape
 * (`next: 15.2.3`) and the v6+ one (`next:` with a `version:` line below).
 */
function pnpmVersion(
	text: string,
	pkgPath: string,
	dependency: string,
): string | null {
	const wanted = importerKey(pkgPath);
	const lines = text.split(/\r?\n/);
	let inImporters = false;
	let inImporter = false;
	let inDependency = false;
	for (const line of lines) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;
		const body = line.trim();
		if (indent === 0) {
			inImporters = body === 'importers:';
			inImporter = false;
			inDependency = false;
			continue;
		}

		if (!inImporters) continue;
		if (indent === 2) {
			inImporter = unquote(body.replace(/:$/, '')) === wanted;
			inDependency = false;
			continue;
		}

		if (!inImporter) continue;
		// Dependency names sit at indent 6; their fields at 8.
		if (indent === 6) {
			const match = /^(['"]?)(.+?)\1:\s*(.*)$/.exec(body);
			inDependency = match?.[2] === dependency;
			if (inDependency && match?.[3]) return cleanPnpmVersion(match[3]);
			continue;
		}

		if (indent === 8 && inDependency && body.startsWith('version:')) {
			return cleanPnpmVersion(body.slice('version:'.length));
		}
	}

	return null;
}

function npmVersion(
	text: string,
	pkgPath: string,
	dependency: string,
): string | null {
	let lock: unknown;
	try {
		lock = JSON.parse(text);
	} catch {
		return null;
	}

	const packages =
		typeof lock === 'object' && lock !== null
			? (lock as {packages?: unknown}).packages
			: undefined;
	if (typeof packages !== 'object' || packages === null) return null;
	const table = packages as Record<string, {version?: unknown} | undefined>;
	const key = importerKey(pkgPath);
	const candidates = [
		...(key === '.' ? [] : [`${key}/node_modules/${dependency}`]),
		`node_modules/${dependency}`,
	];
	for (const candidate of candidates) {
		const version = table[candidate]?.version;
		if (typeof version === 'string' && /^\d/.test(version)) return version;
	}

	return null;
}

/** The pnpm major `pnpm-lock.yaml`'s `lockfileVersion` was written by. */
const PNPM_BY_LOCKFILE: Array<[RegExp, number]> = [
	[/^9\./, 10],
	[/^6\./, 8],
	[/^5\./, 7],
];

/**
 * The pnpm major `pnpm/action-setup` needs as `version`, or null when the
 * root `package.json` has a `packageManager` field, which the action reads.
 * Otherwise it comes from `pnpm-lock.yaml`'s `lockfileVersion`: 9.x is 10,
 * 6.x is 8, 5.x is 7, and anything else, or no lockfile, is 10.
 */
export async function pnpmSetupVersion(root: string): Promise<number | null> {
	try {
		const manifest = JSON.parse(
			await readFile(path.join(root, 'package.json'), 'utf8'),
		) as {packageManager?: unknown} | null;
		if (
			typeof manifest === 'object' &&
			manifest !== null &&
			!Array.isArray(manifest) &&
			typeof manifest.packageManager === 'string' &&
			manifest.packageManager !== ''
		) {
			return null;
		}
	} catch {
		// No readable manifest: the lockfile still says.
	}

	try {
		const head = (await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'))
			.split('\n', 20)
			.find(line => line.startsWith('lockfileVersion:'));
		const found = /^lockfileVersion:\s*['"]?([0-9][0-9.]*)/.exec(head ?? '');
		if (found) {
			for (const [pattern, major] of PNPM_BY_LOCKFILE) {
				if (pattern.test(found[1]!)) return major;
			}
		}
	} catch {
		// No lockfile.
	}

	return 10;
}

/** The text of the lockfiles chamoji reads, each when the repo has it. */
export type Lockfiles = {pnpm?: string; npm?: string};

/** Reads `pnpm-lock.yaml` and `package-lock.json` once, for `installedVersionIn`. */
export async function readLockfiles(root: string): Promise<Lockfiles> {
	const pnpm = await readTextOrNull(path.join(root, 'pnpm-lock.yaml'));
	const npm = await readTextOrNull(path.join(root, 'package-lock.json'));
	return {
		...(pnpm === null ? {} : {pnpm}),
		...(npm === null ? {} : {npm}),
	};
}

/**
 * The version of `dependency` that the lockfiles say is installed for the
 * package at `pkgPath`: from the pnpm lockfile, else the npm one. Null when
 * there's no answer.
 */
export function installedVersionIn(
	lockfiles: Lockfiles,
	pkgPath: string,
	dependency: string,
): string | null {
	if (lockfiles.pnpm !== undefined) {
		const found = pnpmVersion(lockfiles.pnpm, pkgPath, dependency);
		if (found) return found;
	}

	if (lockfiles.npm !== undefined) {
		return npmVersion(lockfiles.npm, pkgPath, dependency);
	}

	return null;
}

/**
 * The version of `dependency` that the repo's lockfile says is installed for
 * the package at `pkgPath`: from `pnpm-lock.yaml`, else `package-lock.json`.
 * `yarn.lock` and `bun.lock` aren't read. Null when there's no answer.
 */
export async function installedVersion(
	root: string,
	pkgPath: string,
	dependency: string,
): Promise<string | null> {
	return installedVersionIn(await readLockfiles(root), pkgPath, dependency);
}

/**
 * A version as shown to people: major.minor, with a `.0` minor dropped, and
 * any range operator removed. A value with no digits, or that points at the
 * workspace or a file, has no version.
 */
export function displayVersion(raw: string | null): string | null {
	if (raw === null) return null;
	const text = raw.trim();
	if (/^(workspace|link|file|portal|git|github|https?):/.test(text))
		return null;
	const match = /(\d+)(?:\.(\d+))?/.exec(text);
	if (!match) return null;
	const [, major, minor] = match;
	return minor && minor !== '0' ? `${major}.${minor}` : (major ?? null);
}
