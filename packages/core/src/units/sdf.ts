import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from '../git.js';
import {isLinkAt} from '../links.js';

export type SdfProject = {
	/** The unit folder, '/'-separated and relative to the repo; '' for the root. */
	path: string;
	/** The repo-relative `manifest.xml`. */
	manifest: string;
	type: 'suiteapp' | 'acp';
	/** `publisherid.projectid`, for a SuiteApp. */
	applicationId: string | null;
	/** The manifest's `<projectversion>`. */
	version: string | null;
	framework: 'netsuite-suiteapp' | 'netsuite-acp';
};

const DEFAULT_FOLDER = 'src';
const CONFIG_FILE = 'suitecloud.config.js';
const FOLDER = /defaultProjectFolder\s*:\s*["'`]([^"'`]+)["'`]/;
/** The most of a `manifest.xml` chamoji reads; a larger file isn't an SDF project. */
export const MANIFEST_READ_LIMIT = 1_048_576;
/** The most of the root `<manifest …>` tag looked at for its `projecttype`. */
const ROOT_TAG_LIMIT = 4096;
const PROJECT_TYPE = /\bprojecttype\s*=\s*["']([^"']+)["']/;
export const PROJECT_VERSION = /<projectversion>([^<]*)<\/projectversion>/;

/**
 * `text` with each `<!-- … -->` blanked to spaces of the same length, so
 * offsets still match `text`. An unclosed comment blanks to the end. It walks
 * with `indexOf`, so a hostile file costs one pass.
 */
export function stripComments(text: string): string {
	let from = text.indexOf('<!--');
	if (from === -1) return text;
	const parts: string[] = [];
	let copied = 0;
	while (from !== -1) {
		const close = text.indexOf('-->', from + 4);
		const end = close === -1 ? text.length : close + 3;
		parts.push(text.slice(copied, from), ' '.repeat(end - from));
		copied = end;
		from = text.indexOf('<!--', end);
	}

	parts.push(text.slice(copied));
	return parts.join('');
}

/** The `projecttype` of the root `<manifest>` element in comment-free `text`, or undefined. */
function rootProjectType(text: string): string | undefined {
	let at = text.indexOf('<manifest');
	// `<manifestx` is another element; the root is the first real `<manifest`.
	while (at !== -1 && !/[\s>/]/.test(text[at + '<manifest'.length] ?? '')) {
		at = text.indexOf('<manifest', at + 1);
	}

	if (at === -1) return undefined;
	const head = text.slice(at, at + ROOT_TAG_LIMIT);
	const close = head.indexOf('>');
	return close === -1
		? undefined
		: PROJECT_TYPE.exec(head.slice(0, close))?.[1];
}

const parent = (folder: string): string =>
	path.posix.dirname(folder) === '.' ? '' : path.posix.dirname(folder);

const element = (text: string, name: string): string | null => {
	const match = new RegExp(String.raw`<${name}>([^<]*)</${name}>`).exec(text);
	const value = match?.[1]?.trim();
	return value ? value : null;
};

async function read(root: string, file: string): Promise<string | null> {
	try {
		return await readFile(path.join(root, file), 'utf8');
	} catch {
		return null;
	}
}

/** A `manifest.xml`'s text, or null when it's missing, unreadable or over MANIFEST_READ_LIMIT. */
export async function readManifest(
	root: string,
	file: string,
): Promise<string | null> {
	try {
		const full = path.join(root, file);
		if ((await stat(full)).size > MANIFEST_READ_LIMIT) return null;
		return await readFile(full, 'utf8');
	} catch {
		return null;
	}
}

/** The tracked and untracked-but-not-ignored files; empty outside a repo. */
async function listFiles(root: string): Promise<string[]> {
	try {
		const listed = await runGit(
			['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
			root,
		);
		return listed.split('\0').filter(Boolean);
	} catch {
		return [];
	}
}

const normalizeFolder = (value: string): string =>
	path.posix
		.normalize(value.trim().replaceAll('\\', '/'))
		.replace(/^\.?\/+/, '')
		.replace(/\/+$/, '');

/**
 * The SuiteCloud (SDF) projects of the repo at `root`, sorted by path. A
 * tracked `manifest.xml` whose root element is `<manifest projecttype="…">`,
 * next to a `deploy.xml`, marks a project folder; its unit is that folder's
 * parent. With a `suitecloud.config.js` there, only its `defaultProjectFolder`
 * counts; without one a folder named `src` wins, else the first in path order.
 * Ignored files are never read, and nothing is run.
 */
export async function findSdfProjects(root: string): Promise<SdfProject[]> {
	const files = await listFiles(root);
	const tracked = new Set(files);
	const folders = new Map<string, string[]>();
	for (const file of files) {
		if (file.split('/').includes('node_modules')) continue;
		if (path.posix.basename(file) !== 'manifest.xml') continue;
		const folder =
			path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
		if (!tracked.has(folder ? `${folder}/deploy.xml` : 'deploy.xml')) continue;
		const unit = parent(folder);
		folders.set(unit, [...(folders.get(unit) ?? []), folder]);
	}

	const found: SdfProject[] = [];
	for (const [unit, candidates] of folders) {
		candidates.sort();
		const configFile = unit ? `${unit}/${CONFIG_FILE}` : CONFIG_FILE;
		let chosen: string | undefined;
		if (tracked.has(configFile)) {
			// A linked config could point anywhere; chamoji reads none of it.
			if (await isLinkAt(root, configFile)) continue;
			const config = (await read(root, configFile)) ?? '';
			const named = normalizeFolder(FOLDER.exec(config)?.[1] ?? DEFAULT_FOLDER);
			chosen = candidates.find(
				folder => folder === (unit ? `${unit}/${named}` : named),
			);
		} else {
			chosen =
				candidates.find(
					folder => path.posix.basename(folder) === DEFAULT_FOLDER,
				) ?? candidates[0];
		}

		if (chosen === undefined) continue;
		const manifest = chosen ? `${chosen}/manifest.xml` : 'manifest.xml';
		const deploy = chosen ? `${chosen}/deploy.xml` : 'deploy.xml';
		if ((await isLinkAt(root, manifest)) || (await isLinkAt(root, deploy))) {
			continue;
		}

		const text = stripComments((await readManifest(root, manifest)) ?? '');
		const projectType = rootProjectType(text)?.trim().toUpperCase();
		if (projectType !== 'SUITEAPP' && projectType !== 'ACCOUNTCUSTOMIZATION') {
			continue;
		}

		const suiteApp = projectType === 'SUITEAPP';
		const publisher = element(text, 'publisherid');
		const project = element(text, 'projectid');
		found.push({
			path: unit,
			manifest,
			type: suiteApp ? 'suiteapp' : 'acp',
			applicationId:
				suiteApp && publisher && project ? `${publisher}.${project}` : null,
			version: element(text, 'projectversion'),
			framework: suiteApp ? 'netsuite-suiteapp' : 'netsuite-acp',
		});
	}

	return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The SDF project whose unit folder is `unitPath` ('' or '.' for the root), or null. */
export async function sdfProjectAt(
	root: string,
	unitPath: string,
): Promise<SdfProject | null> {
	const wanted = unitPath === '.' ? '' : unitPath.replace(/\/+$/, '');
	return (
		(await findSdfProjects(root)).find(project => project.path === wanted) ??
		null
	);
}

/**
 * `text` with the text of `<projectversion>` set to `to`, and the version it
 * carried; null when there is no such element outside a comment. Nothing else
 * in the file changes.
 */
export function setManifestVersion(
	text: string,
	to: string,
): {text: string; from: string} | null {
	if (text.length > MANIFEST_READ_LIMIT) return null;
	// Blank the comments out, same length, so offsets still match `text`.
	const visible = stripComments(text);
	const match = PROJECT_VERSION.exec(visible);
	if (!match) return null;
	const start = match.index + '<projectversion>'.length;
	const end = start + match[1]!.length;
	return {
		text: text.slice(0, start) + to + text.slice(end),
		from: match[1]!.trim(),
	};
}
