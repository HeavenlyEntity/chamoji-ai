import {access, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {WorkspacePackage} from '../units/workspace.js';
import {FRAMEWORKS} from './frameworks.js';

export type PackageKind = {kind: 'app' | 'library'; reasons: string[]};

type Obj = Record<string, unknown>;

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

const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
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
	const text = await readText(path.join(folder, 'app.json'));
	if (text === undefined) return false;
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) && value['expo'] !== undefined;
	} catch {
		return false;
	}
}

/**
 * Tells an app from a library by reading the package's own `package.json` and
 * its files. Strong library signals (`exports`, `module`, `types`, `bin`,
 * `files`, `publishConfig`, native module manifests) win. Then app signals: a
 * framework in `dependencies` or its config files, which a `main` field does
 * not undo. Then weaker library signals: a bare `main`, or a framework only in
 * peer or dev dependencies. With none of those, an `apps/` package, or a
 * private top-level one that nothing in `dependedOn` uses, is an app and the
 * rest are libraries.
 */
export async function classifyPackage(
	root: string,
	pkg: WorkspacePackage,
	dependedOn: ReadonlySet<string> = new Set(),
): Promise<PackageKind> {
	const folder = path.join(root, pkg.path);
	const manifest = await readManifest(path.join(folder, 'package.json'));
	const at = (file: string): string => path.join(folder, file);

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

	const nativeConfig = await readText(at('react-native.config.js'));
	if (nativeConfig?.includes('dependency')) {
		strong.push('`dependency` in `react-native.config.js`');
	}

	if (strong.length > 0) return {kind: 'library', reasons: strong};

	const dependencies = namesIn(manifest, 'dependencies');
	const anyDependency = new Set(
		DEPENDENCY_FIELDS.flatMap(field => [...namesIn(manifest, field)]),
	);

	const app: string[] = [];
	const weak: string[] = [];
	for (const framework of FRAMEWORKS) {
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
				if (await exists(at(file))) reasons.push(`\`${file}\``);
			}
		}

		if (reasons.length > 0 && hasFile) {
			if (needed) reasons.push(`\`${needed}\``);
			for (const reason of reasons) push(app, reason);
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

	if (anyDependency.has('electron') && isObject(manifest['build'])) {
		push(app, '`electron` with a `build` config');
	}

	if (await hasExpoConfig(folder)) push(app, '`app.json` with an `expo` key');

	if (anyDependency.has('react-native') || anyDependency.has('expo')) {
		if (entries.includes('ios') && entries.includes('android')) {
			push(app, '`ios/` and `android/` folders');
		}
	}

	for (const file of APP_FILES) {
		// eslint-disable-next-line no-await-in-loop
		if (await exists(at(file))) push(app, `\`${file}\``);
	}

	if (app.length > 0) return {kind: 'app', reasons: app};

	if (manifest['main'] !== undefined) push(weak, '`main` field');
	if (weak.length > 0) return {kind: 'library', reasons: weak};

	if (pkg.path.startsWith('apps/')) {
		return {kind: 'app', reasons: ['under `apps/`']};
	}

	if (!pkg.path.includes('/') && pkg.private && !dependedOn.has(pkg.name)) {
		return {
			kind: 'app',
			reasons: ['private top-level package that nothing depends on'],
		};
	}

	return {kind: 'library', reasons: ['no app signals found']};
}
