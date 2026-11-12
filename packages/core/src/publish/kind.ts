import {access, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {readTextOrNull} from '../fs-read.js';
import {sdfProjectAt, type SdfProject} from '../units/sdf.js';
import type {WorkspacePackage} from '../units/workspace.js';
import {
	FRAMEWORKS,
	sdfFramework,
	type DetectedFramework,
	type Framework,
} from './frameworks.js';
import {
	displayVersion,
	installedVersion,
	installedVersionIn,
	type Lockfiles,
} from './lockfile.js';
import {isObject, type Obj} from '../util/object.js';

export type PackageKind = {
	kind: 'app' | 'library';
	reasons: string[];
	/** For an app, the framework it's built with, when one is known. */
	framework?: string;
	/** For an app built with a known framework, the whole match, with its version. */
	detected?: DetectedFramework;
};

/** Fields that give a package something to import or run, whatever it uses. */
const ENTRY_FIELDS = ['module', 'exports', 'bin', 'types'] as const;

/** Fields that show a package means to be published. */
const PUBLISH_FIELDS = ['files', 'publishConfig'] as const;

/** Manifests of native modules, which are libraries whatever they depend on. */
const NATIVE_MODULE_FILES = ['expo-module.config.json'] as const;

/** Files that only an app has. */
const APP_FILES = ['vercel.json'] as const;

const DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function readManifest(file: string): Promise<Obj> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		throw new Error(`Can't read ${file}: ${(error as Error).message}`);
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Can't parse ${file}: ${(error as Error).message}`);
	}

	if (!isObject(value)) throw new Error(`Can't use ${file}: not an object`);
	return value;
}

const namesIn = (manifest: Obj, field: string): Set<string> => {
	const value = manifest[field];
	return new Set(isObject(value) ? Object.keys(value) : []);
};

const push = (list: string[], reason: string): void => {
	if (!list.includes(reason)) list.push(reason);
};

/** Does the app.json hold an `expo` key? */
async function hasExpoConfig(folder: string): Promise<boolean> {
	const text = await readTextOrNull(path.join(folder, 'app.json'));
	if (text === null) return false;
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) && value['expo'] !== undefined;
	} catch {
		return false;
	}
}

type Matches = {
	/** Every framework row that matched, in table order. */
	matched: Framework[];
	/** Why the package counts as an app, one line per signal. */
	app: string[];
	/** Weaker signs: a framework only in peer or dev dependencies. */
	weak: string[];
};

/** How much of a config file `configMatch` reads, so a crafted file can't stall detection. */
const CONFIG_MATCH_LIMIT = 65_536;

/** Does the config file exist, and where the row asks for it, say what it should? */
async function configFileCounts(
	folder: string,
	framework: Framework,
	file: string,
): Promise<boolean> {
	const pattern = framework.configMatch?.[file];
	if (pattern === undefined) return exists(path.join(folder, file));
	const text = await readTextOrNull(path.join(folder, file));
	return (
		text !== null &&
		new RegExp(pattern, 'm').test(text.slice(0, CONFIG_MATCH_LIMIT))
	);
}

/** Runs the framework table against one package folder. */
async function matchFrameworks(
	folder: string,
	manifest: Obj,
): Promise<Matches> {
	const at = (file: string): string => path.join(folder, file);
	const dependencies = namesIn(manifest, 'dependencies');
	const anyDependency = new Set(
		DEPENDENCY_FIELDS.flatMap(field => [...namesIn(manifest, field)]),
	);

	const app: string[] = [];
	const weak: string[] = [];
	const matched: Framework[] = [];
	for (const framework of FRAMEWORKS) {
		if (framework.detectedBy) continue;
		const needed = framework.requires?.file;
		// eslint-disable-next-line no-await-in-loop
		const hasFile = needed ? await exists(at(needed)) : true;
		const reasons: string[] = [];
		for (const name of framework.packages) {
			if (dependencies.has(name)) {
				reasons.push(`\`${name}\` in dependencies`);
				continue;
			}

			// A file the framework needs counts it in from any dependency field.
			if (!needed || !hasFile) continue;
			for (const field of DEPENDENCY_FIELDS) {
				if (namesIn(manifest, field).has(name)) {
					reasons.push(`\`${name}\` in ${field}`);
					break;
				}
			}
		}

		const configPackage = framework.requires?.configPackage;
		if (!configPackage || anyDependency.has(configPackage)) {
			for (const file of framework.configFiles) {
				// eslint-disable-next-line no-await-in-loop
				if (await configFileCounts(folder, framework, file)) {
					reasons.push(`\`${file}\``);
				}
			}
		}

		if (reasons.length > 0 && hasFile) {
			if (needed) reasons.push(`\`${needed}\``);
			for (const reason of reasons) push(app, reason);
			matched.push(framework);
			continue;
		}

		if (reasons.length > 0) continue;
		for (const name of framework.packages) {
			if (dependencies.has(name)) continue;
			for (const field of ['peerDependencies', 'devDependencies']) {
				if (namesIn(manifest, field).has(name)) {
					push(weak, `\`${name}\` only in ${field}`);
				}
			}
		}
	}

	return {matched, app, weak};
}

