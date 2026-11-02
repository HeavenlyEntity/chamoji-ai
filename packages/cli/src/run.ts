import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	applyRelease,
	buildChangelog,
	CARD_ENDPOINT,
	cardUrl,
	fetchesMemory,
	getActive,
	getRemoteWebUrl,
	hasMessageContent,
	listMemory,
	loadComposeConfig,
	loadConfig,
	openJudgmentCache,
	readStagedChanges,
	planRelease,
	pushRelease,
	ReleaseError,
	render,
	repoStats,
	runGit,
	shouldPrompt,
	shouldStamp,
	stampWorkstream,
	syncMemory,
	type CommitClassifier,
	type ComposeConfig,
	type OutputFormat,
	type ReadyPlan,
} from '@chamoji/core';
import {TypeSafeClient} from '@typesafe-ai/sdk';
import meow from 'meow';
import {
	createCommitAdvisor,
	type Advice,
	type AdvisorClient,
} from './advisor.js';
import {compose} from './composer.js';
import {MISSING_KEY, readTypesafeKey} from './env.js';
import {HookError, installHook, uninstallHook} from './hook.js';
import {createJevClassifier, JUDGMENT_VERSION} from './jev-classifier.js';
import {runInit} from './init.js';
import {runMcp} from './mcp.js';
import {runMemory, syncSummary} from './memory.js';
import {jevReranker, type MemoryReranker, type RerankClient} from './rerank.js';
import {stripControlLines} from './text.js';
import {openTerminal} from './tty.js';
import type {UpdateCheck} from './update-check.js';
import {runWhy} from './why.js';
import {runWorkstream} from './ws.js';

export type Io = {
	cwd: string;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** `YYYY-MM-DD` used for `--release`; defaults to today. */
	today?: string;
	/** Newer-version notice; cli.ts passes the real one, tests a fake or none. */
	updateCheck?: UpdateCheck;
	/** Runs the GitHub CLI for `release --push`; tests pass a fake. */
	gh?: GhRunner;
	/** `release` fetches tags from origin first; tests turn it off. Default true. */
	fetchTags?: boolean;
	/** The terminal the composer runs on, or null when there is none; tests pass a fake. */
	terminal?: () => ComposerTerminal | null;
	/** Environment for the hook's CI check; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Jev's commit advice; tests pass a fake. Defaults to the TypeSafe API. */
	advise?: ReturnType<typeof createCommitAdvisor>;
	/** Jev's `memory search --ai` reorder; tests pass a fake. Defaults to the TypeSafe API. */
	rerank?: MemoryReranker;
};

export type ComposerTerminal = {
	compose(
		config: ComposeConfig,
		advice?: Promise<Advice | null>,
	): Promise<string | null>;
	close(): void;
};

const realTerminal = (): ComposerTerminal | null => {
	const terminal = openTerminal();
	return terminal
		? {
				compose: async (config, advice) => compose(config, terminal, advice),
				close: () => terminal.close(),
			}
		: null;
};

export type GhRunner = (
	args: string[],
) => Promise<{ok: boolean; message: string}>;

/** The GitHub CLI, without a shell. Missing `gh` is a soft failure. */
const runGh: GhRunner = async args =>
	new Promise(resolve => {
		execFile('gh', args, (error, stdout, stderr) => {
			if (!error) {
				resolve({ok: true, message: stdout.trim()});
			} else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				resolve({ok: false, message: 'no gh CLI, so no GitHub release'});
			} else {
				resolve({ok: false, message: stderr.trim() || error.message});
			}
		});
	});

