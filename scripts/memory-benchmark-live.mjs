#!/usr/bin/env node
// What real Claude Code sessions spend answering questions about this repo,
// with chamoji set up and without it. It asks the questions in
// scripts/memory-benchmark/questions.json three times on each side, in two
// throwaway clones of this repo at HEAD: one after `chamoji init --agents`,
// with the built CLI on PATH, and one plain. Both sides get the same
// read-only tools; the "with" side also gets chamoji's commands and MCP
// tools, and its session hook hands each session the brief. It records what
// each session reported (tokens, turns, tool calls) and the answer, and
// never judges an answer: a person checks them against the keys later.
//
//   pnpm benchmark:memory:live             30 sessions; writes docs/benchmarks/memory-tokens-live.json
//   pnpm benchmark:memory:live --dry-run   the first question once on each side; writes nothing
//
// It needs `claude` on PATH and signed in, and it spends usage.
import {execFile, execFileSync} from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {assertFullHistory, isolatedGitEnv} from './lib/memory-measure.mjs';
import {summarize} from './lib/memory-tokens.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const QUESTIONS_FILE = path.join(
	root,
	'scripts/memory-benchmark/questions.json',
);
const LIVE_FILE = 'docs/benchmarks/memory-tokens-live.json';
const MODEL = 'claude-sonnet-5-5';
const RUNS_PER_QUESTION = 3;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const PROMPT_SUFFIX =
	'Answer in at most three sentences, and name the commit or rule you relied on if you can.';
// What the debug log says when the session hook handed the session the brief.
const BRIEF_LINE =
	'Hook SessionStart (chamoji agent-hook || true) provided additionalContext';
// The same read-only tools on both sides; nothing that edits or writes.
const BUILT_IN_TOOLS = 'Read,Grep,Glob,Bash';
const SHARED_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(git *)'];
const WITH_ALLOWED = ['Bash(chamoji *)', 'mcp__chamoji'];
// The input fields of the result's usage that are summed into input tokens.
const INPUT_FIELDS = [
	'input_tokens',
	'cache_creation_input_tokens',
	'cache_read_input_tokens',
];

/**
 * The first file called `name` in a PATH folder, found without `which` so it
 * works the same on Windows, where PATHEXT names the extensions to try.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function findOnPath(name, env = process.env) {
	const pathValue =
		Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ??
		'';
	const extensions =
		process.platform === 'win32'
			? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
					.split(';')
					.filter(Boolean)
					.map(extension => extension.toLowerCase())
			: [''];
	for (const folder of pathValue.split(path.delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const candidate = path.join(folder, name + extension);
			if (existsSync(candidate)) return candidate;
		}
	}

	return null;
}

/**
 * The environment the sessions run in: git's settings isolated as in the
 * replay, and none of the variables that describe whatever Claude Code
 * session started this script, so each session starts as one from a
 * terminal would. Sign-in and provider variables are kept.
 * @param {string | null} shim a folder to put first on PATH, or null
 */
function sessionEnv(shim) {
	const keep = /^CLAUDE_(CONFIG_DIR|CODE_OAUTH_TOKEN|CODE_USE_[A-Z]+)$/;
	/** @type {NodeJS.ProcessEnv} */
	const env = {};
	for (const [name, value] of Object.entries(isolatedGitEnv())) {
		if (/^(CLAUDE|MCP_)/.test(name) && !keep.test(name)) continue;
		env[name] = value;
	}

	if (shim) {
		const key =
			Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
		env[key] = [shim, env[key]].filter(Boolean).join(path.delimiter);
	}

	return env;
}

/** @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} [env] */
const git = (args, cwd, env = isolatedGitEnv()) =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env,
		maxBuffer: 512 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

/**
 * A plain clone of `checkout` at `commit`, with its origin removed so nothing
 * a session runs can reach the checkout. `memory` also fetches the memory and
 * notes refs, which the brief is built from.
 * @param {string} checkout @param {string} commit @param {string} dir
 * @param {{memory: boolean}} options
 */
function makeClone(checkout, commit, dir, {memory}) {
	git(['clone', '--quiet', '--no-checkout', checkout, dir], path.dirname(dir));
	if (memory) {
		git(
			[
				'fetch',
				'--quiet',
				'origin',
				'refs/chamoji/*:refs/chamoji/*',
				'refs/notes/*:refs/notes/*',
			],
			dir,
		);
	}

	git(['checkout', '--quiet', '--detach', commit], dir);
}

