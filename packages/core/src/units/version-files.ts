import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {ReleaseError} from '../release.js';
import type {ResolvedUnit} from './workspace.js';

export type VersionFileEdit = {
	/** Repo-relative, '/'-separated. */
	file: string;
	/** The whole file, with the version set. */
	text: string;
	/** The version the file carried, or null when it carried none. */
	from: string | null;
};

type Prop = {key: string; start: number; end: number};
type Edited = {text: string; from: string};
type Settings = {to: string; current: string | null; increment: boolean};

const isMissing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === 'ENOENT';

const joinPath = (...parts: string[]): string =>
	path.posix.join(...parts.filter(part => part !== '' && part !== '.'));

/** True when `<unitPath>/eas.json` has `cli.appVersionSource` set to "remote". */
export async function readEasRemote(
	root: string,
	unitPath: string,
): Promise<boolean> {
	const file = joinPath(unitPath, 'eas.json');
	let text: string;
	try {
		text = await readFile(path.join(root, file), 'utf8');
	} catch (error) {
		if (isMissing(error)) return false;
		throw new Error(`Can't read ${file}: ${(error as Error).message}`);
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Can't parse ${file}: ${(error as Error).message}`);
	}

	const cli = (value as {cli?: {appVersionSource?: unknown}} | null)?.cli;
	return cli?.appVersionSource === 'remote';
}

// A small scanner for object literals, enough for JSON and for the config
// objects JS/TS files export: it knows strings, comments and nesting, so a
// `version` inside a plugin's options or a nested object is never mistaken
// for the top-level one.

function skipTrivia(text: string, from: number): number {
	let i = from;
	for (;;) {
		const ch = text[i];
		if (ch !== undefined && /\s/.test(ch)) {
			i++;
		} else if (text.startsWith('//', i)) {
			const end = text.indexOf('\n', i);
			i = end === -1 ? text.length : end + 1;
		} else if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			return i;
		}
	}
}

/** Index just past the string that starts at `from`. */
function skipString(text: string, from: number): number {
	const quote = text[from];
	let i = from + 1;
	while (i < text.length && text[i] !== quote) {
		i += text[i] === '\\' ? 2 : 1;
	}

	return i + 1;
}

