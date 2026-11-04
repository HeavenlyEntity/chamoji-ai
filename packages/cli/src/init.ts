import {accessSync, constants, statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
	MEMORY_FETCH_REFSPEC,
	MemoryError,
	assertGitRepo,
	fetchesMemory,
	hasOrigin,
	inexactNumber,
	pullMemory,
	renderJsonText,
	runGit,
} from '@chamoji/core';
import {isRecord, own} from './agent-hook.js';
import {gitStep, NO_FACE} from './face.js';
import {entryCount, FORCE_STEP} from './memory.js';
import type {Io} from './run.js';
import {stripControlLines} from './text.js';

/** A plain fetch only downloads memory into a side ref; `memory` reads the local one. */
const SYNC_NOTE =
	"A plain git fetch or git pull downloads origin's memory but doesn't change what chamoji memory shows. Run chamoji memory sync to take it in and share yours.\n";

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

	return setUpMemory(io);
}

/**
 * The memory step: makes origin fetch chamoji memory and takes in what it
 * has. Without an origin it says so and changes nothing. `chamoji init` and
 * `chamoji setup memory` both run it.
 */
export async function setUpMemory(io: Io): Promise<number> {
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
	io.stdout(SYNC_NOTE);
	// The setup is done and sound; the next sync can do the rest.
	try {
		const {fetched, entries, needsForce} = await gitStep(
			io.face ?? NO_FACE,
			io.cwd,
			"Taking in origin's memory",
			async env => pullMemory(io.cwd, {env}),
			pulled =>
				pulled.needsForce
					? {
							outcome: 'warn',
							text: 'A purged entry is still on origin',
						}
					: {
							outcome: 'ok',
							text: pulled.fetched
								? `Took in memory from origin: ${entryCount(pulled.entries)}`
								: 'No memory on origin yet',
						},
		);
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
	/** Permissions of the file being replaced, to carry over. */
	mode?: number;
	merge: Merge;
};

/**
 * The command a shared file runs: `chamoji`, or `npx` when chamoji isn't
 * installed. The `|| true` is for a chamoji that is older than the command:
 * it prints help and exits 2, which Claude Code reads as "block this", and the
 * file is committed, so that would block every commit. A denial is JSON on
 * stdout with exit 0, so it still gets through.
 */
const runChamoji = (viaNpx: boolean, subcommand: string) =>
	`${viaNpx ? 'npx --yes @chamoji/cli' : 'chamoji'} ${subcommand} || true`;

/** `chamoji agent-hook`, `npx --yes @chamoji/cli agent-hook` and the like. */
const RUNS_AGENT_HOOK = /chamoji\S*\s+agent-hook\b/;

/** The shared files the agents step merges into, relative to the repo root. */
export const AGENT_FILES = ['.mcp.json', '.claude/settings.json'] as const;

/** The plan for each shared file; throws a Refusal for a file chamoji won't touch. */
async function agentPlans(io: Io): Promise<{plans: Plan[]; viaNpx: boolean}> {
	const root = (await runGit(['rev-parse', '--show-toplevel'], io.cwd)).trim();
	const viaNpx = !onPath('chamoji', io.env ?? process.env);
	return {
		plans: [
			await plan(root, mcpServer(viaNpx)),
			await plan(root, commitHook(viaNpx)),
		],
		viaNpx,
	};
}

/** Whether both shared files already have chamoji. A file chamoji refuses counts as not. */
export async function agentsConnected(io: Io): Promise<boolean> {
	try {
		const {plans} = await agentPlans(io);
		return plans.every(each => each.text === null);
	} catch (error) {
		if (error instanceof Refusal) return false;
		throw error;
	}
}

/**
 * The agents step: merges chamoji into `.mcp.json` and `.claude/settings.json`
 * at the repo root. Both are read and checked before either is written, so a
 * file chamoji refuses leaves the other one alone as well. `chamoji init
 * --agents` and `chamoji setup agents` both run it.
 */
export async function setUpAgents(io: Io): Promise<number> {
	let plans: Plan[];
	let viaNpx: boolean;
	try {
		({plans, viaNpx} = await agentPlans(io));
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		io.stderr(
			`chamoji: ${stripControlLines(error.message)} Nothing was changed.\n`,
		);
		return 1;
	}

	const changed: string[] = [];
	for (const {file, path: target, text, mode, merge} of plans) {
		if (text === null) {
			io.stdout(`${file}: ${merge.present}\n`);
			continue;
		}

		try {
			await writeAtomically(target, text, mode);
		} catch (error) {
			io.stderr(
				`chamoji: couldn't write ${file} (${stripControlLines((error as Error).message)}). ${
					changed.length > 0
						? `${changed.join(' and ')} was already changed; run chamoji init --agents again once this is fixed.`
						: 'Nothing was changed.'
				}\n`,
			);
			return 1;
		}

		changed.push(file);
		io.stdout(`${file}: ${merge.added}\n`);
	}

	if (changed.length > 0) {
		io.stdout(
			`These files are meant to be committed, so everyone who uses Claude Code here gets the same setup. A changed file is written back as plain JSON with its indent kept, so other layout, such as blank lines or how short lists wrap, may differ.${viaNpx ? ' chamoji is not on your PATH, so they start it with npx.' : ''}\n`,
		);
	}

	return 0;
}

/**
 * Writes `text` to a temp file beside `target` and renames it into place, so
 * a failure never leaves a half-written shared file. A new file takes the
 * default permissions; a replaced one keeps its own. The temp file starts
 * owner-only, since a settings file can hold secrets, and gets its final
 * permissions just before the rename. Setuid and the like are not carried over.
 */
async function writeAtomically(
	target: string,
	text: string,
	mode: number | undefined,
): Promise<void> {
	const dir = path.dirname(target);
	await mkdir(dir, {recursive: true});
	const temp = path.join(
		dir,
		`.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
	);
	try {
		await writeFile(temp, text, {flag: 'wx', mode: 0o600});
		await chmod(temp, (mode ?? 0o666 & ~process.umask()) & 0o777);
		await rename(temp, target);
	} catch (error) {
		await rm(temp, {force: true});
		throw error;
	}
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
	if (dir !== root) {
		const folder = await lstat(dir).catch(() => null);
		if (folder?.isSymbolicLink()) throw refuse('is inside a symlinked folder');
		if (folder && !folder.isDirectory()) {
			throw refuse(
				`needs ${path.basename(dir)} to be a folder, but it is something else`,
			);
		}
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
	// An empty file is as good as `{}`.
	if (found && body.trim() !== '') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw refuse('is not valid JSON');
		}

		if (!isRecord(parsed)) throw refuse('is not a JSON object');
		data = parsed;
	}

	const base = {
		file: merge.file,
		path: target,
		existed: found !== null,
		...(found ? {mode: found.mode} : {}),
		merge,
	};
	try {
		if (!merge.apply(data)) return {...base, text: null};
	} catch (error) {
		if (error instanceof Refusal) throw refuse(`has ${error.message}`);
		throw error;
	}

	// Writing the file back must not change a value in it.
	const lost = inexactNumber(body);
	if (lost !== undefined) {
		throw refuse(`has the number ${lost}, which can't be written back exactly`);
	}

	return {...base, text: renderJsonText(data, original)};
}

/**
 * Whether `name` is an installed command. A `node_modules/.bin` on PATH
 * doesn't count: npx and package scripts add one just for the run, so it says
 * nothing about what the rest of the team has.
 */
export function onPath(
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
