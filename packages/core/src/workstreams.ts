import {execFile} from 'node:child_process';
import {lstat, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Document, isMap, parseDocument} from 'yaml';
import {assertRevision, runGit} from './git.js';

export const WORKSTREAMS_FILE = '.chamoji/workstreams.yml';

const STATUSES = ['active', 'shipped', 'dropped'] as const;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 64;

export type WorkstreamStatus = (typeof STATUSES)[number];

export type Workstream = {
	slug: string;
	title: string;
	emoji?: string;
	description?: string;
	status: WorkstreamStatus;
	links?: string[];
};

/** The workstreams file is unusable, or a request names a bad workstream. */
export class WorkstreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkstreamError';
	}
}

/** `Auth revamp!` becomes `auth-revamp`. Throws when nothing usable is left. */
export function slugify(title: string): string {
	const slug = title
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG)
		.replace(/-+$/, '');
	if (slug === '') {
		throw new WorkstreamError(`"${title}" has no letters or digits for a slug`);
	}

	return slug;
}

export function isSlug(value: string): boolean {
	return value.length <= MAX_SLUG && SLUG.test(value);
}

/** The workstreams in the working tree; `[]` when the file is absent. */
export async function readWorkstreams(cwd: string): Promise<Workstream[]> {
	const text = await readFileIfExists(await workstreamsPath(cwd));
	return text === undefined ? [] : parseWorkstreams(text);
}

/** The workstreams as committed at `ref`; `[]` when the file is absent there. */
export async function readWorkstreamsAt(
	cwd: string,
	ref: string,
): Promise<Workstream[]> {
	await assertRevision(cwd, ref);
	let text: string;
	try {
		text = await runGit(['show', `${ref}:${WORKSTREAMS_FILE}`], cwd);
	} catch {
		return [];
	}

	return parseWorkstreams(text);
}

/** Adds an active workstream named by `input.title` and stages the file. */
export async function addWorkstream(
	cwd: string,
	input: {title: string; emoji?: string; description?: string},
): Promise<Workstream> {
	const slug = slugify(input.title);
	const file = await workstreamsPath(cwd);
	const document = await openDocument(file);
	if (document.hasIn(['workstreams', slug])) {
		throw new WorkstreamError(`A workstream named "${slug}" already exists`);
	}

	const entry: Record<string, string> = {title: input.title.trim()};
	if (input.emoji) entry['emoji'] = input.emoji;
	if (input.description) entry['description'] = input.description;
	entry['status'] = 'active';
	if (!isMap(document.get('workstreams', true))) {
		document.set('workstreams', document.createNode({}));
	}

	document.setIn(['workstreams', slug], entry);
	await save(cwd, file, document);
	return {slug, ...entry, status: 'active'} as Workstream;
}

export async function setWorkstreamStatus(
	cwd: string,
	slug: string,
	status: WorkstreamStatus,
): Promise<Workstream> {
	const file = await workstreamsPath(cwd);
	const document = await openDocument(file);
	const current = parseWorkstreams(document.toString()).find(
		item => item.slug === slug,
	);
	if (!current) {
		throw new WorkstreamError(`No workstream named "${slug}"`);
	}

	document.setIn(['workstreams', slug, 'status'], status);
	await save(cwd, file, document);
	return {...current, status};
}

/**
 * The workstream this worktree is in, or null. It is only returned while the
 * slug is `active` in the working-tree file, so a shipped or dropped
 * workstream stops stamping on its own.
 */
export async function getActive(cwd: string): Promise<string | null> {
	let text: string | undefined;
	try {
		text = await readFileIfExists(await activePath(cwd));
	} catch {
		return null;
	}

	const slug = text?.trim();
	if (slug === undefined || !isSlug(slug)) return null;
	const found = (await readWorkstreams(cwd)).find(item => item.slug === slug);
	return found?.status === 'active' ? slug : null;
}

