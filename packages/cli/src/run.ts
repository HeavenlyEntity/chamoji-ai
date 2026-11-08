import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
	applyRelease,
	applyUnitReleases,
	buildChangelog,
	catchUp,
	CARD_ENDPOINT,
	cardUrl,
	checkPublishAuth,
	committedSection,
	ConfigVersionError,
	fetchesMemory,
	getActive,
	hasMessageContent,
	isAuthFailure,
	discardPublishPlan,
	listMemory,
	loadComposeConfig,
	loadConfig,
	mask,
	openJudgmentCache,
	readStagedChanges,
	planPublish,
	planRelease,
	planUnitReleases,
	processEnv,
	publishMethod,
	pushRelease,
	pushUnitReleases,
	quietGitEnv,
	readWorkspace,
	ReleaseError,
	restoreChanges,
	render,
	repoStats,
	requireNpm,
	resolveUnits,
	runGit,
	runNpm,
	runPublish,
	scrubEnv,
	shouldPrompt,
	shouldStamp,
	stampWorkstream,
	syncMemory,
	stripTitle,
	uniqueTags,
	unitChangelog,
	unitTagHistory,
	writeChanges,
	type CatchUpResult,
	type ChamojiConfig,
	type CommitClassifier,
	type ComposeConfig,
	type FetchLike,
	type FileChange,
	type NpmRunner,
	type OutputFormat,
	type PublishMethod,
	type PublishOutcome,
	type PublishPlan,
	type PublishTarget,
	type ReadyPlan,
	type ReadyUnitPlan,
	type ReleaseOptions,
	type UnitPending,
	type UnitPlan,
	type WrittenChanges,
} from '@chamoji/core';
import {TypeSafeClient} from '@typesafe-ai/sdk';
import meow from 'meow';
import semver from 'semver';
import {runAgentHook} from './agent-hook.js';
import {
	createCommitAdvisor,
	type Advice,
	type AdvisorClient,
} from './advisor.js';
import {compose, type Impact} from './composer.js';
import {MISSING_KEY, readTypesafeKey} from './env.js';
import {gitStep, NO_FACE, runStep, type Face, type Step} from './face.js';
import {hasFace} from './face-settings.js';
import type {Theme} from './foil.js';
import {uninstallHook} from './hook.js';
import {
	createJevClassifier,
	jevFace,
	JUDGMENT_VERSION,
	type JevClassifierOptions,
	type JevClient,
} from './jev-classifier.js';
import {runInit} from './init.js';
import {githubRepo, runSetup, type SetupScreen} from './setup/setup.js';
import {isStepName, nothingSetUp, setUpHook} from './setup/steps.js';
import {runMcp} from './mcp.js';
import {
	relabel,
	runMemory,
	SYNC_LABEL,
	syncOutcome,
	syncSummary,
} from './memory.js';
import {jevReranker, type MemoryReranker, type RerankClient} from './rerank.js';
import {stripControlLines} from './text.js';
import {openTerminal} from './tty.js';
import type {UpdateCheck} from './update-check.js';
import {composeImpact} from './impact.js';
import {oneLineLogo, playWelcome, SHORT_HELP, TAGLINE} from './welcome.js';
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
	/** Runs npm for `publish`; tests pass a fake. Defaults to the real npm. */
	npm?: NpmRunner;
	/** Fetches for the OIDC check of `publish`; tests pass a fake. Defaults to global fetch. */
	fetch?: FetchLike;
	/** The terminal the composer runs on, or null when there is none; tests pass a fake. */
	terminal?: () => ComposerTerminal | null;
	/** Environment for the hook's CI check; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Jev's commit sorting for --ai; tests pass a fake. Defaults to the TypeSafe API. */
	jev?: JevClient;
	/** Jev's commit advice; tests pass a fake. Defaults to the TypeSafe API. */
	advise?: ReturnType<typeof createCommitAdvisor>;
	/** Jev's `memory search --ai` reorder; tests pass a fake. Defaults to the TypeSafe API. */
	rerank?: MemoryReranker;
	/**
	 * The loading face on stderr. cli.ts builds one only when it may animate,
	 * and passes stdout and stderr through its `wrap`. Without one, nothing is
	 * drawn and the output is what it always was.
	 */
	face?: Face;
	/**
	 * How the wordmark and the logo draw, for bare `chamoji` and `--help`. cli.ts
	 * builds it from the terminal. Without one, they print plain, with no escape
	 * codes: the shades frame, or the one-line logo on a narrow screen.
	 */
	welcome?: WelcomeSettings;
	/**
	 * The interactive `chamoji setup` screen, on stderr. Setup calls it only
	 * when stderr is a terminal and there's no --yes or --json; without it,
	 * setup says what it would do and exits 2. cli.ts passes the real one.
	 */
	setupScreen?: SetupScreen;
};

export type WelcomeSettings = {
	animate: boolean;
	level: 0 | 1 | 2 | 3;
	theme: Theme;
	ascii: boolean;
	columns: number;
};

const PLAIN_WELCOME: WelcomeSettings = {
	animate: false,
	level: 0,
	theme: 'dark',
	ascii: false,
	columns: 80,
};

export type ComposerTerminal = {
	compose(
		config: ComposeConfig,
		advice?: Promise<Advice | null>,
		impact?: Impact,
	): Promise<string | null>;
	close(): void;
};

const realTerminal = (): ComposerTerminal | null => {
	const terminal = openTerminal();
	return terminal
		? {
				compose: async (config, advice, impact) =>
					compose(config, terminal, advice, impact),
				close: () => terminal.close(),
			}
		: null;
};

export type GhRunner = (
	args: string[],
	/** `timeoutMs` kills gh after that long; the run then fails softly. */
	options?: {timeoutMs?: number},
) => Promise<{ok: boolean; message: string}>;

/** The GitHub CLI, without a shell. Missing `gh` is a soft failure. */
const runGh: GhRunner = async (args, options) =>
	new Promise(resolve => {
		execFile(
			'gh',
			args,
			{timeout: options?.timeoutMs ?? 0},
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ok: true, message: stdout.trim()});
				} else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					resolve({ok: false, message: 'no gh CLI, so no GitHub release'});
				} else {
					resolve({ok: false, message: stderr.trim() || error.message});
				}
			},
		);
	});

