// What an agent reads to recover a project's context, with chamoji and with
// git alone, measured in one repo. Each function takes the repo to read and,
// where it runs chamoji, the built CLI; each returns sizes, never the text.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {estimateTokens} from './memory-tokens.mjs';

/**
 * @typedef {{chars: number, tokens: number}} Size
 * @typedef {{commit: string, file: string, line: number, text: string}} SampleLine
 */

/**
 * A global git config that reads as empty on every OS: git skips a config
 * file that isn't there, and nothing can be there, since the path runs
 * through this module, which is a file. /dev/null doesn't exist on Windows,
 * and an empty file would need a temp folder to clean up.
 */
const NO_GLOBAL_CONFIG = path.join(
	fileURLToPath(import.meta.url),
	'no-global-gitconfig',
);

/**
 * Every git and chamoji call goes through here. Git reads no system config
 * and an empty global one, so settings on the machine that runs this, such as
 * format.pretty or diff.noprefix, can't change a figure.
 * @param {string} command @param {string[]} args @param {string} cwd
 */
const run = (command, args, cwd) =>
	execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: NO_GLOBAL_CONFIG,
		},
		maxBuffer: 512 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

/** @param {string} repo @param {string[]} args */
const git = (repo, args) => run('git', args, repo);

/** @param {string} repo @param {string} cli @param {string[]} args */
const chamoji = (repo, cli, args) =>
	run(process.execPath, [cli, ...args, '--no-update-check'], repo);

/** @param {string} text @returns {Size} */
const size = text => ({chars: text.length, tokens: estimateTokens(text)});

/** How a card line's kind is written in a commit message. */
const KIND_NAMES = /** @type {Record<string, string>} */ ({
	constraint: 'Constraint',
	gotcha: 'Gotcha',
	followUp: 'Follow-up',
});

/**
 * Throws an Error whose message starts "This clone is shallow" when the repo is shallow.
 * @param {string} repo
 */
export function assertFullHistory(repo) {
	if (git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
		throw new Error(
			'This clone is shallow, so its history is cut short. Fetch the full history first: git fetch --unshallow',
		);
	}
}

/**
 * @param {string} repo
 * @param {string} cli
 * @returns {{brief: Size, log: Size, notesFile: Size, cardLines: number, commits: number}}
 */
export function measureWhatStands(repo, cli) {
	const brief = chamoji(repo, cli, ['memory', 'brief']);
	/** @type {{lines: Array<{kind: string, text: string}>}} */
	const {lines} = JSON.parse(chamoji(repo, cli, ['memory', 'brief', '--json']));
	const notesFile = lines
		.map(({kind, text}) => {
			const name = KIND_NAMES[kind];
			if (!name) throw new Error(`Unknown card line kind: ${kind}`);
			return `${name}: ${text}`;
		})
		.join('\n');
	const log = git(repo, ['log', '--no-color']);
	return {
		brief: size(brief),
		log: size(log),
		notesFile: size(notesFile),
		cardLines: lines.length,
		commits: Number(git(repo, ['rev-list', '--count', 'HEAD']).trim()),
	};
}

/**
 * Each line of a file in the working copy with the commit that last wrote it,
 * as `chamoji why` blames it: following moves and ignoring whitespace changes.
 * @param {string} repo
 * @param {string} file
 * @returns {Array<{commit: string, text: string}>} line n at index n - 1
 */
function blameFile(repo, file) {
	const out = git(repo, ['blame', '--line-porcelain', '-w', '-M', '--', file]);
	const lines = [];
	/** @type {string | undefined} */
	let commit;
	for (const row of out.split('\n')) {
		if (row.startsWith('\t')) {
			lines.push({commit: commit ?? '', text: row.slice(1)});
			commit = undefined;
		} else if (commit === undefined) {
			// A header row: "<hash> <original line> <final line> [<count>]".
			commit = row.split(' ')[0];
		}
	}

	return lines;
}

/**
 * Tracked files with text in them: git leaves out binary and empty files.
 * @param {string} repo
 * @returns {string[]} sorted by path
 */
