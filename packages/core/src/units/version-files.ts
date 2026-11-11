import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {ReleaseError} from '../release.js';
import {
	manifestVersion,
	readSdfManifest,
	sdfProjectAt,
	setManifestVersion,
	type SdfProject,
} from './sdf.js';
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

/** A config shape chamoji could misread, so it refuses to edit it. */
class Unsupported extends Error {}

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

		if (ch === '/' && startsRegex(text, i)) {
			i = skipRegex(text, i);
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

const isWordChar = (ch: string | undefined): boolean =>
	ch !== undefined && /[\w$]/.test(ch);

/** Whether the `/` at `i` opens a regex literal rather than dividing. */
function startsRegex(text: string, i: number): boolean {
	if (text.startsWith('//', i) || text.startsWith('/*', i)) return false;
	let j = i - 1;
	while (j >= 0 && /\s/.test(text[j]!)) j--;
	if (j < 0 || '(,=:[!&|?{};'.includes(text[j]!)) return true;
	let k = j;
	while (k >= 0 && isWordChar(text[k])) k--;
	return text.slice(k + 1, j + 1) === 'return';
}

/** Index just past the regex literal at `from`, or `from + 1` if unclosed. */
function skipRegex(text: string, from: number): number {
	let inClass = false;
	for (let i = from + 1; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '\n') break;
		if (ch === '\\') i++;
		else if (ch === '[') inClass = true;
		else if (ch === ']') inClass = false;
		else if (ch === '/' && !inClass) return i + 1;
	}

	return from + 1;
}

/**
 * The first match of the sticky `pattern` outside comments, strings and regex
 * literals, starting at a token boundary; its index, or -1.
 */
function findToken(text: string, pattern: RegExp, from = 0): number {
	let i = from;
	while (i < text.length) {
		const next = skipTrivia(text, i);
		if (next !== i) {
			i = next;
			continue;
		}

		const ch = text[i]!;
		if (ch === '"' || ch === "'" || ch === '`') {
			i = skipString(text, i);
			continue;
		}

		if (ch === '/' && startsRegex(text, i)) {
			i = skipRegex(text, i);
			continue;
		}

		pattern.lastIndex = i;
		if (!isWordChar(text[i - 1]) && text[i - 1] !== '.' && pattern.test(text)) {
			return i;
		}

		i++;
	}

	return -1;
}

/** Index of the `)`, `]` or `}` closing the opener at `open`, or -1. */
function matchClose(text: string, open: number): number {
	let depth = 0;
	let i = open;
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

		if (ch === '/' && startsRegex(text, i)) {
			i = skipRegex(text, i);
			continue;
		}

		if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch) && --depth === 0) return i;
		i++;
	}

	return -1;
}

/** `{` of the `return`ed expression's object in the block at `open`, or -1. */
function returnedObject(text: string, open: number): number {
	const close = matchClose(text, open);
	if (close === -1) return -1;
	let depth = 0;
	for (let i = open; i < close; i++) {
		const ch = text[i]!;
		if (ch === '"' || ch === "'" || ch === '`') {
			i = skipString(text, i) - 1;
		} else if (text.startsWith('//', i) || text.startsWith('/*', i)) {
			i = skipTrivia(text, i) - 1;
		} else if ('([{'.includes(ch)) depth++;
		else if (')]}'.includes(ch)) depth--;
		else if (
			depth === 1 &&
			text.startsWith('return', i) &&
			!isWordChar(text[i - 1]) &&
			!isWordChar(text[i + 6])
		) {
			return objectOf(text, i + 6);
		}
	}

	return -1;
}

/**
 * `{` of the object the expression at `from` evaluates to: a literal, a
 * parenthesised one, an arrow function's result (with or without a typed
 * parameter list and return type), a call wrapper such as `defineConfig(…)`
 * or a variable declared as an object. -1 when it can't tell.
 */