/**
 * A folder holding a `chamoji` launcher that runs the built CLI with this
 * Node, for the "with" side's PATH.
 * @param {string} folder
 */
function writeShim(folder) {
	mkdirSync(folder, {recursive: true});
	const unix = path.join(folder, 'chamoji');
	writeFileSync(unix, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
	chmodSync(unix, 0o755);
	writeFileSync(
		path.join(folder, 'chamoji.cmd'),
		`@"${process.execPath}" "${cli}" %*\r\n`,
	);
}

/**
 * The flags for one session. Both sides get the same ones, except that the
 * "with" side also loads chamoji's MCP server and may run chamoji.
 * @param {{prompt: string, debugFile: string, mcpConfig: string | null}} input
 */
function claudeArgs({prompt, debugFile, mcpConfig}) {
	return [
		'-p',
		prompt,
		'--model',
		MODEL,
		'--output-format',
		'json',
		'--debug-file',
		debugFile,
		'--setting-sources',
		'project,local',
		'--strict-mcp-config',
		...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
		'--no-session-persistence',
		'--permission-prompts',
		'none',
		'--tools',
		BUILT_IN_TOOLS,
		'--allowedTools',
		...SHARED_ALLOWED,
		...(mcpConfig ? WITH_ALLOWED : []),
	];
}

/**
 * The tool calls a session made: the distinct tool use ids its debug log
 * shows being dispatched. A call that was denied is never dispatched; the
 * result counts those as permission denials.
 * @param {string} debug
 */
function countToolCalls(debug) {
	const ids = new Set();
	for (const match of debug.matchAll(
		/tool_dispatch_start tool=\S+ toolUseId=(\S+)/g,
	)) {
		ids.add(match[1]);
	}

	return ids.size;
}

/**
 * One session, run to the end. It never throws: a failure is recorded as an
 * error with its text and no figures.
 * @param {{claude: string, cwd: string, env: NodeJS.ProcessEnv, prompt: string, debugFile: string, mcpConfig: string | null}} input
 * @returns {Promise<{record: Record<string, unknown>, debug: string, raw: string}>}
 */
function runSession({claude, cwd, env, prompt, debugFile, mcpConfig}) {
	const args = claudeArgs({prompt, debugFile, mcpConfig});
	return new Promise(resolve => {
		execFile(
			claude,
			args,
			{
				cwd,
				env,
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
				timeout: RUN_TIMEOUT_MS,
			},
			(error, stdout, stderr) => {
				const debug = existsSync(debugFile)
					? readFileSync(debugFile, 'utf8')
					: '';
				const fail = (/** @type {string} */ text) =>
					resolve({record: {error: text}, debug, raw: stdout});
				/** @type {any} */
				let result;
				try {
					result = JSON.parse(stdout);
				} catch {
					fail(
						(error?.message ?? 'The session printed no result.') +
							(stderr ? `\n${stderr.trim()}` : ''),
					);
					return;
				}

				if (error || result.is_error || result.subtype !== 'success') {
					fail(
						`${result.subtype ?? 'error'}: ${String(result.result ?? error?.message ?? '').trim()}`,
					);
					return;
				}

				const usage = result.usage ?? {};
				resolve({
					record: {
						inputTokens: INPUT_FIELDS.reduce(
							(sum, field) => sum + (usage[field] ?? 0),
							0,
						),
						outputTokens: usage.output_tokens ?? 0,
						turns: result.num_turns,
						toolCalls: countToolCalls(debug),
						costUsd: result.total_cost_usd,
						permissionDenials: (result.permission_denials ?? []).length,
						models: Object.keys(result.modelUsage ?? {}),
						answer: String(result.result ?? '').trim(),
					},
					debug,
					raw: stdout,
				});
			},
		);
	});
}

/** @param {number} n */
const oneDecimal = n => Math.round(n * 10) / 10;

/**
 * Per side: how many runs, how many failed, and each figure summarized over
 * the runs that didn't fail, to 1 decimal.
 * @param {Array<Record<string, any>>} runs
 */
function summarizeSide(runs) {
	const answered = runs.filter(run => !run.error);
	/** @param {string} key */
	const figures = key => {
		const {mean, median, min, max} = summarize(answered.map(run => run[key]));
		return {
			mean: oneDecimal(mean),
			median: oneDecimal(median),
			min: oneDecimal(min),
			max: oneDecimal(max),
		};
	};
	return {
		runs: runs.length,
		errors: runs.length - answered.length,
		inputTokens: figures('inputTokens'),
		outputTokens: figures('outputTokens'),
		turns: figures('turns'),
		toolCalls: figures('toolCalls'),
	};
}

/** @param {string[]} args */
function parseArgs(args) {
	let dryRun = false;
	for (const arg of args) {
		if (arg === '--dry-run') dryRun = true;
		else return {error: `Unknown option ${arg}.`};
	}

	return {dryRun};
}

/** @param {string} text @param {string} indent */
const indented = (text, indent = '    ') =>
	text
		.split('\n')
		.map(line => indent + line)
		.join('\n');

async function main() {
	const claude = findOnPath('claude');
	if (!claude) {
		console.error('claude is not on PATH, so the live sample was not run.');
		return 2;
	}

	if (!existsSync(cli)) {
		console.error('Run pnpm build first.');
		return 2;
	}

	const options = parseArgs(process.argv.slice(2));
	if ('error' in options) {
		console.error(
			`${options.error} Usage: pnpm benchmark:memory:live [--dry-run]`,
		);
		return 2;
	}

	/** @type {Array<{question: string, rule: string, key: string}>} */
	const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));
	const checkout = git(['rev-parse', '--show-toplevel'], root).trim();
	try {
		assertFullHistory(checkout);
	} catch (error) {
		console.error(/** @type {Error} */ (error).message);
		return 2;
	}

	const commit = git(['rev-parse', 'HEAD'], checkout).trim();
	// Every session has exited by the time this folder is removed: they run
	// one at a time and each is awaited.
	const scratch = mkdtempSync(path.join(tmpdir(), 'chamoji-memory-live-'));
	try {
		const shim = path.join(scratch, 'bin');
		const logs = path.join(scratch, 'logs');
		const withDir = path.join(scratch, 'with');
		const withoutDir = path.join(scratch, 'without');
		mkdirSync(logs);
		writeShim(shim);
		const withEnv = sessionEnv(shim);
		const withoutEnv = sessionEnv(null);

		makeClone(checkout, commit, withDir, {memory: true});
		execFileSync(
			process.execPath,
			[cli, 'init', '--agents', '--no-update-check'],
			{cwd: withDir, env: withEnv, stdio: ['ignore', 'pipe', 'pipe']},
		);
		makeClone(checkout, commit, withoutDir, {memory: false});
		for (const dir of [withDir, withoutDir]) {
			git(['remote', 'remove', 'origin'], dir);
		}

		const settings = readFileSync(
			path.join(withDir, '.claude', 'settings.json'),
			'utf8',
		);
		if (!settings.includes('"chamoji agent-hook || true"')) {
			console.error(
				'chamoji init --agents did not write a hook that runs chamoji from PATH, so the live sample was not run.',
			);
			return 1;
		}

		const brief = JSON.parse(
			execFileSync(
				process.execPath,
				[cli, 'memory', 'brief', '--json', '--no-update-check'],
				{cwd: withDir, env: withEnv, encoding: 'utf8'},
			),
		);
		const ids = new Set(brief.lines.map((/** @type {any} */ l) => l.id));
		const missing = questions.find(q => !ids.has(q.rule));
		if (missing) {
			console.error(
				`The rule ${missing.rule} in scripts/memory-benchmark/questions.json is not in this repo's brief, so the live sample was not run.`,
			);
			return 2;
		}

		const mcpConfig = path.join(withDir, '.mcp.json');
		let count = 0;
		/**
		 * @param {'with' | 'without'} side
		 * @param {number} question index into questions
		 */
		const ask = (side, question) => {
			count++;
			return runSession({
				claude,
				cwd: side === 'with' ? withDir : withoutDir,
				env: side === 'with' ? withEnv : withoutEnv,
				prompt: `${questions[question].question} ${PROMPT_SUFFIX}`,
				debugFile: path.join(logs, `${count}-${side}.txt`),
				mcpConfig: side === 'with' ? mcpConfig : null,
			});
		};

		// One session on the "with" side first, to see the hook hand over the
		// brief. If it doesn't, the comparison would be meaningless.
		console.error('Checking that the session hook hands over the brief.');
		const check = await ask('with', 0);
		const briefArrived = check.debug.includes(BRIEF_LINE);
		const mcpLines = check.debug
			.split('\n')
			.filter(line => /MCP server "chamoji"/.test(line));

		if (options.dryRun) {
			const other = await ask('without', 0);
			console.log(`Dry run at ${commit.slice(0, 7)} with ${MODEL}.`);
			console.log(`claude: ${claude}`);
			console.log(
				`The brief ${briefArrived ? 'arrived' : 'did not arrive'} on the "with" side.`,
			);
			for (const line of check.debug
				.split('\n')
				.filter(line => line.includes('Hook SessionStart'))) {
				console.log(`  ${line}`);
			}

			console.log('chamoji MCP server, from the debug log:');
			for (const line of mcpLines) console.log(`  ${line}`);
			for (const [side, session] of /** @type {const} */ ([
				['with', check],
				['without', other],
			])) {
				console.log(
					`\n${side}: claude ${claudeArgs({
						prompt: '<prompt>',
						debugFile: '<debug file>',
						mcpConfig: side === 'with' ? '<clone>/.mcp.json' : null,
					})
						.map(arg => (/\s|[()*]/.test(arg) ? JSON.stringify(arg) : arg))
						.join(' ')}`,
				);
				console.log(JSON.stringify(session.record, null, '\t'));
				console.log('  raw result:');
				console.log(indented(session.raw.trim()));
			}

			console.log(`\nKey: ${questions[0].key}`);
			console.log('\nNothing was written.');
			return 0;
		}

		if (!briefArrived) {
			console.error(
				`The debug log of the check session has no "${BRIEF_LINE}" line, so the session hook did not hand over the brief, and the live sample was not run.`,
			);
			return 1;
		}

		/** @type {Array<Record<string, unknown>>} */
		const runs = [];
		const total = questions.length * RUNS_PER_QUESTION * 2;
		for (let question = 0; question < questions.length; question++) {
			for (let run = 1; run <= RUNS_PER_QUESTION; run++) {
				for (const side of /** @type {const} */ (['with', 'without'])) {
					console.error(
						`Question ${question + 1}, run ${run}, ${side} chamoji (${runs.length + 1} of ${total})`,
					);
					const session = await ask(side, question);
					runs.push({
						question: question + 1,
						side,
						run,
						...(side === 'with'
							? {briefArrived: session.debug.includes(BRIEF_LINE)}
							: {}),
						...session.record,
						correct: null,
					});
				}
			}
		}

		const live = {
			version: 1,
			model: MODEL,
			date: new Date().toISOString().slice(0, 10),
			commit,
			method: {
				claudeVersion: execFileSync(claude, ['--version'], {
					encoding: 'utf8',
				}).trim(),
				runsPerQuestion: RUNS_PER_QUESTION,
				promptSuffix: PROMPT_SUFFIX,
				inputTokens: `the sum of usage.${INPUT_FIELDS.join(', usage.')} in the --output-format json result`,
				outputTokens: 'usage.output_tokens',
				turns: 'num_turns',
				toolCalls:
					'the distinct toolUseId values on "tool_dispatch_start" lines in the --debug-file log',
				models: 'the keys of modelUsage',
				costUsd: 'total_cost_usd',
				flags: {
					both: claudeArgs({
						prompt: '<prompt>',
						debugFile: '<debug file>',
						mcpConfig: null,
					}).slice(2),
					withOnly: ['--mcp-config', '<clone>/.mcp.json', ...WITH_ALLOWED],
				},
			},
			questions,
			runs,
			summary: {
				with: summarizeSide(runs.filter(run => run.side === 'with')),
				without: summarizeSide(runs.filter(run => run.side === 'without')),
			},
			checked: false,
		};

		console.log('\nAnswers, beside their keys:');
		questions.forEach((q, index) => {
			console.log(`\n${index + 1}. ${q.question}\n   Key: ${q.key}`);
			for (const run of runs.filter(r => r.question === index + 1)) {
				const text = run.error
					? `failed: ${run.error}`
					: /** @type {string} */ (run.answer);
				console.log(`   ${run.side} ${run.run}:`);
				console.log(indented(text, '      '));
			}
		});

		const file = path.join(checkout, ...LIVE_FILE.split('/'));
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(file, `${JSON.stringify(live, null, '\t')}\n`);
		console.log(
			`\nWrote ${LIVE_FILE}. Mark each run's "correct" against its key and set "checked" to true, then run pnpm benchmark:memory --write.`,
		);
		return 0;
	} finally {
		rmSync(scratch, {recursive: true, force: true});
	}
}

process.exitCode = await main();