function textFiles(repo) {
	let out;
	try {
		out = git(repo, ['grep', '-I', '-l', '-z', '-e', '']);
	} catch (error) {
		// git grep exits 1 when nothing matches.
		if (/** @type {{status?: number}} */ (error).status === 1) return [];
		throw error;
	}

	return out
		.split('\0')
		.filter(Boolean)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Whether `chamoji why --json` gives the line a card from the commit blame
 * found for it. When why names another commit, the line is not a candidate.
 * @param {string} repo @param {string} cli @param {string} location @param {string} commit
 */
function hasCard(repo, cli, location, commit) {
	/** @type {{commit?: {hash?: string}, card?: Record<string, string[]>}} */
	const reply = JSON.parse(chamoji(repo, cli, ['why', location, '--json']));
	if (reply.commit?.hash !== commit) return false;
	return Object.values(reply.card ?? {}).some(
		values => Array.isArray(values) && values.length > 0,
	);
}

/**
 * Lines whose commit carries a card and still has a line at HEAD: one per commit, the first such line by path then line number.
 * @param {string} repo
 * @param {string} cli
 * @returns {SampleLine[]}
 */
export function sampleCandidates(repo, cli) {
	/** @type {Map<string, SampleLine>} */
	const firstLines = new Map();
	for (const file of textFiles(repo)) {
		blameFile(repo, file).forEach(({commit, text}, index) => {
			if (/^0+$/.test(commit) || firstLines.has(commit)) return;
			firstLines.set(commit, {commit, file, line: index + 1, text});
		});
	}

	return [...firstLines.values()].filter(({commit, file, line}) =>
		hasCard(repo, cli, `${file}:${line}`, commit),
	);
}

/**
 * Finds each sample line again by commit and text. A line is the same when
 * blame still gives its commit at its line number; otherwise the first line in
 * the file with the same text and commit; otherwise it is dropped.
 * @param {string} repo
 * @param {SampleLine[]} sample
 * @returns {{found: SampleLine[], dropped: SampleLine[]}}
 */
export function locateSample(repo, sample) {
	/** @type {Map<string, Array<{commit: string, text: string}>>} */
	const blames = new Map();
	/** @type {SampleLine[]} */
	const found = [];
	/** @type {SampleLine[]} */
	const dropped = [];
	for (const entry of sample) {
		if (!existsSync(path.join(repo, ...entry.file.split('/')))) {
			dropped.push(entry);
			continue;
		}

		let blame = blames.get(entry.file);
		if (!blame) {
			blame = blameFile(repo, entry.file);
			blames.set(entry.file, blame);
		}

		const index =
			blame[entry.line - 1]?.commit === entry.commit
				? entry.line - 1
				: blame.findIndex(
						({commit, text}) => commit === entry.commit && text === entry.text,
					);
		if (index === -1) dropped.push(entry);
		else found.push({...entry, line: index + 1});
	}

	return {found, dropped};
}

/**
 * Tokens for one line: the card chamoji gives, the commit git blame names
 * shown in full, and the history of the whole file.
 * @param {string} repo
 * @param {string} cli
 * @param {{file: string, line: number}} line
 * @returns {{location: string, commit: string, card: number, blameShow: number, fileHistory: number}}
 */
export function measureWhy(repo, cli, {file, line}) {
	const location = `${file}:${line}`;
	const blame = git(repo, [
		'blame',
		'--porcelain',
		'-w',
		'-M',
		'-L',
		`${line},${line}`,
		'--',
		file,
	]);
	const commit = blame.split(' ')[0];
	return {
		location,
		commit,
		card: estimateTokens(chamoji(repo, cli, ['why', location])),
		blameShow: estimateTokens(git(repo, ['show', '--no-color', commit])),
		fileHistory: measureFileHistory(repo, file),
	};
}

/**
 * `git log -p -- <file>` in tokens.
 * @param {string} repo
 * @param {string} file
 * @returns {number}
 */
export function measureFileHistory(repo, file) {
	return estimateTokens(git(repo, ['log', '-p', '--no-color', '--', file]));
}