const HELP = `
	Release
	  $ chamoji changelog [options]    Generate a changelog from git history
	  $ chamoji next-version [options] Print the next semver version
	                                   (exits 3 when no release is needed)
	  $ chamoji release [version]      Cut a release: CHANGELOG.md, version
	                                   bumps, release commit and tag
	  $ chamoji publish [options]      Publish the packages a release tagged to
	                                   npm (exits 3 when there is nothing to
	                                   publish)

	Workstreams
	  $ chamoji ws                     List workstreams with their unreleased
	                                   commits (* marks the active one)
	  $ chamoji ws start <title> [emoji]
	                                   Start a workstream and make it active
	  $ chamoji ws switch <slug>       Make a workstream active
	  $ chamoji ws ship [slug]         Mark one shipped (default: the active one)
	  $ chamoji ws drop [slug]         Mark one dropped

	Memory
	  $ chamoji why <file:line>        Show why a line is there: the commit
	                                   that wrote it and the Why, Constraint,
	                                   Gotcha and Follow-up it recorded
	  $ chamoji memory                 List what shipped or dropped workstreams
	                                   left in memory (refs/chamoji/memory);
	                                   --archived adds the archived ones
	  $ chamoji memory show <slug>     Show one entry with its commits and cards
	  $ chamoji memory search <query>  Find commits and workstreams by what they
	                                   say, Why and Gotcha lines included
	  $ chamoji memory reindex         Rebuild the search index
	  $ chamoji memory archive <slug>  Hide an entry from the list and keep it
	                                   (--purge deletes it for good)
	  $ chamoji memory sync            Merge memory with origin and push it

	Commit
	  $ chamoji commit [-a]            Write a commit with the composer
	                                   (-a commits all tracked changes)
	  $ chamoji hook install           Offer the composer on a plain
	                                   \`git commit\` (uninstall to remove)

	Setup
	  $ chamoji setup [step]           Set up releases, memory sharing, Claude
	                                   Code and the commit composer; again to
	                                   change settings. A step (releases,
	                                   memory, agents or hook) runs just that
	                                   one. It writes the release section of
	                                   chamoji.config.json and never commits.
	                                   Exits 0 when it saved or nothing would
	                                   change, 2 when it needs a terminal or
	                                   --yes to go on, 1 when cancelled
	  $ chamoji init                   Set this clone up to share memory, and
	                                   take in what origin has
	  $ chamoji init --agents          The same, and set up Claude Code here:
	                                   the MCP server in .mcp.json and a hook
	                                   in .claude/settings.json that sends back
	                                   a git commit with no Why: line
	  $ chamoji card [options]         Print the URL of the repo's card image
	  $ chamoji mcp                    Serve project memory to AI agents over
	                                   MCP (stdio): search_memory, why and
	                                   workstream, all read-only
	  $ chamoji agent-hook             The hook itself; Claude Code runs it

	Options
	  --format   markdown (default), md, json or html
	  --output   Write to this file instead of stdout
	  --from     changelog: leave out this release tag and everything older.
	             publish: publish what this tag released (repeatable)
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
	  --dry-run  release: show the version and notes, change nothing.
	             publish: list what would be published, publish nothing
	  --push     release: push HEAD and the tag, sync memory if chamoji init
	             ran here, then create the GitHub release when the gh CLI
	             is installed (with release.publish set, the GitHub release
	             is left to the publish)
	  --on-merge release: for the GitHub Action on a push to the default
	             branch. Does nothing unless release.trigger is "merge" (exits
	             3), and with release.majors "manual" holds back a breaking
	             change for a release a person runs
	  --publish  release: check the packages before the commit and tag, push,
	             publish them to npm, then create the GitHub release
	             (implies --push)
	  --trailer  release: add "Key: value" to the release commit (repeatable)
	  --any-branch
	             release: allow a branch other than origin's default
	  --unit     release, next-version and publish: only this release unit
	             (repeatable; release 2.0.0 needs exactly one); changelog:
	             this unit's releases
	  --tag      publish: the npm dist-tag to publish under, instead of the
	             one the version implies
	  --catch-up publish: publish what each unit's latest tag released and
	             npm lacks, and create its missing GitHub release
	  --for-tag  changelog: only the release with this tag, from the unit
	             whose tag format it fits
	  --yes      setup: take every recommended answer without asking; the
	             hook is still only offered
	  --explain  setup: print each value it writes and where it came from
	  --json     release and publish: print the result as JSON; card: print the numbers;
	             ws list: print the workstreams as an array;
	             why: print the blame result; memory list and show: print
	             the entries; memory search: print the matches;
	             memory sync: print the result; setup: print what it
	             found and did (with no --yes, what it would do, writing
	             nothing; exits 2 when something would change)
	  --none     ws switch: clear the active workstream
	  --archived memory list: include archived entries
	  --purge    memory archive: delete the entry and its history instead;
	             memory sync then says what origin needs to lose it too
	  --agents   init: also add chamoji to .mcp.json and .claude/settings.json.
	             Both are shared files meant to be committed; existing
	             entries are kept.
	  --repo     card: owner/name on GitHub (default: from the origin remote)
	  --endpoint card: the card renderer (default: https://chamoji.dev/api/card)
	  --no-update-check
	             Don't check npm for a newer chamoji. Also off in CI, when
	             NO_UPDATE_NOTIFIER or CHAMOJI_NO_UPDATE_CHECK=1 is set,
	             and when stderr isn't a terminal.

	Environment
	  CHAMOJI_NO_ANIMATION
	             Set to 1 to turn off the moving faces and the intro. They
	             are also off in CI, when TERM=dumb, with --json, and when
	             the output isn't a terminal.
	  CHAMOJI_THEME
	             light or dark. Skips asking the terminal for its background.
	             On light, chamoji draws without the foil colours.
	  CHAMOJI_ASCII
	             Set to 1 to draw the faces and the logo in plain ASCII. This
	             is the default on the old Windows console.

	Examples
	  $ chamoji changelog --output CHANGELOG.md
	  $ version=$(chamoji next-version) && chamoji changelog --release "$version" -o CHANGELOG.md
	  $ chamoji changelog --format html --output changelog.html
	  $ chamoji release --dry-run
	  $ chamoji release 2.0.0-rc.1 --push
	  $ chamoji release --publish
	  $ chamoji release 2.0.0 --unit mobile --dry-run
	  $ chamoji publish --dry-run
	  $ chamoji changelog --for-tag web/v1.4.0
	  $ chamoji setup
	  $ chamoji setup releases --yes --explain
`;

export const NO_RELEASE_NEEDED = 3;

const DEFERRED = 'the GitHub release is created after the publish';

const outcomeText = (outcome: PublishOutcome): string =>
	outcome.status === 'already' ? 'already on npm' : outcome.status;

/** `name version → distTag`, the start of every publish line. */
const targetLine = (item: {
	name: string;
	version: string;
	distTag: string;
}): string => `${item.name} ${item.version} → ${item.distTag}`;

const outcomeLine = (outcome: PublishOutcome): string =>
	`${targetLine(outcome)}: ${outcomeText(outcome)}`;

const dryRunLine = (target: PublishTarget): string =>
	`${targetLine(target)}: ${target.published ? 'already on npm' : 'would publish'}`;

/** What a failed publish after the push says, and how to finish it. */
const unpublished = (tag: string, name: string, version: string): string =>
	`${tag} is tagged and pushed; ${name} ${version} isn't on npm. Re-run this job, or run \`chamoji publish --from ${tag}\`.`;

const nothingToPublish = (count: number): string =>
	count === 0
		? 'chamoji: nothing to publish (no package to publish here)'
		: 'chamoji: nothing to publish (every package is already on npm, or was skipped)';

const FORMATS: Record<string, OutputFormat> = {
	markdown: 'markdown',
	md: 'markdown',
	json: 'json',
	html: 'html',
};

function parse(argv: string[]) {
	return meow(HELP, {
		importMeta: import.meta,
		description: TAGLINE,
		argv,
		autoHelp: false,
		autoVersion: false,
		flags: {
			format: {type: 'string', default: 'markdown'},
			output: {type: 'string', shortFlag: 'o'},
			from: {type: 'string', isMultiple: true},
			to: {type: 'string', default: 'HEAD'},
			release: {type: 'string'},
			since: {type: 'string'},
			config: {type: 'string'},
			ai: {type: 'boolean'},
			updateCheck: {type: 'boolean', default: true},
			dryRun: {type: 'boolean'},
			push: {type: 'boolean'},
			onMerge: {type: 'boolean'},
			publish: {type: 'boolean'},
			trailer: {type: 'string', isMultiple: true},
			anyBranch: {type: 'boolean'},
			unit: {type: 'string', isMultiple: true, default: []},
			tag: {type: 'string'},
			catchUp: {type: 'boolean'},
			forTag: {type: 'string'},
			json: {type: 'boolean'},
			none: {type: 'boolean'},
			purge: {type: 'boolean'},
			archived: {type: 'boolean'},
			agents: {type: 'boolean'},
			yes: {type: 'boolean'},
			explain: {type: 'boolean'},
			repo: {type: 'string'},
			endpoint: {type: 'string'},
			all: {type: 'boolean', shortFlag: 'a'},
			help: {type: 'boolean', shortFlag: 'h'},
			version: {type: 'boolean', shortFlag: 'v'},
		},
	});
}

/** Whether `argv` shows the logo: a bare `chamoji`, or `--help`. */
export function showsLogo(argv: string[]): boolean {
	const {input, flags} = parse(argv);
	return (input.length === 0 && !flags.version) || Boolean(flags.help);
}

/** Whether the command in `argv` can wait on something slow, and so shows a face. */
export function wantsFace(argv: string[]): boolean {
	const {input, flags} = parse(argv);
	return hasFace(input, flags);
}

