import {accessSync, constants, statSync} from 'node:fs';
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	MEMORY_FETCH_REFSPEC,
	MemoryError,
	assertGitRepo,
	fetchesMemory,
	hasOrigin,
	pullMemory,
	runGit,
} from '@chamoji/core';
import {isRecord, own} from './agent-hook.js';
import {entryCount, FORCE_STEP} from './memory.js';
import type {Io} from './run.js';
import {stripControlLines} from './text.js';

/**
 * `chamoji init`: sets this clone up to share memory, and takes in what origin
 * has so a fresh clone needs nothing else. It adds a fetch refspec and leaves
 * `remote.origin.push` unset, because setting that makes a plain `git push`
 * push only memory and leave the branch behind. It pushes nothing.
 *
 * With `--agents` it first wires Claude Code to chamoji in this repo: the MCP
 * server in `.mcp.json` and the commit hook in `.claude/settings.json`. Those
 * two files are shared, so they are merged into, never replaced.
 */
export async function runInit(
	flags: {agents?: boolean},
	io: Io,
): Promise<number> {
	await assertGitRepo(io.cwd);
	if (flags.agents) {
		const code = await setUpAgents(io);
		if (code !== 0) return code;
	}

	if (!(await hasOrigin(io.cwd))) {
		io.stdout(
			'No remote named origin, so there is nothing to share memory with. Add one and run chamoji init again.\n',
		);
		return 0;
	}

	io.stdout(
		(await addFetchRefspec(io.cwd))
			? 'origin now fetches chamoji memory.\n'
			: 'origin already fetches chamoji memory.\n',
	);
	// The setup is done and sound; the next sync can do the rest.
	try {
		const {fetched, entries, needsForce} = await pullMemory(io.cwd);
		io.stdout(
			fetched
				? `Took in memory from origin: ${entryCount(entries)}.\n`
				: 'No memory on origin yet.\n',
		);
		if (needsForce) io.stdout(`${FORCE_STEP}\n`);
	} catch (error) {
		if (!(error instanceof MemoryError)) throw error;
		io.stderr(`chamoji: ${stripControlLines(error.message)}\n`);
	}

	return 0;
}

/** Adds the refspec unless it's there. Says whether it was added. */
async function addFetchRefspec(cwd: string): Promise<boolean> {
	if (await fetchesMemory(cwd)) return false;
	await runGit(
		['config', '--add', 'remote.origin.fetch', MEMORY_FETCH_REFSPEC],
		cwd,
	);
	return true;
}

/** A file chamoji will not touch, and why. */
class Refusal extends Error {}

/** What one shared file needs. `apply` edits the parsed file and says whether it changed anything. */
type Merge = {
	file: string;
	added: string;
	present: string;
	apply(data: Record<string, unknown>): boolean;
};

type Plan = {
	file: string;
	path: string;
	/** What to write, or null when the file needs nothing. */
	text: string | null;
	existed: boolean;
	merge: Merge;
};

/** Runs the hook with `command` through `chamoji`, or through `npx` when chamoji isn't installed. */
const runChamoji = (viaNpx: boolean, subcommand: string) =>
	viaNpx ? `npx --yes @chamoji/cli ${subcommand}` : `chamoji ${subcommand}`;

/** `chamoji agent-hook`, `npx --yes @chamoji/cli agent-hook` and the like. */
const RUNS_AGENT_HOOK = /chamoji\S*\s+agent-hook\b/;

/**
 * Merges chamoji into `.mcp.json` and `.claude/settings.json` at the repo
 * root. Both are read and checked before either is written, so a file chamoji
 * refuses leaves the other one alone as well.
 */
async function setUpAgents(io: Io): Promise<number> {
	const root = (await runGit(['rev-parse', '--show-toplevel'], io.cwd)).trim();
	const viaNpx = !onPath('chamoji', io.env ?? process.env);
	let plans: Plan[];
	try {
		plans = [
			await plan(root, mcpServer(viaNpx)),
			await plan(root, commitHook(viaNpx)),
		];
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		io.stderr(
			`chamoji: ${stripControlLines(error.message)} Nothing was changed.\n`,
		);
		return 1;
	}

	let changed = false;
	for (const {file, path: target, text, existed, merge} of plans) {
		if (text === null) {
			io.stdout(`${file}: ${merge.present}\n`);
			continue;
		}

		await mkdir(path.dirname(target), {recursive: true});
		// A new file must be new: `wx` fails if something appeared there since the check.
		await writeFile(target, text, {flag: existed ? 'w' : 'wx'});
		changed = true;
		io.stdout(`${file}: ${merge.added}\n`);
	}

	if (changed) {
		io.stdout(
			`These files are meant to be committed, so everyone who uses Claude Code here gets the same setup.${viaNpx ? ' chamoji is not on your PATH, so they start it with npx.' : ''}\n`,
		);
	}

	return 0;
}