/** The most specific framework: the first one no other match is built on. */
const mostSpecific = (matched: Framework[]): Framework | undefined =>
	matched.find(
		found => !matched.some(other => other.basedOn.includes(found.id)),
	);

/**
 * The framework with its version: what the lockfile says is installed, else
 * the manifest's range, for the first of the row's packages the package uses.
 */
async function describeFramework(
	root: string,
	pkgPath: string,
	manifest: Obj,
	framework: Framework,
	lockfiles?: Lockfiles,
): Promise<DetectedFramework> {
	const found = (field: string): string | undefined =>
		framework.packages.find(name => namesIn(manifest, field).has(name));
	const name =
		found('dependencies') ?? DEPENDENCY_FIELDS.map(found).find(Boolean);
	let version: string | null = null;
	if (name) {
		const locked = lockfiles
			? installedVersionIn(lockfiles, pkgPath, name)
			: await installedVersion(root, pkgPath, name);
		const ranges = DEPENDENCY_FIELDS.map(field => {
			const value = isObject(manifest[field])
				? manifest[field][name]
				: undefined;
			return typeof value === 'string' ? value : undefined;
		});
		version = displayVersion(locked ?? ranges.find(Boolean) ?? null);
	}

	return {
		id: framework.id,
		name: framework.name,
		version,
		basedOn: [...framework.basedOn],
	};
}

/**
 * Which framework a package is built with, and which version, read from its
 * `dependencies` and config files. Library signals don't matter here: this
 * reports what the package uses, not whether it's an app.
 */
export async function detectFramework(
	root: string,
	pkgPath: string,
): Promise<DetectedFramework | null> {
	const folder = path.join(root, pkgPath);
	const manifest = await readManifest(path.join(folder, 'package.json')).catch(
		(): Obj => ({}),
	);
	const {matched} = await matchFrameworks(folder, manifest);
	const best = mostSpecific(matched);
	return best ? describeFramework(root, pkgPath, manifest, best) : null;
}

/** An SDF project's kind: always an app, named for its project type. */
export function sdfKind(project: SdfProject): PackageKind {
	const detected = sdfFramework(project);
	return {
		kind: 'app',
		reasons: [`${detected.name} (\`${project.manifest}\`)`],
		framework: detected.name,
		detected,
	};
}

/**
 * Tells an app from a library by reading the package's own `package.json` and
 * its files. Strong library signals (`exports`, `module`, `types`, `bin`,
 * `files`, `publishConfig`, native module manifests) win. Then app signals: a
 * framework in `dependencies` or its config files, which a `main` field does
 * not undo. Then weaker library signals: a bare `main`, or a framework only in
 * peer or dev dependencies. With none of those, an `apps/` package, or a
 * private top-level one that nothing in `dependedOn` uses, is an app and the
 * rest are libraries. `options.sdf` holds the repo's SDF projects when the
 * caller has already found them; without it they're looked up.
 */
export async function classifyPackage(
	root: string,
	pkg: WorkspacePackage,
	dependedOn: ReadonlySet<string> = new Set(),
	options?: {sdf?: SdfProject[]},
): Promise<PackageKind> {
	return (await inspectPackage(root, pkg, dependedOn, options ?? {})).kind;
}

/** What detection has already read, so inspecting many packages reads it once. */
export type InspectContext = {
	/** The repo's SDF projects. */
	sdf?: SdfProject[];
	/** The repo's lockfiles. */
	lockfiles?: Lockfiles;
};

