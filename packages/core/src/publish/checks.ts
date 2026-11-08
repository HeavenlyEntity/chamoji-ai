import {exec} from 'node:child_process';
import {promisify} from 'node:util';
import semver from 'semver';
import {runGit} from '../git.js';
import {ReleaseError} from '../release.js';
import type {WorkspacePackage} from '../units/workspace.js';
import type {PackageKind} from './kind.js';
import {
	packPackage,
	readTarball,
	tarballProblems,
	type PackageManager,
} from './pack.js';

const execAsync = promisify(exec);

export type Manifest = Record<string, unknown>;

/** A package's registry, and what that registry has of it (null: nothing). */
export type Lookup = {
	registry: string;
	versions: {versions: string[]; latest: string | null} | null;
};

/** The dependency fields a published package is installed with. */
const INSTALLED = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

const fail = (message: string): never => {
	throw new ReleaseError('publish-check', message);
};

/** Environment keys that hold npm credentials, compared ignoring case. */
const CREDENTIAL_KEYS = [
	/^chamoji_npm_token$/i,
	/^npm_token$/i,
	/^node_auth_token$/i,
	/^npm_config_.*authtoken/i,
	/^npm_config__auth/i,
	// Registry-scoped settings (`//host/:_password` and the like).
	/^npm_config_.*\/\//i,
	/^npm_config_(?:_?auth|_?authtoken|_?password|username|certfile|keyfile)$/i,
	/^npm_config_(?:key|cert|otp)$/i,
	/^yarn_npm_auth_(?:token|ident)$/i,
	// The job's OIDC request: a repo script could mint tokens with it.
	/^actions_id_token_request_(?:url|token)$/i,
];

/**
 * The environment without npm credentials, for anything chamoji runs that
 * may run the repo's scripts (installs, packs, `publish.check`), and the
 * values it removed, to mask in their output.
 */
export function scrubEnv(source: Record<string, string | undefined>): {
	env: Record<string, string>;
	secrets: string[];
} {
	const env: Record<string, string> = {};
	const secrets: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (CREDENTIAL_KEYS.some(pattern => pattern.test(key))) {
			if (value) secrets.push(value);
		} else {
			env[key] = value;
		}
	}

	return {env, secrets};
}

/** `text` with every secret replaced by `***`, longest first. */
export function mask(text: string, secrets: readonly string[]): string {
	return [...secrets]
		.sort((a, b) => b.length - a.length)
		.reduce((masked, secret) => masked.replaceAll(secret, '***'), text);
}

/** The last lines of a command's output, trimmed. */
export function tail(text: string, lines = 20): string {
	return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

export async function checkClean(root: string): Promise<void> {
	const dirty = (await runGit(['status', '--porcelain'], root)).trim();
	if (dirty) {
		fail(
			`the working tree has uncommitted changes; commit them first:\n${dirty}`,
		);
	}
}

/** Why an app named for publishing is refused, and what to do about it. */
export function appRefusal(pkg: WorkspacePackage, kind: PackageKind): string {
	const what = kind.framework ? `a ${kind.framework} app` : 'an app';
	return `${pkg.path || '.'} looks like ${what} (${kind.reasons.join(', ')}), and apps aren't published. Mark it \`"private": true\`, or list it in \`release.publish.packages\` if it really is a package.`;
}

/** Packs `pkg` into `workdir` and refuses a tarball that would install broken. */
export async function packChecked(
	root: string,
	pkg: WorkspacePackage,
	pm: PackageManager,
	workdir: string,
	scrubbed: {env: Record<string, string>; secrets: string[]},
): Promise<{file: string; manifest: Manifest}> {
	const file = await packPackage(root, pkg, pm, workdir, scrubbed.env).catch(
		(error: unknown) => {
			const failed = error as {stderr?: string; message: string};
			return fail(
				mask(
					`${pkg.name}: ${pm} pack failed:\n${tail(failed.stderr || failed.message)}`,
					scrubbed.secrets,
				),
			);
		},
	);
	const facts = await readTarball(file);
	const problems = tarballProblems(facts);
	if (problems.length > 0) fail(`${pkg.name}: ${problems.join('; ')}`);
	return {file, manifest: facts.manifest};
}

/** Name -> range for every dependency the package is installed with. */
function installedDependencies(manifest: Manifest): Map<string, string> {
	const found = new Map<string, string>();
	for (const field of INSTALLED) {
		const deps = manifest[field];
		if (typeof deps !== 'object' || deps === null) continue;
		for (const [name, range] of Object.entries(deps as Manifest)) {
			if (typeof range === 'string' && !found.has(name)) found.set(name, range);
		}
	}

	return found;
}

/**
 * Refuses a dependency on a private workspace package, or, in a units repo,
 * on an internal one (a package no unit releases): npm would install it from
 * a version that isn't there.
 */
export function checkDependencies(
	pkg: WorkspacePackage,
	manifest: Manifest,
	all: WorkspacePackage[],
	unitPaths: ReadonlySet<string> | null,
): void {
	for (const name of installedDependencies(manifest).keys()) {
		const dep = all.find(other => other.name === name);
		if (!dep || dep === pkg) continue;
		if (dep.private) {
			fail(
				`${pkg.name}: depends on ${name}, which is private; make ${name} public, or drop the dependency`,
			);
		}

		if (unitPaths && !unitPaths.has(dep.path)) {
			fail(
				`${pkg.name}: depends on ${name}, an internal workspace package that isn't published; make it a unit, or drop the dependency`,
			);
		}
	}
}

/**
 * Every workspace package a tarball depends on must be published in this run
 * at a version its range accepts, or already be on npm at one.
 */
export async function checkDependenciesOnNpm(
	targets: Array<{name: string; version: string; published: boolean}>,
	packed: Map<string, Manifest>,
	all: WorkspacePackage[],
	lookup: (pkg: WorkspacePackage) => Promise<Lookup>,
): Promise<void> {
	for (const [name, manifest] of packed) {
		for (const [depName, range] of installedDependencies(manifest)) {
			const dep = all.find(other => other.name === depName);
			if (!dep || depName === name) continue;
			const valid = semver.validRange(range) !== null;
			const accepts = (version: string): boolean =>
				valid ? semver.satisfies(version, range) : version === dep.version;
			const inRun = targets.find(target => target.name === depName);
			if (inRun && accepts(inRun.version)) continue;
			// eslint-disable-next-line no-await-in-loop
			const {versions} = await lookup(dep);
			if (versions?.versions.some(version => accepts(version))) continue;
			fail(
				`${name}: depends on ${depName} ${range}, which isn't on npm and isn't published in this run`,
			);
		}
	}
}

/**
 * Runs `release.publish.check` at the root with the platform's shell (`sh -c`,
 * or `cmd /d /s /c` on Windows), in the scrubbed environment, so no npm
 * credential reaches it; any credential value in its output is masked.
 */
export async function runCheckCommand(
	root: string,
	command: string | null,
	scrubbed: {env: Record<string, string>; secrets: string[]},
): Promise<void> {
	if (!command) return;
	try {
		await execAsync(command, {
			cwd: root,
			env: scrubbed.env,
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		const failed = error as {code?: unknown; stdout?: string; stderr?: string};
		const output = tail(`${failed.stdout ?? ''}\n${failed.stderr ?? ''}`);
		const code =
			typeof failed.code === 'number' ? ` with exit code ${failed.code}` : '';
		const message = `publish.check \`${command}\` failed${code}${output ? `:\n${output}` : ''}`;
		fail(mask(message, scrubbed.secrets));
	}
}