function objectOf(text: string, from: number): number {
	let i = skipTrivia(text, from);
	if (text[i] === '{') return i;
	if (/^async\b/.test(text.slice(i, i + 6))) i = skipTrivia(text, i + 5);
	if (text[i] === '(') {
		const close = matchClose(text, i);
		if (close === -1) return -1;
		const after = skipTrivia(text, close + 1);
		if (text[after] === ':' || text.startsWith('=>', after)) {
			return arrowBody(text, after);
		}

		return objectOf(text, i + 1);
	}

	const ident = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(
		text.slice(i, i + 200),
	);
	if (!ident) return -1;
	const after = skipTrivia(text, i + ident[0].length);
	if (text.startsWith('=>', after)) return arrowBody(text, after);
	if (text[after] === '(') {
		// `merge(base, {…})`: which argument is the config is anyone's guess.
		let next = skipTrivia(text, skipValue(text, skipTrivia(text, after + 1)));
		if (text[next] === ',') next = skipTrivia(text, next + 1);
		if (text[next] !== ')') {
			throw new Unsupported(
				`its config is passed to ${ident[0]}(…) with other arguments, so chamoji can't tell which object is exported`,
			);
		}

		return objectOf(text, after + 1);
	}

	if (ident[0].includes('.')) return -1;
	const declaration = String.raw`(?:const|let|var)\s+${ident[0]}(?![\w$])`;
	const declared = findToken(text, new RegExp(declaration, 'y'));
	if (declared === -1) return -1;
	const head = new RegExp(`^${declaration}`).exec(text.slice(declared))![0];
	const equals = findAssign(text, declared + head.length);
	return equals === -1 ? -1 : objectOf(text, equals + 1);
}

/** Index of the `=` that begins an initialiser, skipping a type annotation. */
function findAssign(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const ch = text[i]!;
		if ('([{<'.includes(ch)) depth++;
		else if (')]}'.includes(ch)) depth--;
		else if (ch === '>' && text[i - 1] !== '=') depth--;
		else if (ch === '=' && depth <= 0 && text[i + 1] !== '>') return i;
		else if (ch === ';' && depth <= 0) return -1;
	}

	return -1;
}

/** From the `:` of a return type or the `=>` of an arrow, to its object. */
function arrowBody(text: string, from: number): number {
	const arrow = text.startsWith('=>', from) ? from : findArrow(text, from);
	if (arrow === -1) return -1;
	const body = skipTrivia(text, arrow + 2);
	if (text[body] === '{') return returnedObject(text, body);
	return objectOf(text, body);
}

function findArrow(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const ch = text[i]!;
		if ('([{<'.includes(ch)) depth++;
		else if (')]}'.includes(ch) || (ch === '>' && text[i - 1] !== '=')) {
			depth--;
		} else if (depth <= 0 && text.startsWith('=>', i)) return i;
		else if (ch === ';') return -1;
	}

	return -1;
}

/** `{` of the object a JS/TS config file exports, or -1. */
function exportedObject(text: string): number {
	const start = findToken(
		text,
		/(?:export\s+default(?![\w$])|module\.exports\s*=(?!=))/y,
	);
	if (start === -1) return -1;
	const token = /^(?:export\s+default|module\.exports\s*=)/.exec(
		text.slice(start, start + 100),
	)![0];
	return objectOf(text, start + token.length);
}

/** `{` of the object that holds `version`, `ios` and `android`. */
function configRoot(text: string, json: boolean): number {
	const top = json ? text.indexOf('{') : exportedObject(text);
	if (top === -1) return -1;
	const expo = props(text, top).find(prop => prop.key === 'expo');
	return expo && text[expo.start] === '{' ? expo.start : top;
}

/** The `key` property of the object at `open`; JS keeps the last of a repeated `version`, so that is refused. */
function findProp(text: string, open: number, key: string): Prop | undefined {
	const found = props(text, open).filter(prop => prop.key === key);
	if (key === 'version' && found.length > 1) {
		throw new Unsupported('its config object has more than one version key');
	}

	return found[0];
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
		found = findProp(text, open, key);
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
	if (literal.quote === '`' && literal.value.includes('${')) {
		throw new Unsupported(
			"its version is a template literal with ${…}, which chamoji can't set",
		);
	}

	let next = replace(text, prop.start + 1, prop.end - 1, settings.to);
	if (settings.increment) next = incrementExpo(next, json);
	return {text: next, from: literal.value};
}

/** The JSON property at `keys`, from the top-level object down, or undefined. */
function jsonProp(text: string, keys: string[]): Prop | undefined {
	let open = text.indexOf('{');
	let found: Prop | undefined;
	for (const key of keys) {
		if (open === -1) return undefined;
		found = findProp(text, open, key);
		if (!found) return undefined;
		open = text[found.start] === '{' ? found.start : -1;
	}

	return found;
}