export async function run(argv: string[], given: Io): Promise<number> {
	const cli = parse(argv);
	const {flags} = cli;
	// Commands that never wait never touch the face, whatever was passed.
	const face = given.face && hasFace(cli.input, flags) ? given.face : NO_FACE;
	const io: Io = {...given, face};
	/** `--from`, once per tag. */
	const froms = flags.from ?? [];
	/** A step a command is running that Jev's progress shows on, if any. */
	let jevHost: Step | undefined;
	const jev = jevFace(face, () => jevHost);
	try {
		if (flags.help) {
			io.stdout(`${oneLineLogo(io.welcome ?? PLAIN_WELCOME)}\n${cli.help}\n`);
			return 0;
		}

		if (flags.version) {
			io.stdout(`${cli.pkg.version ?? 'unknown'}\n`);
			return 0;
		}

		// The refresh runs detached and the notice comes from the cache, so the
		// check never delays the command or touches stdout.
		const check =
			flags.updateCheck &&
			cli.input[0] !== 'hook' &&
			cli.input[0] !== 'mcp' &&
			cli.input[0] !== 'agent-hook'
				? io.updateCheck
				: undefined;
		check?.refreshIfStale();
		const code = await execute(cli.input[0]);
		const notice = check?.notice();
		if (notice) {
			io.stderr(`\n${notice}\n`);
		}

		return code;
	} finally {
		// The cursor must never be left hidden, whatever happened.
		face.stop();
	}

	async function execute(command: string | undefined): Promise<number> {
		try {
			// card ignores --ai: it counts what the rules sort and sends nothing out.
			// memory search and mcp have their own use for it, and ask for their key
			// themselves. agent-hook has none, and stdout is its decision.
			const classify =
				flags.ai &&
				command !== 'card' &&
				command !== 'memory' &&
				command !== 'mcp' &&
				command !== 'agent-hook'
					? jev.wrap(await jevClassifier(io, jev.progress))
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

					if (froms.length > 1) {
						throw new Error('--from takes one tag for changelog');
					}

					const config = await loadConfig(io.cwd, flags.config);
					if (releasesUnits(config)) {
						return await changelogUnits(config, format, classify);
					}

					refuseUnitFlags();
					const changelog = await buildChangelog({
						cwd: io.cwd,
						config,
						to: flags.to,
						from: froms[0],
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
					const config = await loadConfig(io.cwd, flags.config);
					if (releasesUnits(config)) {
						return await nextVersions(config, classify);
					}

					refuseUnitFlags();
					await monorepoHint(config);
					// Only --ai has a face here, and Jev's progress shows on this step.
					const next = await runStep(
						face,
						'Working out the next version',
						async step => {
							jevHost = step;
							try {
								const {releases} = await buildChangelog({
									cwd: io.cwd,
									config,
									to: flags.to,
									classify,
									classifyReleases: 'unreleased',
								});
								return releases.find(release => release.tag === null)
									?.nextVersion;
							} finally {
								jevHost = undefined;
							}
						},
						found => planned(found ? `Next version is ${found}` : undefined),
					);
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
					const config = await loadConfig(io.cwd, flags.config);
					if (flags.onMerge && config.release?.trigger !== 'merge') {
						io.stderr('chamoji: releases are manual here (release.trigger)\n');
						return NO_RELEASE_NEEDED;
					}

					if (releasesUnits(config)) {
						return await releaseUnits(config, cli.input[1], classify);
					}

					refuseUnitFlags();
					await monorepoHint(config);
					return await release(cli.input[1], classify);
				}

				case 'publish': {
					return await publish();
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

				case 'agent-hook': {
					// Claude Code runs this before a Bash command. Whatever happens it
					// prints a decision or nothing, and exits 0.
					return await runAgentHook({...io, stdin: process.stdin});
				}

				case 'init': {
					return await runInit({agents: flags.agents}, io);
				}

				case 'setup': {
					const step = cli.input[1];
					if (step !== undefined && !isStepName(step)) {
						io.stderr(
							`chamoji: setup takes releases, memory, agents or hook, not "${step}"\n`,
						);
						return 1;
					}

					return await runSetup(
						{
							step,
							yes: flags.yes ?? false,
							json: flags.json ?? false,
							explain: flags.explain ?? false,
						},
						{...io, gh: io.gh ?? runGh},
					);
				}

				case undefined: {
					await playWelcome({
						...(io.welcome ?? PLAIN_WELCOME),
						write: io.stdout,
					});
					io.stdout(`\n${TAGLINE}\n\n${SHORT_HELP}\n`);
					if (await nothingSetUp(io)) io.stdout(`\n${GET_STARTED}\n`);
					return 0;
				}

				default: {
					io.stderr(
						`chamoji: unknown command "${command}"\nRun chamoji for the commands, or chamoji --help for every option.\n`,
					);
					return 2;
				}
			}
		} catch (error) {
			// Git's errors can carry what a remote or a hook printed.
			io.stderr(`chamoji: ${stripControlLines((error as Error).message)}\n`);
			return error instanceof ReleaseError ||
				error instanceof ConfigVersionError
				? PREFLIGHT_FAILED
				: 1;
		}
	}

	/**
	 * What a publish runs with: the complete environment (`runNpm` adds
	 * nothing, and an unset entry in io.env removes the variable the process
	 * has), npm, whether this is CI, and the registries that may hold a token.
	 */
	function publishTools(config: ChamojiConfig): PublishTools {
		const env = processEnv();
		for (const [key, value] of Object.entries(io.env ?? {})) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}

		return {
			env,
			npm: io.npm ?? runNpm,
			ci: env['CI'] === 'true',
			registries: config.release?.publish?.registries ?? [],
		};
	}

	/**
	 * The method `plan` publishes with, once the credentials are checked.
	 * Nothing to publish needs no credentials. A failed check discards the
	 * plan and throws.
	 */
	async function publishAuth(
		plan: PublishPlan,
		tools: PublishTools,
	): Promise<PublishMethod> {
		try {
			return plan.targets.some(target => !target.published)
				? await checkPublishAuth(plan, {
						env: tools.env,
						npm: tools.npm,
						fetch: io.fetch ?? (fetch as FetchLike),
						ci: tools.ci,
						registries: tools.registries,
					})
				: publishMethod(tools.env);
		} catch (error) {
			await discardPublishPlan(plan);
			throw error;
		}
	}

	/** Publishes a checked plan; `runPublish` removes its tarballs, however it ends. */
	async function publishPlan(
		plan: PublishPlan,
		method: PublishMethod,
		tools: PublishTools,
	): Promise<PublishOutcome[]> {
		return runPublish(plan, {
			method,
			npm: tools.npm,
			env: tools.env,
			ci: tools.ci,
			registries: tools.registries,
		});
	}

	/** One stderr line per package a plan skips, such as an app. */
	function skippedLines(plan: PublishPlan): string[] {
		return plan.skipped.map(
			item => `chamoji: skipped ${item.name}: ${item.reason}\n`,
		);
	}

	/** What a publish said about each package it didn't publish, on stderr. */
	function reportOutcomes(outcomes: PublishOutcome[]): void {
		for (const outcome of outcomes) {
			if (outcome.message && outcome.status !== 'published') {
				io.stderr(`chamoji: ${outcome.name}: ${outcome.message}\n`);
			}
		}
	}

	/**
	 * `publish --catch-up`: for each unit's latest tag (or the repo's), publishes
	 * what that tag released and npm lacks, then creates its GitHub release when
	 * everything is on npm and the release is missing. A tag that fails is
	 * reported and the rest go on; the exit is 1 if any failed, else 0.
	 */
	async function publishCatchUp(): Promise<number> {
		if (froms.length > 0 || flags.dryRun) {
			throw new Error(
				`--catch-up looks at the latest tags itself; it doesn't take ${froms.length > 0 ? '--from' : '--dry-run'}`,
			);
		}

		const config = await loadConfig(io.cwd, flags.config);
		const tools = publishTools(config);
		await requireNpm(tools.npm, io.cwd);
		const results = await catchUp({
			cwd: io.cwd,
			config,
			...(flags.unit.length > 0 ? {units: flags.unit} : {}),
			...(flags.tag === undefined ? {} : {tag: flags.tag}),
			npm: tools.npm,
			env: tools.env,
			fetch: io.fetch ?? (fetch as FetchLike),
			ci: tools.ci,
			registries: tools.registries,
		});

		const lines: string[] = [];
		const tags: Array<
			CatchUpResult & {githubRelease?: 'created' | 'exists' | string}
		> = [];
		for (const result of results) {
			const {tag, outcomes, error} = result;
			const missing = outcomes.filter(outcome => outcome.status !== 'already');
			const complete =
				error === undefined &&
				outcomes.length > 0 &&
				outcomes.every(
					outcome =>
						outcome.status === 'published' || outcome.status === 'already',
				);
			const count = (
				status: PublishOutcome['status'],
				label: string = status,
			) => {
				const n = outcomes.filter(outcome => outcome.status === status).length;
				return n > 0 ? [`${label} ${n}`] : [];
			};

			let release: string | undefined;
			if (complete) release = await catchUpRelease(config, tag);

			const summary = error
				? `error: ${stripControlLines(error)}`
				: missing.length === 0
					? 'nothing missing'
					: [
							...count('published'),
							...count('failed'),
							...count('skipped'),
							...count('already', 'already on npm'),
						].join(', ');
			lines.push(
				`${tag}: ${summary}${release === undefined || release === 'exists' ? '' : `; ${releaseText(release)}`}`,
				...missing.map(outcome => `  ${outcomeLine(outcome)}`),
			);
			reportOutcomes(outcomes);
			tags.push({
				...result,
				...(error === undefined ? {} : {error: stripControlLines(error)}),
				...(release === undefined ? {} : {githubRelease: release}),
			});
		}

		const anyFailed = results.some(
			result =>
				result.error !== undefined ||
				result.outcomes.some(outcome => outcome.status === 'failed'),
		);
		const anyPublished = results.some(result =>
			result.outcomes.some(outcome => outcome.status === 'published'),
		);
		const status = anyFailed
			? 'failed'
			: anyPublished
				? 'caught-up'
				: 'nothing';
		printResult(lines.length > 0 ? lines : ['no release tag to catch up on'], {
			status,
			tags,
		});
		return anyFailed ? 1 : 0;

		function releaseText(release: string): string {
			return release === 'created'
				? 'GitHub release created'
				: `GitHub release not created: ${release}`;
		}
	}

	/**
	 * Creates the GitHub release for `tag` when there is none: 'exists' when gh
	 * finds it, 'created', or why it wasn't. Without gh, or when gh can't say
	 * the release is missing, nothing is created and the answer is undefined.
	 */
	async function catchUpRelease(
		config: ChamojiConfig,
		tag: string,
	): Promise<string | undefined> {
		const gh = io.gh ?? runGh;
		const viewed = await gh(['release', 'view', tag]);
		if (viewed.ok) return 'exists';
		if (/no gh CLI/i.test(viewed.message)) return undefined;
		try {
			const root = (
				await runGit(['rev-parse', '--show-toplevel'], io.cwd)
			).trim();
			const settled = await githubReleaseStep({
				root,
				tag,
				title: tag,
				notes: await catchUpNotes(config, root, tag),
				prerelease:
					semver.prerelease(
						semver.coerce(tag, {includePrerelease: true})?.version ?? '',
					) !== null,
				forTag: tag,
			});
			const result = settled.ok
				? settled.value
				: {ok: false, message: (settled.error as Error).message};
			return result.ok ? 'created' : stripControlLines(result.message);
		} catch (error) {
			return stripControlLines((error as Error).message);
		}
	}

	/** The release notes for a tag already cut: what `changelog --for-tag` says, or the tag's own section in a repo without units. */
	async function catchUpNotes(
		config: ChamojiConfig,
		root: string,
		tag: string,
	): Promise<string> {
		if (releasesUnits(config)) {
			let notes = '';
			let problem = '';
			const code = await run(
				[
					'changelog',
					'--for-tag',
					tag,
					...(flags.config === undefined ? [] : ['--config', flags.config]),
				],
				{
					...io,
					stdout: text => (notes += text),
					stderr: text => (problem += text),
				},
			);
			if (code !== 0) throw new Error(problem.trim() || `no notes for ${tag}`);
			return notes.trim();
		}

		const changelog = await buildChangelog({
			cwd: root,
			config,
			to: tag,
			today: io.today,
		});
		const release = changelog.releases.find(item => item.tag === tag);
		if (!release) throw new Error(`no notes for ${tag}`);
		return stripTitle(render({...changelog, releases: [release]}, 'markdown'));
	}

	/** What `chamoji publish` and the Action's publish step run. */
	async function publish(): Promise<number> {
		if (flags.catchUp) return publishCatchUp();

		const config = await loadConfig(io.cwd, flags.config);
		const tools = publishTools(config);
		const {env, npm} = tools;
		await requireNpm(npm, io.cwd);
		const plan = await planPublish({
			cwd: io.cwd,
			config,
			...(froms.length > 0 ? {from: froms} : {}),
			...(flags.unit.length > 0 ? {units: flags.unit} : {}),
			...(flags.tag === undefined ? {} : {tag: flags.tag}),
			npm,
			env,
		});
		const skipped = plan.skipped;

		if (flags.dryRun) {
			await discardPublishPlan(plan);
			const lines = plan.targets.map(target => dryRunLine(target));
			for (const text of skippedLines(plan)) io.stderr(text);
			const nothing = plan.targets.every(target => target.published);
			if (flags.json) {
				printResult([], {
					status: 'dry-run',
					method: publishMethod(env),
					packages: plan.targets satisfies PublishTarget[],
					skipped,
				});
			} else {
				if (lines.length > 0) printResult(lines, {});
				if (nothing) io.stderr(`${nothingToPublish(plan.targets.length)}\n`);
			}

			return nothing ? NO_RELEASE_NEEDED : 0;
		}

		const method = await publishAuth(plan, tools);
		const outcomes = await publishPlan(plan, method, tools);
		for (const text of skippedLines(plan)) io.stderr(text);
		reportOutcomes(outcomes);

		const failed = outcomes.some(outcome => outcome.status === 'failed');
		const published = outcomes.some(outcome => outcome.status === 'published');
		const status = failed ? 'failed' : published ? 'published' : 'nothing';
		if (flags.json || outcomes.length > 0) {
			printResult(
				outcomes.map(outcome => outcomeLine(outcome)),
				{status, method, packages: outcomes, skipped},
			);
		}

		if (failed) return 1;
		if (published) return 0;
		if (!flags.json) io.stderr(`${nothingToPublish(outcomes.length)}\n`);
		return NO_RELEASE_NEEDED;
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
			message = await terminal.compose(
				config,
				advice,
				await composeImpact(root),
			);
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
			await composeImpact(root),
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
				return setUpHook(io);
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

	/**
	 * How a planning step ends: warn when Jev left commits unsorted, as Jev's
	 * own step would, else ok with `text`, or `Nothing to release` without it.
	 */
	function planned(text: string | undefined): {
		outcome: 'ok' | 'warn';
		text: string;
	} {
		const left = jev.unsorted();
		return left
			? {outcome: 'warn', text: left}
			: {outcome: 'ok', text: text ?? 'Nothing to release'};
	}

	/** Prints a release command's result: the lines, or the JSON under --json. */
	function printResult(lines: string[], json: Record<string, unknown>): void {
		io.stdout(
			flags.json
				? `${JSON.stringify(json, null, 2)}\n`
				: `${lines.join('\n')}\n`,
		);
	}

	/**
	 * The planning step of `release`, with or without units. `plan` gets the
	 * options every release plan shares, the face's credential handling
	 * included; `ready` names what is ready to release, or undefined when
	 * nothing is.
	 */
	async function planningStep<T>(
		plan: (options: PlanningOptions) => Promise<T>,
		ready: (result: T) => string | undefined,
	): Promise<T> {
		// Under a face the tag fetch must not ask for a password, or the face
		// would draw over the prompt. When it needs one, the step ends first and
		// the planner fetches again where git can ask.
		const env = face === NO_FACE ? undefined : await quietGitEnv(io.cwd);
		return runStep(
			face,
			'Planning the release',
			async step => {
				jevHost = step;
				try {
					return await plan({
						anyBranch: flags.anyBranch,
						fetch: io.fetchTags ?? true,
						// --publish writes the release to the tree and puts it back with
						// git, which would lose uncommitted edits to those files.
						allowDirty: flags.dryRun && !flags.publish,
						today: io.today,
						onStep() {
							step.update('Fetching tags from origin');
						},
						async onCredentials() {
							// Jev, if it runs after this, starts a step of its own.
							jevHost = undefined;
							step.end('warn', 'git needs your credentials');
							// A theme question still open would read what is typed at
							// git's prompt, or its late reply would land there, so the
							// face lets go of the terminal before git asks.
							await face.release();
						},
						...(env ? {env} : {}),
					});
				} finally {
					jevHost = undefined;
				}
			},
			result => {
				const what = ready(result);
				return planned(
					what === undefined ? undefined : `Ready to release ${what}`,
				);
			},
		);
	}

	/**
	 * Pushes HEAD and `tags` as a step. Each step from here on that goes wrong
	 * is folded into the summary, so its face ends on a warning; the error is
	 * thrown on as before.
	 */
	async function pushStep(
		root: string,
		tags: string[],
		push: (env?: Record<string, string>) => Promise<void>,
	): Promise<void> {
		const what = tags.join(', ');
		unsettle(
			await gitStep(
				face,
				root,
				`Pushing HEAD and ${what}`,
				async env => settle(push(env)),
				result =>
					result.ok
						? {outcome: 'ok', text: `Pushed HEAD and ${what}`}
						: {
								outcome: 'warn',
								text: `The push failed; ${what} ${tags.length === 1 ? 'is' : 'are'} kept here`,
							},
			),
		);
	}

	/**
	 * Creates one GitHub release as a step, with its notes in a file in the git
	 * dir. Returns gh's answer, or what failed before gh could answer, as a
	 * value; the step ends on a warning either way. `forTag` names the tag in
	 * the step when there are several releases.
	 */
	async function githubReleaseStep(release: {
		root: string;
		tag: string;
		title: string;
		notes: string;
		prerelease: boolean;
		forTag?: string;
	}): Promise<Settled<{ok: boolean; message: string}>> {
		const named = release.forTag === undefined ? '' : ` for ${release.forTag}`;
		return runStep(
			face,
			`Creating the GitHub release${named}`,
			async () =>
				settle(
					(async () => {
						const notesFile = path.join(
							(
								await runGit(['rev-parse', '--absolute-git-dir'], release.root)
							).trim(),
							'chamoji-release-notes.md',
						);
						await writeFile(notesFile, `${release.notes}\n`);
						return (io.gh ?? runGh)([
							'release',
							'create',
							release.tag,
							'--title',
							release.title,
							'--notes-file',
							notesFile,
							...(release.prerelease ? ['--prerelease'] : []),
						]);
					})(),
				),
			created =>
				created.ok && created.value.ok
					? {outcome: 'ok', text: `Created the GitHub release${named}`}
					: {outcome: 'warn', text: `GitHub release${named} not created`},
		);
	}

	/**
	 * `release --publish` before the commit: writes the release to the working
	 * tree, runs every publish check on what it will commit (the check
	 * command, packing, dependencies, apps) and checks the npm credentials.
	 * Any failure puts the tree back and throws. Under --dry-run the tree is
	 * put back and the tarballs removed at once; the plan is kept for its
	 * targets.
	 */
	async function checkRelease(
		ready: {root: string; changes: FileChange[]},
		config: ChamojiConfig,
		versions: Map<string, string>,
	): Promise<CheckedRelease> {
		const tools = publishTools(config);
		await requireNpm(tools.npm, io.cwd);
		const written = await writeChanges(ready);
		let keep = false;
		try {
			return await runStep(
				face,
				'Checking the packages',
				async () => {
					const plan = await planPublish({
						cwd: io.cwd,
						config,
						npm: tools.npm,
						env: tools.env,
						versions,
						skipTagCheck: true,
					});
					if (flags.dryRun) {
						await discardPublishPlan(plan);
						return {
							plan,
							method: publishMethod(tools.env),
							tools,
							written,
						};
					}

					const method = await publishAuth(plan, tools);
					keep = true;
					return {plan, method, tools, written};
				},
				({plan}) => ({
					outcome: 'ok',
					text: `Checked ${plan.targets.length} package${plan.targets.length === 1 ? '' : 's'}`,
				}),
			);
		} finally {
			if (!keep) await restoreChanges(written);
		}
	}

	/**
	 * Whether a plain --push leaves the GitHub release to the publish: with
	 * `release.publish` set, the release isn't announced before it is on npm.
	 */
	function defersGithubRelease(config: ChamojiConfig): boolean {
		return !flags.publish && Boolean(config.release?.publish);
	}

	/** A failed release commit after `checkRelease`: the tree and the tarballs go. */
	async function uncheckRelease(checked: CheckedRelease | undefined) {
		if (!checked) return;
		await restoreChanges(checked.written);
		await discardPublishPlan(checked.plan);
	}

	/** What `release --dry-run --publish` adds: the targets, as `publish --dry-run` lists them. */
	function wouldPublish(checked: CheckedRelease | undefined): {
		lines: string[];
		json: Record<string, unknown>;
	} {
		if (!checked) return {lines: [], json: {}};
		const {targets, skipped} = checked.plan;
		for (const text of skippedLines(checked.plan)) io.stderr(text);
		return {
			lines: [
				'',
				'Would publish:',
				...(targets.length > 0
					? targets.map(target => dryRunLine(target))
					: ['nothing; no package to publish here']),
			],
			json: {
				// The tarballs are gone after a dry run, so their paths aren't listed.
				packages: targets.map(target =>
					Object.fromEntries(
						Object.entries(target).filter(([key]) => key !== 'tarball'),
					),
				),
				skipped,
			},
		};
	}

	/**
	 * Publishes the checked tarballs after the push. Returns the outcomes,
	 * and the error to exit 1 with when a package isn't on npm: the tag is
	 * pushed by then, so the error says how to finish.
	 */
	async function publishAfterPush(
		checked: CheckedRelease,
	): Promise<{outcomes: PublishOutcome[]; error?: string}> {
		const {plan, method, tools} = checked;
		const failure = (name: string, version: string): string => {
			const target = plan.targets.find(
				item => item.name === name && item.version === version,
			);
			return unpublished(target?.tag ?? '', name, version);
		};

		let outcomes: PublishOutcome[];
		try {
			if (method === 'local') {
				// npm may ask for a one-time password on the terminal.
				await face.release();
				outcomes = await publishPlan(plan, method, tools);
			} else {
				outcomes = await runStep(
					face,
					'Publishing to npm',
					async () => publishPlan(plan, method, tools),
					done =>
						done.some(outcome => outcome.status === 'failed')
							? {outcome: 'warn', text: 'The publish failed'}
							: {outcome: 'ok', text: 'Published to npm'},
				);
			}
		} catch (error) {
			const first = plan.targets.find(target => !target.published);
			// The npm credentials are in this env; none of them is printed.
			const message = mask(
				stripControlLines((error as Error).message),
				scrubEnv(tools.env).secrets,
			);
			io.stderr(`chamoji: ${message}\n`);
			return {
				outcomes: [],
				...(first ? {error: failure(first.name, first.version)} : {}),
			};
		}

		for (const text of skippedLines(plan)) io.stderr(text);
		reportOutcomes(outcomes);
		const failed = outcomes.find(outcome => outcome.status === 'failed');
		return {
			outcomes,
			...(failed ? {error: failure(failed.name, failed.version)} : {}),
		};
	}

	/** The npm lines of a release's summary. */
	function publishedLines(outcomes: PublishOutcome[]): string[] {
		return outcomes.length > 0
			? outcomes.map(outcome => `npm: ${outcomeLine(outcome)}`)
			: ['npm: nothing to publish'];
	}

	/** What `--on-merge` asks planning to hold back: a breaking change, when the config says majors wait for a person. */
	function holdMajors(config: ChamojiConfig): {holdMajors?: true} {
		return flags.onMerge && config.release?.majors === 'manual'
			? {holdMajors: true}
			: {};
	}

	function announceHeld(held: string[] | undefined): void {
		for (const name of held ?? []) {
			io.stderr(
				`chamoji: ${name} has a breaking change and waits for a manual release (release.majors)\n`,
			);
		}
	}

	async function release(
		version: string | undefined,
		classify: CommitClassifier | undefined,
	): Promise<number> {
		const config = await loadConfig(io.cwd, flags.config);
		const plan = await planningStep(
			async options =>
				planRelease({
					cwd: io.cwd,
					config,
					...(version === undefined ? {} : {version}),
					...holdMajors(config),
					classify,
					...options,
				}),
			result => (result.status === 'nothing' ? undefined : result.tag),
		);

		if (plan.status === 'nothing') {
			announceHeld(plan.held);
			printResult(
				[
					`Nothing to release: no commit since ${plan.lastTag} implies a version bump.`,
					...(plan.unreleased.length > 0
						? [
								'Unreleased commits:',
								...plan.unreleased.map(subject => `- ${subject}`),
							]
						: ['No commits since that tag.']),
				],
				{
					status: 'nothing',
					lastTag: plan.lastTag,
					unreleased: plan.unreleased,
					...heldFacts(plan.held),
				},
			);
			return NO_RELEASE_NEEDED;
		}

		const summary = `${plan.tag} (${describeBump(plan)})`;
		const files = plan.changes.map(change => change.file);
		const checked = flags.publish
			? await checkRelease(plan, config, new Map([[plan.tag, plan.version]]))
			: undefined;
		if (flags.dryRun) {
			const would = wouldPublish(checked);
			printResult(
				[
					`Would release ${summary}.`,
					`files: ${files.join(', ')}`,
					...plan.warnings.map(warning => `warning: ${warning}`),
					'',
					plan.notes,
					...would.lines,
				],
				{
					status: 'dry-run',
					...facts(plan, files),
					notes: plan.notes,
					...would.json,
				},
			);
			return 0;
		}

		let commit: string;
		try {
			({commit} = await applyRelease(plan, {trailers: flags.trailer}));
		} catch (error) {
			await uncheckRelease(checked);
			throw error;
		}

		let pushed: string = `no; to ship: git push origin HEAD ${plan.tag}`;
		let pushError: string | undefined;
		let publishError: string | undefined;
		let published: PublishOutcome[] = [];
		let githubRelease: boolean | 'deferred' = false;
		let memory: string | undefined;
		if (flags.push || flags.publish) {
			try {
				await pushStep(plan.root, [plan.tag], async env =>
					pushRelease(plan, env),
				);
				pushed = `yes (HEAD and ${plan.tag})`;
				memory = await syncAfterRelease();
				if (checked) {
					({outcomes: published, error: publishError} =
						await publishAfterPush(checked));
				}

				if (publishError) {
					pushed += '; no GitHub release, since the publish failed';
				} else if (defersGithubRelease(config)) {
					githubRelease = 'deferred';
					pushed += `; ${DEFERRED}`;
				} else {
					const result = unsettle(
						await githubReleaseStep({
							root: plan.root,
							tag: plan.tag,
							title: plan.tag,
							notes: plan.notes,
							prerelease: plan.bump === 'prerelease',
						}),
					);
					githubRelease = result.ok;
					pushed += result.ok
						? '; GitHub release created'
						: `; GitHub release not created: ${stripControlLines(result.message)}`;
				}
			} catch (error) {
				pushError = stripControlLines((error as Error).message);
				pushed = `failed: ${pushError}`;
			} finally {
				// A push that failed leaves the tarballs; runPublish removed them otherwise.
				if (checked) await discardPublishPlan(checked.plan);
			}
		}

		if (publishError) io.stderr(`chamoji: ${publishError}\n`);

		const [changelog, ...manifests] = plan.changes;
		printResult(
			[
				`Released ${summary}.`,
				`changelog: ${changelog!.file}, ${changelog!.how}`,
				`bumped: ${manifests.map(change => change.file).join(', ') || 'no manifest carried the old version'}`,
				`commit: ${commit} ${plan.subject}`,
				`tag: ${plan.tag} (annotated)`,
				`pushed: ${pushed}`,
				...(checked && pushed.startsWith('yes')
					? publishedLines(published)
					: []),
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
				...(checked ? {published} : {}),
				...(pushError || publishError
					? {error: pushError ?? publishError}
					: {}),
				...(memory === undefined ? {} : {memory}),
				notes: plan.notes,
			},
		);
		return pushError || publishError ? 1 : 0;
	}

	/**
	 * `release` in a repo with release units: one release commit, a tag per
	 * unit, and a GitHub release per tag (or one for all of them) on --push.
	 */
	async function releaseUnits(
		config: ChamojiConfig,
		version: string | undefined,
		classify: CommitClassifier | undefined,
	): Promise<number> {
		const only = flags.unit;
		if (version !== undefined && only.length !== 1) {
			throw new Error(
				'give --unit with a version, for example: chamoji release 2.0.0 --unit mobile',
			);
		}

		const plan = await planningStep(
			async options =>
				planUnitReleases({
					cwd: io.cwd,
					config,
					...(only.length > 0 ? {units: only} : {}),
					...(version === undefined ? {} : {versions: {[only[0]!]: version}}),
					...holdMajors(config),
					classify,
					...options,
				}),
			result => (result.status === 'nothing' ? undefined : tagList(result)),
		);

		const waiting = plan.pending.map(line =>
			only.length > 0 && !only.includes(line.unit)
				? leftOutLine(line)
				: pendingLine(line),
		);
		announceHeld(plan.held);
		if (plan.status === 'nothing') {
			printResult(
				[
					'Nothing to release: no unit has a commit of its own that implies a version bump.',
					...waiting,
				],
				{status: 'nothing', pending: plan.pending, ...heldFacts(plan.held)},
			);
			return NO_RELEASE_NEEDED;
		}

		const tags = uniqueTags(plan.units);
		const files = plan.changes.map(change => change.file);
		const units = plan.units.map(unit => unitLine(unit));
		const notices = [
			...plan.warnings.map(warning => `warning: ${warning}`),
			...plan.units.flatMap(unit =>
				unit.disagreed.map(
					file =>
						`note: ${file} had a version other than ${unit.from} (${unit.lastTag ?? 'its package.json version'}); it now says ${unit.version}`,
				),
			),
			...(plan.excludedNote ? plan.excludedNote.split('\n') : []),
		];
		const notes = plan.units.flatMap(unit => [
			'',
			`## ${unitHeading(plan.units, unit)}`,
			'',
			unit.notes,
		]);
		const unitFacts = {
			units: plan.units,
			files,
			warnings: plan.warnings,
			pending: plan.pending,
			...heldFacts(plan.held),
		};
		const checked = flags.publish
			? await checkRelease(
					plan,
					config,
					new Map(plan.units.map(unit => [unit.tag, unit.version])),
				)
			: undefined;
		if (flags.dryRun) {
			const would = wouldPublish(checked);
			printResult(
				[
					'Would release:',
					...units,
					`files: ${files.join(', ')}`,
					...notices,
					...waiting,
					...notes,
					...would.lines,
				],
				{status: 'dry-run', ...unitFacts, ...would.json},
			);
			return 0;
		}

		let commit: string;
		try {
			({commit} = await applyUnitReleases(plan, {trailers: flags.trailer}));
		} catch (error) {
			await uncheckRelease(checked);
			throw error;
		}

		const listed = tagList(plan);
		let pushed = `no; to ship: git push origin HEAD ${tags.join(' ')}`;
		let pushError: string | undefined;
		let publishError: string | undefined;
		let published: PublishOutcome[] = [];
		let githubRelease: boolean | 'deferred' = false;
		let memory: string | undefined;
		if (flags.push || flags.publish) {
			try {
				await pushStep(plan.root, tags, async env =>
					pushUnitReleases(plan, env),
				);
				pushed = `yes (HEAD and ${listed})`;
				memory = await syncAfterRelease();
				if (checked) {
					({outcomes: published, error: publishError} =
						await publishAfterPush(checked));
				}

				const failed: string[] = [];
				const releases =
					publishError || defersGithubRelease(config)
						? []
						: githubReleases(plan, config);
				for (const item of releases) {
					const named = releases.length === 1 ? '' : ` for ${item.tag}`;
					const settled = await githubReleaseStep({
						root: plan.root,
						...item,
						...(releases.length === 1 ? {} : {forTag: item.tag}),
					});
					// The push is done: a release that fails before gh answers (the
					// notes file can't be written) is one not created, not a failed push.
					const result = settled.ok
						? settled.value
						: {ok: false, message: (settled.error as Error).message};
					if (!result.ok) {
						failed.push(
							`GitHub release not created${named}: ${stripControlLines(result.message)}`,
						);
					}
				}

				if (publishError) {
					pushed += '; no GitHub release, since the publish failed';
				} else if (defersGithubRelease(config)) {
					githubRelease = 'deferred';
					pushed += `; ${DEFERRED}`;
				} else {
					githubRelease = failed.length === 0;
					pushed += githubRelease
						? `; GitHub release${releases.length === 1 ? '' : 's'} created`
						: `; ${failed.join('; ')}`;
				}
			} catch (error) {
				pushError = stripControlLines((error as Error).message);
				pushed = `failed: ${pushError}`;
			} finally {
				// A push that failed leaves the tarballs; runPublish removed them otherwise.
				if (checked) await discardPublishPlan(checked.plan);
			}
		}

		if (publishError) io.stderr(`chamoji: ${publishError}\n`);
		printResult(
			[
				`Released ${listed}.`,
				...units,
				`files: ${files.join(', ')}`,
				`commit: ${commit} ${plan.subject}`,
				`tags: ${listed} (annotated)`,
				`pushed: ${pushed}`,
				...(checked && pushed.startsWith('yes')
					? publishedLines(published)
					: []),
				...(memory === undefined ? [] : [`memory: ${memory}`]),
				...notices,
				...waiting,
				...(pushed.startsWith('yes')
					? []
					: [
							`undo before pushing: git tag -d ${tags.join(' ')} && git reset --hard ${plan.start.slice(0, 7)}`,
						]),
				...notes,
			],
			{
				status: 'released',
				...unitFacts,
				commit,
				pushed: pushed.startsWith('yes'),
				githubRelease,
				...(checked ? {published} : {}),
				...(pushError || publishError
					? {error: pushError ?? publishError}
					: {}),
				...(memory === undefined ? {} : {memory}),
			},
		);
		return pushError || publishError ? 1 : 0;
	}

	/** `next-version` in a repo with release units: one line per unit. */
	async function nextVersions(
		config: ChamojiConfig,
		classify: CommitClassifier | undefined,
	): Promise<number> {
		// Like next-version without units, this reads; it checks no branch or tree.
		const plan = await runStep(
			face,
			'Working out the next versions',
			async step => {
				jevHost = step;
				try {
					return await planUnitReleases({
						cwd: io.cwd,
						config,
						...(flags.unit.length > 0 ? {units: flags.unit} : {}),
						anyBranch: true,
						allowDirty: true,
						fetch: false,
						today: io.today,
						classify,
					});
				} finally {
					jevHost = undefined;
				}
			},
			result =>
				planned(
					result.status === 'nothing'
						? undefined
						: `Next: ${result.units.map(unit => `${unit.unit} ${unit.version}`).join(', ')}`,
				),
		);
		const releasing = plan.status === 'ready' ? plan.units : [];
		const names =
			flags.unit.length > 0
				? flags.unit
				: config.release!.units.map(unit => unit.name);
		const units = names.map(name => {
			const found = releasing.find(unit => unit.unit === name);
			if (found) {
				const {unit, version, own, shared} = found;
				return {unit, version, own, shared};
			}

			const waiting = plan.pending.find(item => item.unit === name);
			return {
				unit: name,
				version: null,
				own: waiting?.own ?? 0,
				shared: waiting?.shared ?? 0,
			};
		});
		io.stdout(
			flags.json
				? `${JSON.stringify({units}, null, 2)}\n`
				: `${units
						.map(unit =>
							unit.version === null
								? unit.own + unit.shared > 0
									? pendingLine(unit)
									: `${unit.unit}: nothing to release`
								: `${unit.unit}: ${unit.version}`,
						)
						.join('\n')}\n`,
		);
		return units.some(unit => unit.version !== null) ? 0 : NO_RELEASE_NEEDED;
	}

	/** `changelog --unit` and `--for-tag`, in a repo with release units. */
	async function changelogUnits(
		config: ChamojiConfig,
		format: OutputFormat,
		classify: CommitClassifier | undefined,
	): Promise<number> {
		const {forTag} = flags;
		if (flags.unit.length === 0 && forTag === undefined) {
			throw new Error(
				`this repo releases units (${config.release!.units.map(unit => unit.name).join(', ')}); pass --unit <name> or --for-tag <tag>`,
			);
		}

		if (flags.unit.length > 0 && forTag !== undefined) {
			throw new Error('pass --unit or --for-tag, not both');
		}

		if (flags.unit.length > 1) {
			throw new Error('changelog takes one --unit');
		}

		if (
			froms.length > 0 ||
			flags.release !== undefined ||
			flags.since !== undefined ||
			flags.to !== 'HEAD'
		) {
			throw new Error(
				"--from, --to, --release and --since don't work with --unit or --for-tag",
			);
		}

		const write = async (output: string) => {
			if (flags.output) {
				await writeFile(path.resolve(io.cwd, flags.output), output);
				io.stderr(`Wrote ${flags.output}\n`);
			} else {
				io.stdout(output);
			}
		};

		const rebuilt = async (unit: string) => {
			const changelog = await unitChangelog({
				cwd: io.cwd,
				config,
				unit,
				...(classify ? {classify} : {}),
			});
			if (forTag === undefined) return changelog;
			const releases = changelog.releases.filter(
				release => release.tag === forTag,
			);
			if (releases.length === 0) {
				throw new Error(
					`${forTag} isn't one of ${unit}'s releases on this branch`,
				);
			}

			return {...changelog, releases};
		};

		if (forTag === undefined) {
			await write(render(await rebuilt(flags.unit[0]!), format));
			return 0;
		}

		const owners = await ownersOf(forTag);
		if (format !== 'markdown') {
			const parts = [];
			for (const {unit} of owners) parts.push(await rebuilt(unit));
			await write(
				render(
					{...parts[0]!, releases: parts.flatMap(part => part.releases)},
					format,
				),
			);
			return 0;
		}

		// What the release committed, so lines only the release wrote are kept.
		const sections = [];
		for (const owner of owners) {
			const notes =
				(await committedSection(
					owner.root,
					forTag,
					owner.changelog,
					owner.version,
				)) ?? stripTitle(render(await rebuilt(owner.unit), 'markdown'));
			sections.push({unit: owner.unit, tag: forTag, notes});
		}

		await write(`${tagNotes(sections)}\n`);
		return 0;

		/**
		 * The units released under the tag, as their tag histories read it: the
		 * first that reads it, with the other members of its fixed group that
		 * share it.
		 */
		async function ownersOf(tag: string) {
			const settings = config.release!;
			const root = (
				await runGit(['rev-parse', '--show-toplevel'], io.cwd)
			).trim();
			const reading = resolveUnits(settings, await readWorkspace(root)).flatMap(
				item => {
					const [read] = unitTagHistory(
						[{name: tag, date: ''}],
						item,
						settings,
					);
					return read
						? [
								{
									unit: item.name,
									changelog: item.changelog,
									version: read.version,
									root,
								},
							]
						: [];
				},
			);
			const first = reading[0];
			if (!first) throw new Error(`no unit's tag format matches ${tag}`);
			const group = settings.fixed.find(members =>
				members.includes(first.unit),
			);
			return group
				? reading.filter(item => group.includes(item.unit))
				: [first];
		}
	}

	/** The unit flags only mean something with release units. */
	function refuseUnitFlags(): void {
		if (flags.unit.length > 0 || flags.forTag !== undefined) {
			throw new Error(
				'--unit and --for-tag need release units; add them under release.units in chamoji.config.json',
			);
		}
	}

	/**
	 * Says once per clone, on stderr, that setup can version each app, in a
	 * repo with no release section and two or more packages under apps/. Never
	 * under --json or in CI, and never in the way of the command.
	 */
	async function monorepoHint(config: ChamojiConfig): Promise<void> {
		if (config.release !== undefined || flags.json) return;
		if ((io.env ?? process.env)['CI']) return;
		try {
			const gitDir = (
				await runGit(['rev-parse', '--absolute-git-dir'], io.cwd)
			).trim();
			const marker = path.join(gitDir, 'chamoji', 'monorepo-hint');
			if (existsSync(marker)) return;
			const root = (
				await runGit(['rev-parse', '--show-toplevel'], io.cwd)
			).trim();
			const apps = (await readWorkspace(root)).filter(pkg =>
				/^apps\/[^/]+$/.test(pkg.path),
			);
			if (apps.length < 2) return;
			await mkdir(path.dirname(marker), {recursive: true});
			await writeFile(marker, '');
			io.stderr(`${MONOREPO_HINT}\n`);
		} catch {
			// A hint is never worth failing a release over.
		}
	}

	/**
	 * Syncs only a clone that opted in with `chamoji init`, and otherwise says
	 * how to, if there's anything to share. The release is out by now, so a
	 * problem here is only ever reported.
	 */
	async function syncAfterRelease(): Promise<string | undefined> {
		try {
			if (await fetchesMemory(io.cwd)) {
				const result = unsettle(
					await gitStep(
						face,
						io.cwd,
						SYNC_LABEL,
						async (env, step) =>
							settle(syncMemory(io.cwd, {env, onStep: relabel(step)})),
						synced =>
							synced.ok
								? syncOutcome(synced.value)
								: {outcome: 'warn', text: 'Memory was not synced'},
					),
				);
				return syncSummary(result);
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

/** The options `planningStep` gives every release plan. */
type PlanningOptions = Pick<
	ReleaseOptions,
	| 'anyBranch'
	| 'fetch'
	| 'allowDirty'
	| 'today'
	| 'onStep'
	| 'onCredentials'
	| 'env'
>;

/** What a publish runs with; see `publishTools`. */
type PublishTools = {
	env: Record<string, string>;
	npm: NpmRunner;
	ci: boolean;
	registries: string[];
};

/** A release checked for `--publish`, its changes still in the working tree. */
type CheckedRelease = {
	plan: PublishPlan;
	method: PublishMethod;
	tools: PublishTools;
	written: WrittenChanges;
};

type Settled<T> = {ok: true; value: T} | {ok: false; error: unknown};

/**
 * A failure as a value, so the step around it can end on a warning when the
 * failure is folded into the summary. A credential failure still throws, so
 * gitStep can run the work again where git may ask.
 */
async function settle<T>(work: Promise<T>): Promise<Settled<T>> {
	try {
		return {ok: true, value: await work};
	} catch (error) {
		if (isAuthFailure(error)) throw error;
		return {ok: false, error};
	}
}

/** The value, or the failure thrown again. */
function unsettle<T>(settled: Settled<T>): T {
	if (settled.ok) return settled.value;
	throw settled.error;
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

/** `held` in the JSON, only when something was held. */
function heldFacts(held: string[] | undefined): {held?: string[]} {
	return held && held.length > 0 ? {held} : {};
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

const MONOREPO_HINT =
	'chamoji: this looks like a monorepo with several apps; run chamoji setup to version each one';

const GET_STARTED = 'Run `chamoji setup` to get started.';

/** Whether `release`, `next-version` and `changelog` work per unit: a release section whose shape isn't single. */
function releasesUnits(config: ChamojiConfig): boolean {
	return config.release !== undefined && config.release.shape !== 'single';
}

/** `web  0.1.0 → 0.2.0  minor  3 own, 1 shared` */
function unitLine(unit: UnitPlan): string {
	return `${unit.unit}  ${unit.from ?? 'none'} → ${unit.version}  ${unit.bump}  ${unit.own} own, ${unit.shared} shared`;
}

/**
 * What a unit that isn't releasing has waiting: its own commits that need no
 * release, and the shared ones that ride along with its next one.
 */
function pendingLine({unit, own, shared}: UnitPending): string {
	const ownPart =
		own === 0
			? 'no changes of its own'
			: `no release needed (${own === 1 ? "1 change of its own doesn't" : `${own} changes of its own don't`} need one)`;
	if (shared === 0) return `${unit}: ${ownPart}`;
	const sharedPart =
		shared === 1 ? '1 shared change rides' : `${shared} shared changes ride`;
	return `${unit}: ${ownPart}; ${sharedPart} along with its next release`;
}

/** A unit `--unit` left out, which may well need a release of its own. */
function leftOutLine({unit, own, shared}: UnitPending): string {
	const parts = [
		...(own === 0
			? []
			: [own === 1 ? '1 change of its own' : `${own} changes of its own`]),
		...(shared === 0 ? [] : [`${shared} shared waiting`]),
	];
	return `${unit}: left out by --unit (${parts.join(', ')})`;
}

function tagList(plan: ReadyUnitPlan): string {
	return uniqueTags(plan.units).join(', ');
}

/** A unit's notes heading: its tag, with the unit's name when fixed-group members share the tag. */
function unitHeading(
	units: Array<{unit: string; tag: string}>,
	unit: {unit: string; tag: string},
): string {
	return units.filter(other => other.tag === unit.tag).length > 1
		? `${unit.tag} (${unit.unit})`
		: unit.tag;
}

/** The release notes for one tag: its unit's notes, or a section per unit that shares it. */
function tagNotes(
	units: Array<{unit: string; tag: string; notes: string}>,
): string {
	return units.length === 1
		? units[0]!.notes
		: units
				.map(unit => `## ${unitHeading(units, unit)}\n\n${unit.notes}`)
				.join('\n\n');
}

/** One GitHub release per tag (fixed-group members can share one), or one for the whole release commit under `combined`. */
function githubReleases(
	plan: ReadyUnitPlan,
	config: ChamojiConfig,
): Array<{tag: string; title: string; notes: string; prerelease: boolean}> {
	if (config.release?.githubReleases === 'combined') {
		return [
			{
				tag: plan.units[0]!.tag,
				title: tagList(plan),
				notes: plan.units
					.map(unit => `## ${unitHeading(plan.units, unit)}\n\n${unit.notes}`)
					.join('\n\n'),
				prerelease: plan.units.some(unit => unit.bump === 'prerelease'),
			},
		];
	}

	return uniqueTags(plan.units).map(tag => {
		const members = plan.units.filter(unit => unit.tag === tag);
		return {
			tag,
			title: tag,
			notes: tagNotes(members),
			prerelease: members.some(unit => unit.bump === 'prerelease'),
		};
	});
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

async function jevClassifier(
	io: Io,
	progress: JevClassifierOptions['progress'],
): Promise<CommitClassifier> {
	const client = io.jev ?? (await typesafeClient(io));
	if (!client) throw new Error(MISSING_KEY);
	// Outside a repository there's nowhere to keep judgments, so none are cached.
	const cache = await openJudgmentCache(io.cwd, JUDGMENT_VERSION).catch(
		() => undefined,
	);
	return createJevClassifier(
		{systemOne: async request => client.systemOne(request)},
		{report: line => io.stderr(`${line}\n`), cache, progress},
	);
}