/** Sets this worktree's active workstream, or clears it with `null`. */
export async function setActive(
	cwd: string,
	slug: string | null,
): Promise<void> {
	const file = await activePath(cwd);
	if (slug === null) {
		await rm(file, {force: true});
		return;
	}

	if (!isSlug(slug)) {
		throw new WorkstreamError(`"${slug}" is not a valid workstream slug`);
	}

	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, `${slug}\n`);
}

/**
 * Whether `prepare-commit-msg` should stamp. Git's `source` is `message` for
 * `-m`, `template` for a `commit.template` file, and `merge`, `squash` or
 * `commit` for messages that already exist. A template is not stamped: git
 * aborts a commit whose message is still the unedited template, and a trailer
 * would stop that. A message the composer wrote counts as having no source.
 */
export function shouldStamp(input: {
	source?: string;
	rebasing: boolean;
}): boolean {
	return (
		!input.rebasing &&
		(input.source === undefined || input.source === 'message')
	);
}

/**
 * Whether git would count a commit message as non-empty, for the cases the
 * hook has met: text above the scissors line of `git commit -v`, once comment
 * lines are stripped by git's own rule (so `core.commentChar` counts), and
 * ignoring `Signed-off-by: ` lines, which git also treats as no message.
 * That is what an editor commit gets. For `source` `message` (`-m`, `-F`),
 * git keeps comment-looking lines under its default cleanup, so `#123 fix`
 * is a message there, unless `commit.cleanup` is `strip`, where git aborts on
 * it. That config is only read when a message is nothing but comment lines.
 * It does not mirror other `commit.cleanup` modes or template checks.
 * `cwd` must be inside the repository.
 */
export async function hasMessageContent(
	cwd: string,
	message: string,
	source?: string,
): Promise<boolean> {
	const kept = message.split('\n');
	const scissors = kept.findIndex(line => SCISSORS.test(line));
	const above = scissors === -1 ? message : kept.slice(0, scissors).join('\n');
	if ((await stripComments(cwd, above)).split('\n').some(isContent)) {
		return true;
	}

	if (source !== 'message' || !above.split('\n').some(isContent)) return false;
	return !(await cleanupIsStrip(cwd));
}

function isContent(line: string): boolean {
	return line.trim() !== '' && !line.startsWith(SIGN_OFF);
}

/** `git config --get` exits 1 when the key is unset: that is not `strip`. */
async function cleanupIsStrip(cwd: string): Promise<boolean> {
	try {
		const value = await runGit(['config', '--get', 'commit.cleanup'], cwd);
		return value.trim() === 'strip';
	} catch {
		return false;
	}
}

/** What git's own empty-message check skips, as `git commit -s` writes it. */
const SIGN_OFF = 'Signed-off-by: ';

/** `<comment char> ------------------------ >8 ------------------------` */
const SCISSORS = /^\S+ -{24} >8 -{24}$/;

async function stripComments(cwd: string, text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'git',
			['stripspace', '--strip-comments'],
			{cwd},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
		child.stdin?.end(text);
	});
}

/**
 * Adds `Workstream: <slug>` to the commit message in `messageFile` for the
 * active workstream. A message that already has the trailer keeps it, and a
 * message with no content yet is left alone: a trailer would make an empty
 * message look like a message, and quitting the editor would commit it.
 * `source` is git's, as for `hasMessageContent`: `message` makes a message of
 * only `#` lines count as content. Returns the slug it stamped, or null when
 * it changed nothing.
 */
export async function stampWorkstream(
	cwd: string,
	messageFile: string,
	source?: string,
): Promise<string | null> {
	const slug = await getActive(cwd);
	if (slug === null) return null;
	const file = path.resolve(cwd, messageFile);
	const before = await readFile(file, 'utf8');
	if (!(await hasMessageContent(cwd, before, source))) return null;
	await runGit(
		[
			'interpret-trailers',
			'--in-place',
			'--if-exists',
			'doNothing',
			'--trailer',
			`Workstream: ${slug}`,
			file,
		],
		cwd,
	);
	return (await readFile(file, 'utf8')) === before ? null : slug;
}

