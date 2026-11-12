import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {access, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import type {WorkspacePackage} from '../units/workspace.js';
import {isObject} from '../util/object.js';

const execFileAsync = promisify(execFile);

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export type TarballFacts = {
	manifest: Record<string, unknown>;
	files: string[];
};

const MANAGERS: readonly PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];

/** Lockfiles in the order they're tried; npm is the fallback. */
const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm'],
];

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

/** The root's `packageManager` field, then its lockfile, then npm. */
export async function detectPackageManager(
	root: string,
): Promise<PackageManager> {
	try {
		const manifest: unknown = JSON.parse(
			await readFile(path.join(root, 'package.json'), 'utf8'),
		);
		if (isObject(manifest) && typeof manifest.packageManager === 'string') {
			const name = manifest.packageManager.split('@')[0];
			const found = MANAGERS.find(manager => manager === name);
			if (found) return found;
		}
	} catch {
		// No readable manifest; the lockfile may still say.
	}

	for (const [file, manager] of LOCKFILES) {
		// eslint-disable-next-line no-await-in-loop -- first match wins, in order
		if (await exists(path.join(root, file))) return manager;
	}

	return 'npm';
}

/** The command that writes one package's tarball into `outDir`. */
export function packArgs(
	pm: PackageManager,
	outDir: string,
): {command: string; args: string[]} {
	switch (pm) {
		case 'pnpm':
			return {command: 'pnpm', args: ['pack', '--pack-destination', outDir]};
		case 'yarn':
			// Berry; %s and %v are the package name and version.
			return {
				command: 'yarn',
				args: ['pack', '--out', path.join(outDir, '%s-%v.tgz')],
			};
		case 'bun':
			return {command: 'bun', args: ['pm', 'pack', '--destination', outDir]};
		case 'npm':
			return {command: 'npm', args: ['pack', '--pack-destination', outDir]};
	}
}

/** The yarn output template; its `%` is yarn's, not cmd's. */
const YARN_TEMPLATE = '%s-%v.tgz';

const CMD_METACHARACTERS = /[%"&|<>^!]/;

/**
 * What to spawn for `command` on `platform`. On Windows the managers are
 * `.cmd` shims or `.exe` files that only cmd resolves (through PATHEXT), so
 * cmd.exe runs them; any argument cmd would read as syntax is refused.
 */
export function spawnSpec(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): {file: string; args: string[]} {
	if (platform !== 'win32') return {file: command, args};
	for (const arg of args) {
		if (CMD_METACHARACTERS.test(arg.replaceAll(YARN_TEMPLATE, ''))) {
			throw new Error(
				`Can't pass ${arg} to ${command} on Windows: it has a character cmd.exe treats as syntax (% " & | < > ^ !)`,
			);
		}
	}

	return {file: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args]};
}

/**
 * The tar to read tarballs with. Git's GNU tar can come first on a Windows
 * PATH and mishandles `C:` paths, so Windows' own bsdtar is preferred.
 */
export function tarCommand(
	platform: NodeJS.Platform = process.platform,
	fileExists: (file: string) => boolean = existsSync,
	systemRoot: string | undefined = process.env.SystemRoot,
): string {
	if (platform !== 'win32') return 'tar';
	const system = path.win32.join(
		systemRoot ?? 'C:\\Windows',
		'System32',
		'tar.exe',
	);
	return fileExists(system) ? system : 'tar';
}

async function tgzIn(dir: string): Promise<Set<string>> {
	return new Set((await readdir(dir)).filter(file => file.endsWith('.tgz')));
}

/**
 * Packs `pkg` with the package manager that owns the workspace, so `workspace:`
 * and `catalog:` ranges are rewritten the way that tool rewrites them, and
 * returns the tarball's absolute path. `prepack` runs as usual, with `env`
 * when given, else the process environment.
 */