const HELP = `
	Usage
	  $ chamoji changelog [options]    Generate a changelog from git history
	  $ chamoji next-version [options] Print the next semver version
	                                   (exits 3 when no release is needed)
	  $ chamoji release [version]      Cut a release: CHANGELOG.md, version
	                                   bumps, release commit and tag
	  $ chamoji commit [-a]            Write a commit with the composer
	                                   (-a commits all tracked changes)
	  $ chamoji hook install           Offer the composer on a plain
	                                   \`git commit\` (uninstall to remove)
	  $ chamoji card [options]         Print the URL of the repo's card image
	  $ chamoji ws                     List workstreams with their unreleased
	                                   commits (* marks the active one)
	  $ chamoji ws start <title> [emoji]
	                                   Start a workstream and make it active
	  $ chamoji ws switch <slug>       Make a workstream active
	  $ chamoji ws ship [slug]         Mark one shipped (default: the active one)
	  $ chamoji ws drop [slug]         Mark one dropped
	  $ chamoji why <file:line>        Show why a line is there: the commit
	                                   that wrote it and the Why, Constraint,
	                                   Gotcha and Follow-up it recorded
	  $ chamoji memory                 List what shipped or dropped workstreams
	                                   left in memory (refs/chamoji/memory)
	  $ chamoji memory show <slug>     Show one entry with its commits and cards
	  $ chamoji memory search <query>  Find commits and workstreams by what they
	                                   say, Why and Gotcha lines included
	  $ chamoji memory reindex         Rebuild the search index
	  $ chamoji memory archive <slug>  Hide an entry from the list and keep it
	                                   (--purge deletes it for good)
	  $ chamoji memory sync            Merge memory with origin and push it
	  $ chamoji mcp                    Serve project memory to AI agents over
	                                   MCP (stdio): search_memory, why and
	                                   workstream, all read-only
	  $ chamoji init                   Set this clone up to share memory, and
	                                   take in what origin has

	Options
	  --format   markdown (default), md, json or html
	  --output   Write to this file instead of stdout
	  --from     Leave out this release tag and everything older
	  --to       Ref to treat as the head of history (default: HEAD)
	  --release  Name the unreleased section with this version
	  --since    Only the commits after this ref, as one section (for
	             previewing a branch: --since origin/main)
	  --config   Config file (default: chamoji.config.json if present)
	  --ai       Sort commits no rule can place with Jev (TypeSafe).
	             Needs TYPESAFE_API_KEY, from the environment or from
	             .env.local / .env here. Sends up to 300 characters of
	             each such commit's subject and body, with emails and
	             trailer lines removed; never diffs, code or authors.
	             memory search: Jev reorders the ten best matches.
	             It sees the query and, per match, up to 300 characters of
	             the subject and card text, with emails removed.
	             mcp: the same reorder, for the search_memory tool.
	  --dry-run  release: show the version and notes, change nothing
	  --push     release: push HEAD and the tag, sync memory if chamoji init
	             ran here, then create the GitHub release when the gh CLI
	             is installed
	  --trailer  release: add "Key: value" to the release commit (repeatable)
	  --any-branch
	             release: allow a branch other than origin's default
	  --json     release: print the result as JSON; card: print the numbers;
	             ws list: print the workstreams as an array;
	             why: print the blame result; memory list and show: print
	             the entries; memory search: print the matches;
	             memory sync: print the result
	  --none     ws switch: clear the active workstream
	  --purge    memory archive: delete the entry and its history instead;
	             a remote needs a force-push to lose it too
	  --repo     card: owner/name on GitHub (default: from the origin remote)
	  --endpoint card: the card renderer (default: https://chamoji.dev/api/card)
	  --no-update-check
	             Don't check npm for a newer chamoji. Also off in CI, when
	             NO_UPDATE_NOTIFIER or CHAMOJI_NO_UPDATE_CHECK=1 is set,
	             and when stderr isn't a terminal.

	Examples
	  $ chamoji changelog --output CHANGELOG.md
	  $ version=$(chamoji next-version) && chamoji changelog --release "$version" -o CHANGELOG.md
	  $ chamoji changelog --format html --output changelog.html
	  $ chamoji release --dry-run
	  $ chamoji release 2.0.0-rc.1 --push
`;

export const NO_RELEASE_NEEDED = 3;

