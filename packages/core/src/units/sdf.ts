import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {runGit} from '../git.js';

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
const COMMENTS = /<!--[\s\S]*?-->/g;
const PROJECT_TYPE =
	/<manifest\b[^>]*?\bprojecttype\s*=\s*["']([^"']+)["'][^>]*>/;

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
		const text = ((await read(root, manifest)) ?? '').replace(COMMENTS, '');
		const projectType = PROJECT_TYPE.exec(text)?.[1]?.trim().toUpperCase();
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

const PROJECT_VERSION = /<projectversion>([^<]*)<\/projectversion>/;

/**
 * `text` with the text of `<projectversion>` set to `to`, and the version it
 * carried; null when there is no such element outside a comment. Nothing else
 * in the file changes.
 */
export function setManifestVersion(
	text: string,
	to: string,
): {text: string; from: string} | null {
	// Blank the comments out, same length, so offsets still match `text`.
	const visible = text.replace(COMMENTS, comment => ' '.repeat(comment.length));
	const match = PROJECT_VERSION.exec(visible);
	if (!match) return null;
	const start = match.index + '<projectversion>'.length;
	const end = start + match[1]!.length;
	return {
		text: text.slice(0, start) + to + text.slice(end),
		from: match[1]!.trim(),
	};
}