/** The MCP server entry in `.mcp.json`. An entry that is already there is the user's to keep. */
function mcpServer(viaNpx: boolean): Merge {
	return {
		file: '.mcp.json',
		added: 'added the chamoji MCP server',
		present: 'already has the chamoji MCP server',
		apply(data) {
			const servers = section(data, 'mcpServers');
			if (Object.hasOwn(servers, 'chamoji')) return false;
			servers.chamoji = viaNpx
				? {command: 'npx', args: ['--yes', '@chamoji/cli', 'mcp']}
				: {command: 'chamoji', args: ['mcp']};
			return true;
		},
	};
}

/** The PreToolUse entry that sends a `git commit` without a card back to the agent. */
function commitHook(viaNpx: boolean): Merge {
	return {
		file: '.claude/settings.json',
		added: 'added the commit hook',
		present: 'already has the commit hook',
		apply(data) {
			const hooks = section(data, 'hooks');
			if (!Object.hasOwn(hooks, 'PreToolUse')) hooks.PreToolUse = [];
			const list = hooks.PreToolUse;
			if (!Array.isArray(list)) {
				throw new Refusal('a "hooks.PreToolUse" that is not a list');
			}

			const present = list.some(
				entry =>
					isRecord(entry) &&
					Array.isArray(own(entry, 'hooks')) &&
					(own(entry, 'hooks') as unknown[]).some(
						hook =>
							isRecord(hook) &&
							typeof own(hook, 'command') === 'string' &&
							RUNS_AGENT_HOOK.test(own(hook, 'command') as string),
					),
			);
			if (present) return false;
			list.push({
				matcher: 'Bash',
				hooks: [
					{
						type: 'command',
						if: 'Bash(git commit *)',
						command: runChamoji(viaNpx, 'agent-hook'),
					},
				],
			});
			return true;
		},
	};
}

/** The object at `data[key]`, made if it is missing. Refuses anything else. */
function section(
	data: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	if (!Object.hasOwn(data, key)) {
		const created: Record<string, unknown> = {};
		data[key] = created;
		return created;
	}

	const value = data[key];
	if (!isRecord(value)) throw new Refusal(`a "${key}" that is not an object`);
	return value;
}

/**
 * Reads a shared file, merges into it and renders the result, keeping the
 * file's indent, line endings and final newline. `text` is null when nothing
 * changes. Refuses a symlink, a corrupt file and one of an unexpected shape.
 */
async function plan(root: string, merge: Merge): Promise<Plan> {
	const target = path.join(root, ...merge.file.split('/'));
	const refuse = (why: string) =>
		new Refusal(
			`${merge.file} ${why}, so chamoji left it alone. Fix it and run chamoji init --agents again.`,
		);
	// `.claude` could point anywhere; the file in it could too.
	const dir = path.dirname(target);
	if (dir !== root && (await lstat(dir).catch(() => null))?.isSymbolicLink()) {
		throw refuse('is inside a symlinked folder');
	}

	const found = await lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (found?.isSymbolicLink()) throw refuse('is a symlink');
	if (found && !found.isFile()) throw refuse('is not a file');

	const original = found ? await readFile(target, 'utf8') : '';
	const body = original.replace(/^\uFEFF/, '');
	let data: Record<string, unknown> = {};
	if (found) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw refuse('is not valid JSON');
		}

		if (!isRecord(parsed)) throw refuse('is not a JSON object');
		data = parsed;
	}

	const base = {file: merge.file, path: target, existed: found !== null, merge};
	try {
		if (!merge.apply(data)) return {...base, text: null};
	} catch (error) {
		if (error instanceof Refusal) throw refuse(`has ${error.message}`);
		throw error;
	}

	return {...base, text: render(data, original)};
}

/** JSON in the style of `original`: its indent, line endings and final newline. */
function render(data: Record<string, unknown>, original: string): string {
	const indent = /^([ \t]+)\S/m.exec(original)?.[1] ?? '  ';
	let text = JSON.stringify(data, null, indent);
	if (original === '' || /\n\s*$/.test(original)) text += '\n';
	if (original.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
	return original.startsWith('\uFEFF') ? `\uFEFF${text}` : text;
}

/**
 * Whether `name` is an installed command. A `node_modules/.bin` on PATH
 * doesn't count: npx and package scripts add one just for the run, so it says
 * nothing about what the rest of the team has.
 */
function onPath(
	name: string,
	env: Record<string, string | undefined>,
): boolean {
	const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe'] : [''];
	for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
		if (dir === '' || /node_modules[\\/]\.bin$/.test(dir)) continue;
		for (const extension of extensions) {
			const file = path.join(dir, `${name}${extension}`);
			try {
				if (statSync(file).isFile()) {
					accessSync(file, constants.X_OK);
					return true;
				}
			} catch {
				// Not here.
			}
		}
	}

	return false;
}