const FORMATS: Record<string, OutputFormat> = {
	markdown: 'markdown',
	md: 'markdown',
	json: 'json',
	html: 'html',
};

export async function run(argv: string[], io: Io): Promise<number> {
	const cli = meow(HELP, {
		importMeta: import.meta,
		argv,
		autoHelp: false,
		autoVersion: false,
		flags: {
			format: {type: 'string', default: 'markdown'},
			output: {type: 'string', shortFlag: 'o'},
			from: {type: 'string'},
			to: {type: 'string', default: 'HEAD'},
			release: {type: 'string'},
			since: {type: 'string'},
			config: {type: 'string'},
			ai: {type: 'boolean'},
			updateCheck: {type: 'boolean', default: true},
			dryRun: {type: 'boolean'},
			push: {type: 'boolean'},
			trailer: {type: 'string', isMultiple: true},
			anyBranch: {type: 'boolean'},
			json: {type: 'boolean'},
			none: {type: 'boolean'},
			purge: {type: 'boolean'},
			repo: {type: 'string'},
			endpoint: {type: 'string'},
			all: {type: 'boolean', shortFlag: 'a'},
			help: {type: 'boolean', shortFlag: 'h'},
			version: {type: 'boolean', shortFlag: 'v'},
		},
	});
	const {flags} = cli;

	if (flags.help) {
		io.stdout(`${cli.help}\n`);
		return 0;
	}

	if (flags.version) {
		io.stdout(`${cli.pkg.version ?? 'unknown'}\n`);
		return 0;
	}

	// The refresh runs detached and the notice comes from the cache, so the
	// check never delays the command or touches stdout.
	const check =
		flags.updateCheck && cli.input[0] !== 'hook' && cli.input[0] !== 'mcp'
			? io.updateCheck
			: undefined;
	check?.refreshIfStale();
	const code = await execute(cli.input[0]);
	const notice = check?.notice();
	if (notice) {
		io.stderr(`\n${notice}\n`);
	}

	return code;

	async function execute(command: string | undefined): Promise<number> {
		try {
			// card ignores --ai: it counts what the rules sort and sends nothing out.
			// memory search and mcp have their own use for it, and ask for their key
			// themselves.
			const classify =
				flags.ai &&
				command !== 'card' &&
				command !== 'memory' &&
				command !== 'mcp'
					? await jevClassifier(io)
					: undefined;
			switch (command) {
				case 'changelog': {
					const format = Object.hasOwn(FORMATS, flags.format)
						? FORMATS[flags.format]
						: undefined;
					if (!format) {
						throw new Error(
							`Unknown format "${flags.format}" (use markdown, json or html)`,
						);
					}

					const changelog = await buildChangelog({
						cwd: io.cwd,
						config: await loadConfig(io.cwd, flags.config),
						to: flags.to,
						from: flags.from,
						release: flags.release,
						since: flags.since,
						today: io.today,
						classify,
					});
					const output = render(changelog, format);
					if (flags.output) {
						await writeFile(path.resolve(io.cwd, flags.output), output);
						io.stderr(`Wrote ${flags.output}\n`);
					} else {
						io.stdout(output);
					}

					return 0;
				}

				case 'next-version': {
					const {releases} = await buildChangelog({
						cwd: io.cwd,
						config: await loadConfig(io.cwd, flags.config),
						to: flags.to,
						classify,
						classifyReleases: 'unreleased',
					});
					const next = releases.find(
						release => release.tag === null,
					)?.nextVersion;
					if (!next) {
						// Non-zero and silent on stdout, so `$(chamoji next-version)` in a
						// release script stops instead of producing a release called "none".
						io.stderr(
							'chamoji: no release needed (no commits since the last tag imply a version bump)\n',
						);
						return NO_RELEASE_NEEDED;
					}

					io.stdout(`${next}\n`);
					return 0;
				}

				case 'release': {
					return await release(cli.input[1], classify);
				}

				case 'hook': {
					return await hook(cli.input[1]);
				}

				case 'commit': {
					return await commit();
				}

				case 'card': {
					return await card();
				}

				case 'ws': {
					return await runWorkstream(cli.input.slice(1), flags, io);
				}

				case 'why': {
					return await runWhy(cli.input.slice(1), flags, io);
				}

				case 'memory': {
					return await runMemory(cli.input.slice(1), flags, io, async () =>
						realReranker(io),
					);
				}

				case 'mcp': {
					if (cli.input.length > 1) {
						io.stderr('chamoji: mcp takes no arguments: chamoji mcp [--ai]\n');
						return 2;
					}

					return await runMcp(flags, {...io, stdin: process.stdin}, async () =>
						realReranker(io),
					);
				}

				case 'init': {
					return await runInit({}, io);
				}

				default: {
					io.stderr(
						`${command ? `chamoji: unknown command "${command}"\n` : ''}${cli.help}\n`,
					);
					return 2;
				}
			}
		} catch (error) {
			// Git's errors can carry what a remote or a hook printed.
			io.stderr(`chamoji: ${stripControlLines((error as Error).message)}\n`);
			return error instanceof ReleaseError ? PREFLIGHT_FAILED : 1;
		}
	}

	async function card(): Promise<number> {
		const endpoint = flags.endpoint ?? CARD_ENDPOINT;
		if (!/^https?:\/\/[^\s/]/i.test(endpoint) || !URL.canParse(endpoint)) {
			throw new Error(`--endpoint "${endpoint}" is not an http(s) URL`);
		}

		const repo = flags.repo ?? (await githubRepo(io.cwd));
		if (!repo) {
			throw new Error("can't tell the repo; pass --repo owner/name");
		}

		const stats = repoStats(
			await buildChangelog({
				cwd: io.cwd,
				config: await loadConfig(io.cwd, flags.config),
				to: flags.to,
				today: io.today,
			}),
		);
		io.stdout(
			flags.json
				? `${JSON.stringify({repo, ...stats}, null, 2)}\n`
				: `${cardUrl(endpoint, repo, stats)}\n`,
		);
		return 0;
	}

	async function commit(): Promise<number> {
		const root = (
			await runGit(['rev-parse', '--show-toplevel'], io.cwd)
		).trim();
		const config = await loadComposeConfig(root);
		const terminal = (io.terminal ?? realTerminal)();
		if (!terminal) {
			io.stderr(
				'chamoji: commit needs a terminal to ask on; in scripts, use git commit -m\n',
			);
			return PREFLIGHT_FAILED;
		}

		const advice = adviceFor(root, await readAiSettings(root), '');
		let message: string | null;
		try {
			message = await terminal.compose(config, advice);
		} finally {
			terminal.close();
		}

		if (message === null) {
			io.stderr('Cancelled; nothing was committed.\n');
			return 1;
		}

		const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-commit-'));
		const file = path.join(dir, 'COMMIT_EDITMSG');
		try {
			await writeFile(file, `${message}\n`);
			try {
				const gitDir = (
					await runGit(['rev-parse', '--absolute-git-dir'], io.cwd)
				).trim();
				// `git commit -F` keeps `#` lines like -m does.
				await stamp(file, gitDir, 'message');
			} catch (error) {
				io.stderr(
					`chamoji: not stamped with a workstream (${(error as Error).message})\n`,
				);
			}

			// gitmoji-cli's autoAdd stages everything, as `git add .` does.
			if (config.autoAdd) await runGit(['add', '--all'], io.cwd);
			io.stdout(
				await runGit(
					['commit', '-F', file, ...(flags.all ? ['--all'] : [])],
					io.cwd,
				),
			);
			return 0;
		} catch (error) {
			const {stdout = '', stderr = ''} = error as {
				stdout?: string;
				stderr?: string;
			};
			io.stderr(`${`${stdout}${stderr}`.trim() || (error as Error).message}\n`);
			return 1;
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	}

	/**
	 * What the installed prepare-commit-msg hook runs. It opens the composer
	 * only when shouldPrompt says so, stamps the active workstream on the
	 * message, and always exits 0 with the message file unchanged when
	 * anything goes wrong, so it never blocks a commit.
	 */
	async function runHook(
		file: string | undefined,
		source: string | undefined,
	): Promise<number> {
		if (!file) return 0;
		let terminal: ComposerTerminal | null = null;
		try {
			const messageFile = path.resolve(io.cwd, file);
			const original = await readFile(messageFile, 'utf8');
			const gitDir = (
				await runGit(['rev-parse', '--absolute-git-dir'], io.cwd)
			).trim();
			terminal = (io.terminal ?? realTerminal)();
			const decision = shouldPrompt({
				source,
				message: original,
				isTTY: terminal !== null,
				env: io.env ?? process.env,
				rebasing: anyExists(gitDir, REBASE_MARKERS),
			});
			const composed =
				decision.prompt && terminal
					? await composeInto(messageFile, original, terminal)
					: false;
			// A message the composer wrote is real, whatever git's source was.
			await stamp(messageFile, gitDir, composed ? undefined : source);
			return 0;
		} catch (error) {
			io.stderr(`chamoji: hook skipped (${(error as Error).message})\n`);
			return 0;
		} finally {
			terminal?.close();
		}
	}

	/**
	 * Replaces the message in `messageFile` with a composed one. Returns
	 * whether there was one to write (false when the composer was cancelled).
	 */
	async function composeInto(
		messageFile: string,
		original: string,
		terminal: ComposerTerminal,
	): Promise<boolean> {
		const root = (
			await runGit(['rev-parse', '--show-toplevel'], io.cwd)
		).trim();
		const advice = adviceFor(
			root,
			await readAiSettings(root),
			original.split('\n').find(line => line.trim() && !line.startsWith('#')) ??
				'',
		);
		const message = await terminal.compose(
			await loadComposeConfig(root),
			advice,
		);
		if (message === null) return false;

		// Keep git's comment lines, such as the list of changes, below the message.
		const comments = original.split('\n').filter(line => line.startsWith('#'));
		await writeFile(
			messageFile,
			`${message}\n${comments.length > 0 ? `\n${comments.join('\n')}\n` : ''}`,
		);
		return true;
	}

	/**
	 * Adds the active workstream's trailer to the message in `file`. The hook
	 * must never turn a commit git would abort into one that goes through, so
	 * it leaves alone a message that git or the user already settled (a merge,
	 * an amend, a cherry-pick or revert), an unedited `commit.template`, and a
	 * message with no content yet (stampWorkstream checks that): a trailer
	 * there would count as the message. Editor commits that miss out that way
	 * get a one-line notice. Throws when the workstreams file is corrupt;
	 * callers decide how to carry on.
	 */
	async function stamp(
		file: string,
		gitDir: string,
		source: string | undefined,
	): Promise<void> {
		// Most repos have no active workstream: this is one stat, no git, no parsing.
		if (!existsSync(path.join(gitDir, 'chamoji', 'active'))) return;
		if (anyExists(gitDir, [...REBASE_MARKERS, ...SEQUENCE_MARKERS])) return;
		if (!shouldStamp({source, rebasing: false})) {
			if (source === 'template') await noticeUnstamped();
			return;
		}

		const message = await readFile(file, 'utf8');
		// A clean `git revert` leaves no REVERT_HEAD and says it's a plain -m
		// message, so its generated subject is the only sign of it.
		if (/^(?:Revert|Reapply) "/.test(message)) return;
		if (
			(await stampWorkstream(io.cwd, file, source)) === null &&
			source === undefined &&
			!(await hasMessageContent(io.cwd, message))
		) {
			await noticeUnstamped();
		}
	}

	/** Said when an editor commit is left unstamped because its message isn't written yet. */
	async function noticeUnstamped(): Promise<void> {
		const slug = await getActive(io.cwd);
		if (slug !== null) {
			io.stderr(
				`chamoji: editor commits aren't stamped; add "Workstream: ${slug}" to the message, or use -m or chamoji commit.\n`,
			);
		}
	}

	/**
	 * Jev's advice on the staged change, when the user turned it on in git
	 * config and there's a key; otherwise undefined. It's never awaited here:
	 * the composer shows it if it arrives in time, and any failure just means
	 * no advice.
	 */
	function adviceFor(
		root: string,
		settings: AiSettings,
		draft: string,
	): Promise<Advice | null> | undefined {
		if (!settings.composer) return undefined;
		const {sendDiffs} = settings;
		return (async () => {
			const advise = io.advise ?? (await realAdvisor(root));
			if (!advise) return null;
			const staged = await readStagedChanges(root, {sendDiffs});
			if (staged.files.length === 0) return null;
			return advise({staged, draft});
		})().catch(() => null);
	}

	async function hook(action: string | undefined): Promise<number> {
		switch (action) {
			case 'install': {
				try {
					const result = await installHook(io.cwd);
					if (result.status === 'snippet') {
						io.stdout(
							`core.hooksPath is ${result.hooksPath}, so chamoji didn't write a hook there. ${result.snippet}\n`,
						);
					} else {
						const what =
							result.replaced === 'gitmoji'
								? "Replaced gitmoji-cli's hook"
								: result.replaced === 'chamoji'
									? 'Updated the hook'
									: 'Installed the hook';
						io.stdout(
							`${what}: ${result.path}\nA plain \`git commit\` now opens the composer; -m, merges, amends and rebases are left alone.\n`,
						);
					}

					return 0;
				} catch (error) {
					if (error instanceof HookError) {
						io.stderr(`chamoji: ${error.message}\n`);
						return PREFLIGHT_FAILED;
					}

					throw error;
				}
			}

			case 'run': {
				return runHook(cli.input[2], cli.input[3]);
			}

			case 'uninstall': {
				const removed = await uninstallHook(io.cwd);
				io.stdout(
					removed
						? 'Removed the chamoji hook.\n'
						: 'There was no chamoji hook to remove.\n',
				);
				return 0;
			}

			default: {
				io.stderr(
					`chamoji: hook needs install, uninstall or run${action ? `, not "${action}"` : ''}\n`,
				);
				return PREFLIGHT_FAILED;
			}
		}
	}

	async function release(
		version: string | undefined,
		classify: CommitClassifier | undefined,
	): Promise<number> {
		const plan = await planRelease({
			cwd: io.cwd,
			config: await loadConfig(io.cwd, flags.config),
			...(version === undefined ? {} : {version}),
			anyBranch: flags.anyBranch,
			fetch: io.fetchTags ?? true,
			allowDirty: flags.dryRun,
			today: io.today,
			classify,
		});
		const print = (lines: string[], json: Record<string, unknown>) => {
			io.stdout(
				flags.json
					? `${JSON.stringify(json, null, 2)}\n`
					: `${lines.join('\n')}\n`,
			);
		};

		if (plan.status === 'nothing') {
			print(
				[
					`Nothing to release: no commit since ${plan.lastTag} implies a version bump.`,
					...(plan.unreleased.length > 0
						? [
								'Unreleased commits:',
								...plan.unreleased.map(subject => `- ${subject}`),
							]
						: ['No commits since that tag.']),
				],
				{status: 'nothing', lastTag: plan.lastTag, unreleased: plan.unreleased},
			);
			return NO_RELEASE_NEEDED;
		}

		const summary = `${plan.tag} (${describeBump(plan)})`;
		const files = plan.changes.map(change => change.file);
		if (flags.dryRun) {
			print(
				[
					`Would release ${summary}.`,
					`files: ${files.join(', ')}`,
					...plan.warnings.map(warning => `warning: ${warning}`),
					'',
					plan.notes,
				],
				{status: 'dry-run', ...facts(plan, files), notes: plan.notes},
			);
			return 0;
		}

		const {commit} = await applyRelease(plan, {trailers: flags.trailer});
		let pushed: string = `no; to ship: git push origin HEAD ${plan.tag}`;
		let pushError: string | undefined;
		let githubRelease = false;
		let memory: string | undefined;
		if (flags.push) {
			try {
				await pushRelease(plan);
				pushed = `yes (HEAD and ${plan.tag})`;
				memory = await syncAfterRelease();
				const notesFile = path.join(
					(await runGit(['rev-parse', '--absolute-git-dir'], plan.root)).trim(),
					'chamoji-release-notes.md',
				);
				await writeFile(notesFile, `${plan.notes}\n`);
				const result = await (io.gh ?? runGh)([
					'release',
					'create',
					plan.tag,
					'--title',
					plan.tag,
					'--notes-file',
					notesFile,
					...(plan.bump === 'prerelease' ? ['--prerelease'] : []),
				]);
				githubRelease = result.ok;
				pushed += result.ok
					? '; GitHub release created'
					: `; GitHub release not created: ${stripControlLines(result.message)}`;
			} catch (error) {
				pushError = stripControlLines((error as Error).message);
				pushed = `failed: ${pushError}`;
			}
		}

		const [changelog, ...manifests] = plan.changes;
		print(
			[
				`Released ${summary}.`,
				`changelog: ${changelog!.file}, ${changelog!.how}`,
				`bumped: ${manifests.map(change => change.file).join(', ') || 'no manifest carried the old version'}`,
				`commit: ${commit} ${plan.subject}`,
				`tag: ${plan.tag} (annotated)`,
				`pushed: ${pushed}`,
				...(memory === undefined ? [] : [`memory: ${memory}`]),
				...plan.warnings.map(warning => `warning: ${warning}`),
				...(githubRelease || pushed.startsWith('yes')
					? []
					: [
							`undo before pushing: git tag -d ${plan.tag} && git reset --hard ${plan.start.slice(0, 7)}`,
						]),
				'',
				plan.notes,
			],
			{
				status: 'released',
				...facts(plan, files),
				commit,
				pushed: pushed.startsWith('yes'),
				githubRelease,
				...(pushError ? {error: pushError} : {}),
				...(memory === undefined ? {} : {memory}),
				notes: plan.notes,
			},
		);
		return pushError ? 1 : 0;
	}

	/**
	 * Syncs only a clone that opted in with `chamoji init`, and otherwise says
	 * how to, if there's anything to share. The release is out by now, so a
	 * problem here is only ever reported.
	 */
	async function syncAfterRelease(): Promise<string | undefined> {
		try {
			if (await fetchesMemory(io.cwd)) {
				return syncSummary(await syncMemory(io.cwd));
			}

			const entries = await listMemory(io.cwd, {archived: true});
			return entries.length > 0
				? 'not synced; run chamoji init to share it with origin'
				: undefined;
		} catch (error) {
			return `not synced: ${stripControlLines((error as Error).message)}`;
		}
	}
}

/** Exit code for a release check that failed before anything changed. */
export const PREFLIGHT_FAILED = 2;

/** Files in the git dir that say a rebase is running. */
const REBASE_MARKERS = ['rebase-merge', 'rebase-apply'];

/**
 * Files in the git dir that say a cherry-pick, revert or merge is waiting for
 * its commit. A `-m` commit that concludes one of them reaches the hook as a
 * plain message, so only these tell it apart; shouldPrompt doesn't use them.
 */
const SEQUENCE_MARKERS = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD'];

function anyExists(gitDir: string, names: string[]): boolean {
	return names.some(name => existsSync(path.join(gitDir, name)));
}

function describeBump(plan: ReadyPlan): string {
	if (plan.bump === 'first') {
		return 'first release';
	}

	return plan.lastTag ? `${plan.bump}, from ${plan.lastTag}` : plan.bump;
}

function facts(plan: ReadyPlan, files: string[]) {
	return {
		version: plan.version,
		tag: plan.tag,
		bump: plan.bump,
		from: plan.lastTag,
		files,
		warnings: plan.warnings,
	};
}

/** `owner/name` from an origin on github.com, or undefined for anywhere else. */
async function githubRepo(cwd: string): Promise<string | undefined> {
	const url = await getRemoteWebUrl(cwd);
	return /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url ?? '')?.[1];
}

export type AiSettings = {composer: boolean; sendDiffs: boolean};

/**
 * The composer's AI opt-ins, from git config (`chamoji.composer`,
 * `chamoji.sendDiffs`), never from files in the repository: a cloned repo
 * must not be able to switch on sending your changes anywhere.
 */
async function readAiSettings(cwd: string): Promise<AiSettings> {
	const flag = async (key: string) =>
		(
			await runGit(['config', '--type=bool', '--get', key], cwd).catch(() => '')
		).trim() === 'true';
	return {
		composer: await flag('chamoji.composer'),
		sendDiffs: await flag('chamoji.sendDiffs'),
	};
}

/**
 * The commit advisor on the TypeSafe API, or null without a key. The key
 * comes from the environment, or a .env file git doesn't track.
 */
async function realAdvisor(
	cwd: string,
): Promise<ReturnType<typeof createCommitAdvisor> | null> {
	const key = await readTypesafeKey(cwd, process.env, {untrackedOnly: true});
	if (!key || /[^\x21-\x7E]/.test(key)) return null;
	const client = new TypeSafeClient({apiKey: key});
	return createCommitAdvisor({
		// The advisor asks only choice and noul questions, so box answers never come back.
		systemOne: async request =>
			(await client.systemOne(
				request as Parameters<typeof client.systemOne>[0],
			)) as unknown as Awaited<ReturnType<AdvisorClient['systemOne']>>,
	});
}

/**
 * The TypeSafe client, or undefined without a key. A key that can't go in a
 * header throws. With `untrackedOnly`, a key from a file git tracks is not used.
 */
async function typesafeClient(
	io: Io,
	options: {untrackedOnly?: boolean} = {},
): Promise<TypeSafeClient | undefined> {
	const key = await readTypesafeKey(io.cwd, process.env, options);
	if (!key) return undefined;
	// Keys copied from a dashboard often end in "…"; headers can't carry it.
	const invalid = /[^\x21-\x7E]/.exec(key);
	if (invalid) {
		throw new Error(
			invalid[0] === '\u2026'
				? 'TYPESAFE_API_KEY contains "…", so it looks truncated; copy the full key again'
				: 'TYPESAFE_API_KEY contains a character that is not plain ASCII; copy the full key again',
		);
	}

	return new TypeSafeClient({apiKey: key});
}

/**
 * `memory search --ai`'s reorder on the TypeSafe API, or undefined without a
 * key. It sends what a repository's commits say, so a tracked `.env` can't
 * supply the key: a cloned repo could name someone else's account.
 */
async function realReranker(io: Io): Promise<MemoryReranker | undefined> {
	if (io.rerank) return io.rerank;
	const client = await typesafeClient(io, {untrackedOnly: true});
	if (!client) return undefined;
	return jevReranker(
		{
			// The rerank asks only score questions.
			systemOne: async request =>
				(await client.systemOne(
					request as Parameters<typeof client.systemOne>[0],
				)) as unknown as Awaited<ReturnType<RerankClient['systemOne']>>,
		},
		{report: line => io.stderr(`${line}\n`)},
	);
}

async function jevClassifier(io: Io): Promise<CommitClassifier> {
	const client = await typesafeClient(io);
	if (!client) throw new Error(MISSING_KEY);
	// Outside a repository there's nowhere to keep judgments, so none are cached.
	const cache = await openJudgmentCache(io.cwd, JUDGMENT_VERSION).catch(
		() => undefined,
	);
	return createJevClassifier(
		{systemOne: async request => client.systemOne(request)},
		{report: line => io.stderr(`${line}\n`), cache},
	);
}