/** The end of the value starting at `from`: a `,` or closer at depth 0. */
function skipValue(text: string, from: number): number {
	let depth = 0;
	let i = from;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"' || ch === "'" || ch === '`') {
			i = skipString(text, i);
			continue;
		}

		if (text.startsWith('//', i) || text.startsWith('/*', i)) {
			i = skipTrivia(text, i);
			continue;
		}

		if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch)) {
			if (depth === 0) return i;
			depth--;
		} else if (ch === ',' && depth === 0) return i;
		i++;
	}

	return i;
}

/** The properties of the object whose `{` is at `open`, with value ranges. */
function props(text: string, open: number): Prop[] {
	const found: Prop[] = [];
	let i = open + 1;
	while (i < text.length) {
		i = skipTrivia(text, i);
		const ch = text[i];
		if (ch === undefined || ch === '}') break;
		if (ch === ',') {
			i++;
			continue;
		}

		const before = i;
		let key: string | undefined;
		if (ch === '"' || ch === "'") {
			const end = skipString(text, i);
			key = text.slice(i + 1, end - 1);
			i = end;
		} else {
			const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 200));
			if (ident) {
				key = ident[0];
				i += key.length;
			}
		}

		const colon = skipTrivia(text, i);
		if (key !== undefined && text[colon] === ':') {
			const start = skipTrivia(text, colon + 1);
			const end = skipValue(text, start);
			found.push({
				key,
				start,
				end: start + text.slice(start, end).trimEnd().length,
			});
			i = end;
		} else {
			i = skipValue(text, before);
		}

		if (i === before) i++;
	}

	return found;
}

/** `{` of the object a JS/TS config file exports, or -1. */
function exportedObject(text: string): number {
	const exported = String.raw`(?:export\s+default|module\.exports\s*=)`;
	const direct = new RegExp(String.raw`${exported}\s*\(?\s*\{`).exec(text);
	if (direct) return direct.index + direct[0].length - 1;
	const arrow = new RegExp(
		String.raw`${exported}\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\(\s*\{`,
	).exec(text);
	if (arrow) return arrow.index + arrow[0].length - 1;
	const named = new RegExp(String.raw`${exported}\s*(\w+)\s*;?`).exec(text);
	if (named) {
		const declared = new RegExp(
			String.raw`(?:const|let|var)\s+${named[1]!}\b[^=\n]*=\s*\{`,
		).exec(text);
		if (declared) return declared.index + declared[0].length - 1;
	}

	return -1;
}

/** `{` of the object that holds `version`, `ios` and `android`. */
function configRoot(text: string, json: boolean): number {
	const top = json ? text.indexOf('{') : exportedObject(text);
	if (top === -1) return -1;
	const expo = props(text, top).find(prop => prop.key === 'expo');
	return expo && text[expo.start] === '{' ? expo.start : top;
}

function configProp(
	text: string,
	json: boolean,
	keys: string[],
): Prop | undefined {
	let open = configRoot(text, json);
	let found: Prop | undefined;
	for (const key of keys) {
		if (open === -1) return undefined;
		found = props(text, open).find(prop => prop.key === key);
		if (!found) return undefined;
		open = text[found.start] === '{' ? found.start : -1;
	}

	return found;
}

function replace(text: string, from: number, to: number, value: string) {
	return text.slice(0, from) + value + text.slice(to);
}

/** The literal's quote and content when it is a plain string. */
function stringLiteral(text: string, prop: Prop) {
	const match = /^(["'`])([^\\]*?)\1$/s.exec(text.slice(prop.start, prop.end));
	return match ? {quote: match[1]!, value: match[2]!} : undefined;
}

const bump = (value: string): string | undefined =>
	/^\d+$/.test(value) ? String(Number(value) + 1) : undefined;

/** Build numbers in an Expo config, raised by one where they're plain. */
function incrementExpo(text: string, json: boolean): string {
	let next = text;
	for (const keys of [
		['ios', 'buildNumber'],
		['android', 'versionCode'],
	]) {
		const prop = configProp(next, json, keys);
		if (!prop) continue;
		const literal = stringLiteral(next, prop);
		const raw = literal ? literal.value : next.slice(prop.start, prop.end);
		const raised = bump(raw);
		if (raised === undefined) continue;
		next = replace(
			next,
			prop.start,
			prop.end,
			literal ? `${literal.quote}${raised}${literal.quote}` : raised,
		);
	}

	return next;
}

function setExpo(text: string, json: boolean, settings: Settings) {
	const prop = configProp(text, json, ['version']);
	const literal = prop && stringLiteral(text, prop);
	if (!prop || !literal) return undefined;
	let next = replace(text, prop.start + 1, prop.end - 1, settings.to);
	if (settings.increment) next = incrementExpo(next, json);
	return {text: next, from: literal.value};
}

function setPackageJson(text: string, settings: Settings) {
	const top = text.indexOf('{');
	const prop =
		top === -1 ? undefined : props(text, top).find(p => p.key === 'version');
	const literal = prop && stringLiteral(text, prop);
	if (!prop || !literal) return undefined;
	return {
		text: replace(text, prop.start + 1, prop.end - 1, settings.to),
		from: literal.value,
	};
}

const plistString = (key: string) =>
	new RegExp(String.raw`(<key>${key}</key>\s*<string>)([^<]*)(</string>)`);

const GRADLE_NAME = /(\bversionName\s*=?\s*)(["'])([^"']*)\2/;
const GRADLE_CODE = /(\bversionCode\s*=?\s*)(\d+)/;

function setPlist(text: string, settings: Settings): Edited | string {
	const short = plistString('CFBundleShortVersionString');
	const match = short.exec(text);
	if (!match) return 'it has no CFBundleShortVersionString to set';
	const from = match[2]!;
	if (from.startsWith('$(')) {
		return `its version is the build variable ${from}, so it lives in the Xcode project's MARKETING_VERSION: list that file instead`;
	}

	let next = text.replace(short, `$1${settings.to}$3`);
	if (settings.increment) {
		const build = plistString('CFBundleVersion');
		const raised = bump(build.exec(next)?.[2] ?? '');
		if (raised !== undefined) next = next.replace(build, `$1${raised}$3`);
	}

	return {text: next, from};
}

function setGradle(text: string, settings: Settings): Edited | string {
	const match = GRADLE_NAME.exec(text);
	if (!match) return 'it has no versionName "…" to set';
	let next = text.replace(GRADLE_NAME, `$1$2${settings.to}$2`);
	if (settings.increment) {
		const raised = bump(GRADLE_CODE.exec(next)?.[2] ?? '');
		if (raised !== undefined) next = next.replace(GRADLE_CODE, `$1${raised}`);
	}

	return {text: next, from: match[3]!};
}

/** The edited text, or the reason the file has no version to set. */
function setVersion(
	file: string,
	text: string,
	settings: Settings,
): Edited | string {
	const name = path.posix.basename(file);
	if (name === 'package.json') {
		return setPackageJson(text, settings) ?? 'it has no "version" to set';
	}

	if (name === 'app.json') {
		return (
			setExpo(text, true, settings) ?? 'it has no expo.version string to set'
		);
	}

	if (name === 'app.config.ts' || name === 'app.config.js') {
		return (
			setExpo(text, false, settings) ??
			'it has no top-level version: "…" property to set'
		);
	}

	if (name === 'Info.plist') return setPlist(text, settings);
	if (name === 'build.gradle') return setGradle(text, settings);
	const {current} = settings;
	if (current === null) {
		return 'the unit has no current version to look for in it';
	}

	const index = text.indexOf(current);
	if (index === -1) return `it doesn't contain the current version ${current}`;
	return {
		text: replace(text, index, index + current.length, settings.to),
		from: current,
	};
}

async function readFileText(
	root: string,
	file: string,
): Promise<string | undefined> {
	try {
		return await readFile(path.join(root, file), 'utf8');
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw new Error(`Can't read ${file}: ${(error as Error).message}`);
	}
}

/**
 * The unit's version files, set to `to`: its package.json (when it has one
 * with a version) and every file in `versionFiles`. Reads everything and
 * writes nothing; if any listed file has no version to set it throws a
 * `ReleaseError('invalid-version')` naming that file.
 */
export async function editVersionFiles(
	root: string,
	unit: ResolvedUnit,
	to: string,
	options: {
		current: string | null;
		buildNumber: 'untouched' | 'increment';
		easRemote: boolean;
	},
): Promise<VersionFileEdit[]> {
	const settings: Settings = {
		to,
		current: options.current,
		increment: options.buildNumber === 'increment' && !options.easRemote,
	};
	const own = joinPath(unit.path, 'package.json');
	const files = [own, ...unit.versionFiles.filter(file => file !== own)];
	const edits: VersionFileEdit[] = [];
	for (const file of files) {
		const text = await readFileText(root, file);
		if (text === undefined) {
			if (file === own) continue;
			throw new ReleaseError(
				'invalid-version',
				`${file} is listed in versionFiles but doesn't exist`,
			);
		}

		const result = setVersion(file, text, settings);
		if (typeof result === 'string') {
			if (file === own) continue;
			throw new ReleaseError(
				'invalid-version',
				`can't set the version in ${file}: ${result}`,
			);
		}

		edits.push({file, text: result.text, from: result.from});
	}

	return edits;
}

const SKIPPED = new Set(['node_modules', 'Pods', 'build', 'DerivedData']);

async function subfolders(root: string, folder: string): Promise<string[]> {
	try {
		const entries = await readdir(path.join(root, folder), {
			withFileTypes: true,
		});
		return entries
			.filter(entry => entry.isDirectory() && !SKIPPED.has(entry.name))
			.map(entry => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** Files under the unit's path that hold a version chamoji knows how to set. */
export async function detectVersionFiles(
	root: string,
	unitPath: string,
): Promise<string[]> {
	const settings: Settings = {to: '0.0.0', current: null, increment: false};
	const candidates = [
		'package.json',
		'app.json',
		'app.config.ts',
		'app.config.js',
	].map(name => joinPath(unitPath, name));
	const ios = joinPath(unitPath, 'ios');
	for (const first of await subfolders(root, ios)) {
		candidates.push(joinPath(ios, first, 'Info.plist'));
		for (const second of await subfolders(root, joinPath(ios, first))) {
			candidates.push(joinPath(ios, first, second, 'Info.plist'));
		}
	}

	candidates.push(joinPath(unitPath, 'android', 'app', 'build.gradle'));

	const found: string[] = [];
	for (const file of candidates) {
		const text = await readFileText(root, file);
		if (
			text !== undefined &&
			typeof setVersion(file, text, settings) !== 'string'
		) {
			found.push(file);
		}
	}

	return found;
}