/**
 * `classifyPackage` and `detectFramework` in one pass: the package's kind and
 * its framework, from one read of its manifest and one run of the framework
 * table. The framework is what `detectFramework` gives, `kind.detected` when
 * the kind already holds it.
 */
export async function inspectPackage(
	root: string,
	pkg: WorkspacePackage,
	dependedOn: ReadonlySet<string>,
	context: InspectContext,
): Promise<{kind: PackageKind; framework: DetectedFramework | null}> {
	const folder = path.join(root, pkg.path);
	const manifest = await readManifest(path.join(folder, 'package.json'));
	const at = (file: string): string => path.join(folder, file);

	// A NetSuite SDF project is an app whatever else its package.json says:
	// nothing NetSuite is offered for npm.
	const sdf = await sdfProjectAt(root, pkg.path, {projects: context.sdf});
	if (sdf) {
		const kind = sdfKind(sdf);
		return {kind, framework: kind.detected ?? null};
	}

	const strong: string[] = [];
	for (const field of [...ENTRY_FIELDS, ...PUBLISH_FIELDS]) {
		if (manifest[field] !== undefined) strong.push(`\`${field}\` field`);
	}

	for (const file of NATIVE_MODULE_FILES) {
		// eslint-disable-next-line no-await-in-loop
		if (await exists(at(file))) strong.push(`\`${file}\``);
	}

	let entries: string[] = [];
	try {
		entries = await readdir(folder);
	} catch {
		// The manifest was readable, so this is not expected; treat as empty.
	}

	for (const entry of entries) {
		if (entry.endsWith('.podspec')) strong.push(`\`${entry}\``);
	}

	const nativeConfig = await readTextOrNull(at('react-native.config.js'));
	if (nativeConfig?.includes('dependency')) {
		strong.push('`dependency` in `react-native.config.js`');
	}

	if (strong.length > 0) {
		// Library signals win, but the framework is still reported.
		const best = mostSpecific(
			(await matchFrameworks(folder, manifest)).matched,
		);
		return {
			kind: {kind: 'library', reasons: strong},
			framework: best
				? await describeFramework(
						root,
						pkg.path,
						manifest,
						best,
						context.lockfiles,
					)
				: null,
		};
	}

	const anyDependency = new Set(
		DEPENDENCY_FIELDS.flatMap(field => [...namesIn(manifest, field)]),
	);

	const {matched, app, weak} = await matchFrameworks(folder, manifest);

	const best = mostSpecific(matched);
	let framework = best?.name;

	if (anyDependency.has('electron') && isObject(manifest['build'])) {
		push(app, '`electron` with a `build` config');
		framework ??= 'Electron';
	}

	if (await hasExpoConfig(folder)) {
		push(app, '`app.json` with an `expo` key');
		framework ??= 'Expo';
	}

	if (anyDependency.has('react-native') || anyDependency.has('expo')) {
		if (entries.includes('ios') && entries.includes('android')) {
			push(app, '`ios/` and `android/` folders');
			framework ??= anyDependency.has('expo') ? 'Expo' : 'React Native';
		}
	}

	for (const file of APP_FILES) {
		// eslint-disable-next-line no-await-in-loop
		if (await exists(at(file))) push(app, `\`${file}\``);
	}

	if (app.length > 0) {
		const detected = best
			? await describeFramework(
					root,
					pkg.path,
					manifest,
					best,
					context.lockfiles,
				)
			: undefined;
		return {
			kind: {
				kind: 'app',
				reasons: app,
				...(framework ? {framework} : {}),
				...(detected ? {detected} : {}),
			},
			framework: detected ?? null,
		};
	}

	// No framework matched from here on, so there's none to report.
	const plain = (kind: PackageKind) => ({kind, framework: null});
	if (manifest['main'] !== undefined) push(weak, '`main` field');
	if (weak.length > 0) return plain({kind: 'library', reasons: weak});

	if (pkg.path.startsWith('apps/')) {
		return plain({kind: 'app', reasons: ['under `apps/`']});
	}

	if (!pkg.path.includes('/') && pkg.private && !dependedOn.has(pkg.name)) {
		return plain({
			kind: 'app',
			reasons: ['private top-level package that nothing depends on'],
		});
	}

	return plain({kind: 'library', reasons: ['no app signals found']});
}