async function topLevel(cwd: string): Promise<string> {
	return (await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();
}

async function workstreamsPath(cwd: string): Promise<string> {
	return path.join(await topLevel(cwd), WORKSTREAMS_FILE);
}

async function activePath(cwd: string): Promise<string> {
	const gitDir = (
		await runGit(['rev-parse', '--absolute-git-dir'], cwd)
	).trim();
	return path.join(gitDir, 'chamoji', 'active');
}

async function readFileIfExists(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/** Parses the file for editing; absent is empty. Refuses a corrupt file. */
async function openDocument(file: string): Promise<Document> {
	await refuseSymlinks(file);
	const text = await readFileIfExists(file);
	if (text === undefined) return new Document();
	return checked(text).document;
}

/**
 * A cloned repo can commit `.chamoji` or the file as a symlink, and writing
 * through it would reach outside the repo. A missing path is fine.
 */
async function refuseSymlinks(file: string): Promise<void> {
	for (const target of [path.dirname(file), file]) {
		let isLink: boolean;
		try {
			isLink = (await lstat(target)).isSymbolicLink();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}

		if (isLink) {
			throw new WorkstreamError(
				`${target === file ? WORKSTREAMS_FILE : '.chamoji'} is a symlink, so chamoji will not write through it`,
			);
		}
	}
}

function checked(text: string): {document: Document; data: unknown} {
	const document = parseDocument(text);
	const [problem] = document.errors;
	if (problem) {
		throw new WorkstreamError(
			`${WORKSTREAMS_FILE} is not valid YAML (${problem.message.split('\n')[0]}). Fix it, or resolve any merge conflict, and try again.`,
		);
	}

	let data: unknown;
	try {
		data = document.toJS();
	} catch (error) {
		// Aliases can expand without limit; yaml refuses with a ReferenceError.
		throw new WorkstreamError(
			`${WORKSTREAMS_FILE} cannot be read (${(error as Error).message})`,
		);
	}

	const shapeOk =
		data === null ||
		(isPlain(data) &&
			(data['workstreams'] === undefined ||
				data['workstreams'] === null ||
				isPlain(data['workstreams'])));
	if (!shapeOk) {
		throw new WorkstreamError(
			`${WORKSTREAMS_FILE} must hold a "workstreams" mapping`,
		);
	}

	return {document, data};
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkstreams(text: string): Workstream[] {
	const {data} = checked(text) as {data: {workstreams?: unknown} | null};
	const entries = data?.workstreams;
	if (typeof entries !== 'object' || entries === null) return [];
	const found: Workstream[] = [];
	for (const [slug, raw] of Object.entries(entries)) {
		const entry = toWorkstream(slug, raw);
		if (entry) found.push(entry);
	}

	return found;
}

function toWorkstream(slug: string, raw: unknown): Workstream | undefined {
	if (!isSlug(slug) || typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const {title, emoji, description, status, links} = raw as Record<
		string,
		unknown
	>;
	if (typeof title !== 'string' || title.trim() === '') return undefined;
	if (!STATUSES.includes(status as WorkstreamStatus)) return undefined;
	const workstream: Workstream = {
		slug,
		title: title.trim(),
		status: status as WorkstreamStatus,
	};
	if (typeof emoji === 'string' && emoji !== '') workstream.emoji = emoji;
	if (typeof description === 'string' && description !== '') {
		workstream.description = description;
	}

	if (Array.isArray(links)) {
		const urls = links.filter(link => typeof link === 'string');
		if (urls.length > 0) workstream.links = urls;
	}

	return workstream;
}

async function save(
	cwd: string,
	file: string,
	document: Document,
): Promise<void> {
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, document.toString());
	await runGit(['add', '--', file], cwd);
}
