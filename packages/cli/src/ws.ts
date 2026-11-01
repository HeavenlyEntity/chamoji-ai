import {
	addWorkstream,
	assertGitRepo,
	getActive,
	listReleaseTags,
	parseCommit,
	readCommits,
	readWorkstreams,
	runGit,
	setActive,
	setWorkstreamStatus,
	WORKSTREAMS_FILE,
	WorkstreamError,
	type Workstream,
	type WorkstreamStatus,
} from '@chamoji/core';
import {readHookState} from './hook.js';
import type {Io} from './run.js';
import {stripControl} from './text.js';

/** Same code run.ts uses for a command that was used wrongly. */
const USAGE_ERROR = 2;

/**
 * `chamoji ws`: `input` is what follows `ws`. Problems with the workstreams
 * themselves throw a WorkstreamError, which run.ts reports and exits 1 for;
 * misuse of the command is reported here and exits 2, as `hook` does.
 * None of it touches the network, and none of it commits.
 */
export async function runWorkstream(
	input: string[],
	flags: {json?: boolean; none?: boolean},
	io: Io,
): Promise<number> {
	const [command = 'list', ...args] = input;
	// Every subcommand reads git: say so plainly, not with a raw git error.
	await assertGitRepo(io.cwd);
	switch (command) {
		case 'list': {
			return list(io, flags.json ?? false);
		}

		case 'start': {
			return start(io, args);
		}

		case 'switch': {
			return switchTo(io, args[0], flags.none ?? false);
		}

		case 'ship': {
			return finish(io, 'ship', 'shipped', args[0]);
		}

		case 'drop': {
			return finish(io, 'drop', 'dropped', args[0]);
		}

		default: {
			return usage(
				io,
				`ws needs start, switch, list, ship or drop, not "${command}"`,
			);
		}
	}
}

function usage(io: Io, message: string): number {
	io.stderr(`chamoji: ${message}\n`);
	return USAGE_ERROR;
}

async function start(io: Io, args: string[]): Promise<number> {
	const [title, emoji, ...extra] = args;
	if (title === undefined || title.trim() === '') {
		return usage(
			io,
			'ws start needs a title: chamoji ws start <title> [emoji]',
		);
	}

	// "ws start Auth revamp" would otherwise make "revamp" the emoji.
	if (extra.length > 0 || (emoji !== undefined && /\p{L}/u.test(emoji))) {
		return usage(
			io,
			'ws start takes a title and an optional emoji; quote a title of several words: chamoji ws start "Auth revamp" 🔐',
		);
	}

	const {slug} = await addWorkstream(io.cwd, {
		title,
		...(emoji === undefined ? {} : {emoji}),
	});
	await setActive(io.cwd, slug);
	io.stdout(staged('Started', slug));
	await reportStamping(io, slug);
	return 0;
}

/** Says what will stamp new commits, which only `installed` can promise. */
async function reportStamping(io: Io, slug: string): Promise<void> {
	const trailer = `"Workstream: ${slug}"`;
	switch (await readHookState(io.cwd)) {
		case 'installed': {
			io.stdout(`New commits in this worktree get ${trailer}.\n`);
			break;
		}

		case 'missing': {
			io.stderr(
				`chamoji: no hook runs chamoji here, so \`git commit\` won't add ${trailer}. Run \`chamoji hook install\`, or commit with \`chamoji commit\`.\n`,
			);
			break;
		}

		case 'unknown': {
			io.stderr(
				`chamoji: there's a prepare-commit-msg hook here, but chamoji can't tell whether it runs \`chamoji hook run\`. \`git commit\` adds ${trailer} only if it does; \`chamoji hook install\` shows how to add it.\n`,
			);
			break;
		}
	}
}

async function switchTo(
	io: Io,
	slug: string | undefined,
	none: boolean,
): Promise<number> {
	if (none) {
		if (slug !== undefined) {
			return usage(io, 'ws switch needs a slug or --none, not both');
		}

		await setActive(io.cwd, null);
		io.stdout('No active workstream now.\n');
		return 0;
	}

	if (slug === undefined) {
		return usage(io, 'ws switch needs a slug or --none');
	}

	const found = (await readWorkstreams(io.cwd)).find(
		item => item.slug === slug,
	);
	if (!found) {
		throw new WorkstreamError(`No workstream named "${slug}"`);
	}

	if (found.status !== 'active') {
		throw new WorkstreamError(
			`${slug} is ${found.status}, so it can't be made active`,
		);
	}

	await setActive(io.cwd, slug);
	io.stdout(`Switched to ${slug}.\n`);
	await reportStamping(io, slug);
	return 0;
}