export async function packPackage(
	root: string,
	pkg: WorkspacePackage,
	pm: PackageManager,
	outDir: string,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const absOut = path.resolve(outDir);
	const cwd = path.join(root, ...pkg.path.split('/').filter(Boolean));
	const before = await tgzIn(absOut);
	const {command, args} = packArgs(pm, absOut);
	const run = spawnSpec(command, args);
	const {stdout} = await execFileAsync(run.file, run.args, {
		cwd,
		...(env ? {env} : {}),
		maxBuffer: 64 * 1024 * 1024,
	});

	// Tools name the file differently (scopes, versions), so go by what's new,
	// and by the printed path when the file replaced an older one.
	const fresh = [...(await tgzIn(absOut))].filter(file => !before.has(file));
	if (fresh.length === 1) return path.join(absOut, fresh[0]!);
	const printed = stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.reverse()
		.find(line => line.endsWith('.tgz'));
	if (printed) {
		const file = path.resolve(cwd, printed);
		if (await exists(file)) return file;
	}

	throw new Error(`${command} pack made no tarball for ${pkg.name}`);
}

/** Lists a tarball and reads its manifest with the system `tar`. */
export async function readTarball(tgz: string): Promise<TarballFacts> {
	const tar = tarCommand();
	const options = {maxBuffer: 64 * 1024 * 1024};
	const [list, manifest] = await Promise.all([
		execFileAsync(tar, ['-tzf', tgz], options),
		execFileAsync(tar, ['-xzOf', tgz, 'package/package.json'], options),
	]);
	const parsed: unknown = JSON.parse(manifest.stdout);
	return {
		manifest: isObject(parsed) ? parsed : {},
		files: list.stdout.split(/\r?\n/).filter(Boolean),
	};
}

const DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

const normalise = (file: string): string => file.replace(/^\.\//, '');

/** Every string target in an `exports` value, conditions flattened. */
function exportTargets(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(exportTargets);
	if (isObject(value)) return Object.values(value).flatMap(exportTargets);
	return [];
}

/** What would be wrong to publish, as messages; empty when the tarball is fine. */
export function tarballProblems(facts: TarballFacts): string[] {
	const {manifest} = facts;
	const problems: string[] = [];
	for (const field of DEPENDENCY_FIELDS) {
		const deps = manifest[field];
		if (!isObject(deps)) continue;
		for (const [name, range] of Object.entries(deps)) {
			if (
				typeof range === 'string' &&
				(range.startsWith('workspace:') || range.startsWith('catalog:'))
			) {
				problems.push(
					`${field}.${name} is still "${range}"; the package manager didn't rewrite it`,
				);
			}
		}
	}

	const files = new Set(facts.files);
	const has = (file: string): boolean => files.has(`package/${file}`);

	const entries: Array<[string, string]> = [];
	for (const field of ['module', 'types'] as const) {
		const value = manifest[field];
		if (typeof value === 'string') entries.push([field, value]);
	}

	const {bin} = manifest;
	if (typeof bin === 'string') entries.push(['bin', bin]);
	else if (isObject(bin)) {
		for (const [name, value] of Object.entries(bin)) {
			if (typeof value === 'string') entries.push([`bin.${name}`, value]);
		}
	}

	for (const target of exportTargets(manifest.exports)) {
		if (!target.startsWith('./')) {
			problems.push(`exports target ${target} doesn't start with ./`);
		} else if (target.includes('*')) {
			// A pattern needs some file between its prefix and suffix.
			const star = target.indexOf('*');
			const prefix = `package/${target.slice(2, star)}`;
			const suffix = target.slice(star + 1);
			const found = facts.files.some(
				file =>
					file.length >= prefix.length + suffix.length &&
					file.startsWith(prefix) &&
					file.endsWith(suffix),
			);
			if (!found) {
				problems.push(
					`exports target ${target} matches nothing in the tarball`,
				);
			}
		} else {
			entries.push(['exports', target]);
		}
	}

	for (const [field, value] of entries) {
		const file = normalise(value);
		if (!has(file))
			problems.push(`${field} points at ${file}, not in the tarball`);
	}

	// `main` may leave off the extension or name a folder with an index.
	if (typeof manifest.main === 'string') {
		const main = normalise(manifest.main).replace(/\/$/, '');
		const found =
			has(main) ||
			has(`${main}.js`) ||
			has(`${main}/index.js`) ||
			facts.files.some(file => file.startsWith(`package/${main}/`));
		if (!found) problems.push(`main points at ${main}, not in the tarball`);
	}

	return problems;
}