/**
 * JSON `text` with the plain string at `keyPath` set to `value`, edited as
 * text so formatting survives; undefined when the path doesn't lead to one.
 */
export function setJsonString(
	text: string,
	keyPath: string[],
	value: string,
): string | undefined {
	const prop = jsonProp(text, keyPath);
	const literal = prop && stringLiteral(text, prop);
	if (!prop || literal?.quote !== '"') return undefined;
	return replace(text, prop.start, prop.end, JSON.stringify(value));
}

function setPackageJson(text: string, settings: Settings) {
	const prop = jsonProp(text, ['version']);
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
		return `its version is the build variable ${from}, which chamoji can't edit yet; remove this file from versionFiles and bump MARKETING_VERSION in Xcode yourself`;
	}

	let next = text.replace(
		short,
		(_, a: string, __, c: string) => a + settings.to + c,
	);
	if (settings.increment) {
		const build = plistString('CFBundleVersion');
		const raised = bump(build.exec(next)?.[2] ?? '');
		if (raised !== undefined)
			next = next.replace(
				build,
				(_, a: string, __, c: string) => a + raised + c,
			);
	}

	return {text: next, from};
}

function setGradle(text: string, settings: Settings): Edited | string {
	const match = GRADLE_NAME.exec(text);
	if (!match) return 'it has no versionName "…" to set';
	let next = text.replace(
		GRADLE_NAME,
		(_, a: string, q: string) => a + q + settings.to + q,
	);
	if (settings.increment) {
		const raised = bump(GRADLE_CODE.exec(next)?.[2] ?? '');
		if (raised !== undefined)
			next = next.replace(GRADLE_CODE, (_, a: string) => a + raised);
	}

	return {text: next, from: match[3]!};
}

/** The edited text, or the reason the file has no version chamoji can set. */
function setVersion(
	file: string,
	text: string,
	settings: Settings,
): Edited | string {
	try {
		return setKnownVersion(file, text, settings);
	} catch (error) {
		if (error instanceof Unsupported) return error.message;
		throw error;
	}
}

function setKnownVersion(
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

	if (name === 'manifest.xml') {
		// An SDF manifest changes only its <projectversion>; any other
		// manifest.xml takes the generic replace below, as before 0.16.
		const edited = setManifestVersion(text, settings.to);
		if (edited) return edited;
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

async function isSymlink(root: string, file: string): Promise<boolean> {
	try {
		return (await lstat(path.join(root, file))).isSymbolicLink();
	} catch (error) {
		if (isMissing(error)) return false;
		throw new Error(`Can't read ${file}: ${(error as Error).message}`);
	}
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
	const same = (a: string, b: string): boolean =>
		path.posix.normalize(a) === path.posix.normalize(b);
	const listed = unit.versionFiles.some(file => same(file, own));
	const files = listed ? unit.versionFiles : [own, ...unit.versionFiles];
	const isOwn = (file: string): boolean => !listed && file === own;
	const edits: VersionFileEdit[] = [];
	for (const file of files) {
		// Writing through a link would change a file the config doesn't name.
		if (!isOwn(file) && (await isSymlink(root, file))) {
			throw new ReleaseError(
				'invalid-version',
				`${file} is listed in versionFiles but is a symlink; list the file it points to instead`,
			);
		}

		const text = await readFileText(root, file);
		if (text === undefined) {
			if (isOwn(file)) continue;
			throw new ReleaseError(
				'invalid-version',
				`${file} is listed in versionFiles but doesn't exist`,
			);
		}

		const result = setVersion(file, text, settings);
		if (typeof result === 'string') {
			if (isOwn(file)) continue;
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
	options?: {sdf?: SdfProject[]},
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
	const sdf = await sdfProjectAt(root, unitPath, {projects: options?.sdf});
	if (sdf) candidates.push(sdf.manifest);

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

/**
 * The unit's current version: its package.json version, else the
 * `<projectversion>` of the first `manifest.xml` in its `versionFiles`.
 */
export async function readUnitVersion(
	root: string,
	unit: ResolvedUnit,
): Promise<string | null> {
	if (unit.pkg?.version) return unit.pkg.version;
	for (const file of unit.versionFiles) {
		if (path.posix.basename(file) !== 'manifest.xml') continue;
		const text = await readSdfManifest(root, file);
		const value = text === null ? null : manifestVersion(text);
		if (value) return value;
	}

	return null;
}