/** `ship` and `drop`: set the status, stage the file, and stop stamping it. */
async function finish(
	io: Io,
	verb: 'ship' | 'drop',
	status: WorkstreamStatus,
	given: string | undefined,
): Promise<number> {
	const active = await getActive(io.cwd);
	const slug = given ?? active;
	if (slug === null) {
		throw new WorkstreamError(
			`no active workstream; name one: chamoji ws ${verb} <slug>`,
		);
	}

	await setWorkstreamStatus(io.cwd, slug, status);
	if (slug === active) await setActive(io.cwd, null);
	io.stdout(staged(status === 'shipped' ? 'Shipped' : 'Dropped', slug));
	return 0;
}

function staged(did: string, slug: string): string {
	return `${did} ${slug}. Staged ${WORKSTREAMS_FILE}; your next commit records it.\n`;
}

async function list(io: Io, json: boolean): Promise<number> {
	const workstreams = await readWorkstreams(io.cwd);
	const active = workstreams.length > 0 ? await getActive(io.cwd) : null;
	const counts =
		workstreams.length > 0
			? await unreleasedCounts(io.cwd)
			: new Map<string, number>();
	const rows = workstreams.map(item => ({
		...item,
		active: item.slug === active,
		commits: counts.get(item.slug) ?? 0,
	}));
	if (json) {
		io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
	} else if (rows.length === 0) {
		io.stdout(
			'No workstreams yet. Start one with: chamoji ws start <title> [emoji]\n',
		);
	} else {
		const slugWidth = Math.max(...rows.map(row => row.slug.length));
		const statusWidth = Math.max(...rows.map(row => row.status.length));
		const labels = rows.map(row => label(row));
		const labelWidth = Math.max(...labels.map(text => columns(text)));
		for (const [index, row] of rows.entries()) {
			const text = labels[index] ?? '';
			const pad = ' '.repeat(labelWidth - columns(text));
			io.stdout(
				`${row.active ? '*' : ' '} ${row.slug.padEnd(slugWidth)}  ${row.status.padEnd(statusWidth)}  ${text}${pad}  ${row.commits} ${row.commits === 1 ? 'commit' : 'commits'}\n`,
			);
		}
	}

	return 0;
}

/**
 * How many terminal columns `text` takes, for padding: emoji and CJK are two
 * wide, and joiners, marks and variation selectors take none. An estimate that
 * handles what titles hold, without a width library.
 */
function columns(text: string): number {
	const WIDE =
		/[\p{Emoji_Presentation}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
	let width = 0;
	let narrowPictograph = false;
	let joined = false;
	for (const char of text) {
		if (char === '‍') {
			joined = true; // The next emoji is part of this one.
		} else if (joined) {
			joined = false;
		} else if (char === '️') {
			// Emoji style makes a text symbol such as ♻ two wide.
			if (narrowPictograph) width += 1;
			narrowPictograph = false;
		} else if (/\p{M}/u.test(char)) {
			narrowPictograph = false;
		} else if (WIDE.test(char)) {
			width += 2;
			narrowPictograph = false;
		} else {
			width += 1;
			narrowPictograph = /\p{Extended_Pictographic}/u.test(char);
		}
	}

	return width;
}

/** Title and emoji come from a file a clone can write, so no control characters. */
function label({emoji, title}: Workstream): string {
	const text = `${emoji ? `${emoji} ` : ''}${title}`;
	return stripControl(text);
}

/**
 * Commits per workstream on the current branch since the latest tag: the
 * unreleased ones, so it's the same count a changelog would show.
 */
async function unreleasedCounts(cwd: string): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	try {
		await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd);
	} catch {
		return counts; // No commits yet.
	}

	const [latest] = await listReleaseTags(cwd, 'HEAD');
	const commits = await readCommits(
		cwd,
		latest ? `${latest.name}..HEAD` : 'HEAD',
	);
	for (const commit of commits.map(raw => parseCommit(raw))) {
		if (commit.workstream) {
			counts.set(commit.workstream, (counts.get(commit.workstream) ?? 0) + 1);
		}
	}

	return counts;
}
