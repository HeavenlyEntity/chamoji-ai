import {
	buildChangelog,
	CARD_ENDPOINT,
	cardUrl,
	ConfigVersionError,
	loadConfig,
	ReleaseError,
	repoStats,
	type ComposeConfig,
	type FetchLike,
	type NpmRunner,
	type WhyDraft,
} from '@chamoji/core';
import meow from 'meow';
import {runAgentHook} from './agent-hook.js';
import {createCommitAdvisor, type Advice} from './advisor.js';
import {jevClassifier, realReranker, realWhyChecker} from './ai.js';
import {
	ghIn,
	PREFLIGHT_FAILED,
	type CommandContext,
} from './commands/context.js';
import {changelogCommand} from './commands/changelog.js';
import {commit} from './commands/commit.js';
import {hook} from './commands/hook.js';
import {nextVersionCommand} from './commands/next-version.js';
import {publish} from './commands/publish.js';
import {releaseCommand} from './commands/release.js';
import {type ComposerProps, type Impact} from './composer.js';
import {NO_FACE, type Face, type Step} from './face.js';
import {hasFace} from './face-settings.js';
import type {Theme} from './foil.js';
import {jevFace, type JevClient} from './jev-classifier.js';
import {runInit} from './init.js';
import {githubRepo} from './setup/advice.js';
import {runSetup, type SetupScreen} from './setup/setup.js';
import {isStepName, nothingSetUp} from './setup/steps.js';
import {runMcp} from './mcp.js';
import {runMemory} from './memory.js';
import type {MemoryReranker} from './rerank.js';
import {stripControlLines} from './text.js';
import type {UpdateCheck} from './update-check.js';
import {startWarmUp} from './session-brief.js';
import {oneLineLogo, playWelcome, SHORT_HELP, TAGLINE} from './welcome.js';
import {runWhy} from './why.js';
import type {WhyChecker} from './why-check.js';
import {runWorkstream} from './ws.js';

export type {AiSettings} from './ai.js';
export {NO_RELEASE_NEEDED, PREFLIGHT_FAILED} from './commands/context.js';

export type Io = {
	cwd: string;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** `YYYY-MM-DD` used for `--release`; defaults to today. */
	today?: string;
	/**
	 * This CLI's version, which setup pins the release workflow's Action to.
	 * cli.ts passes the real one, tests a fixed one. Without it setup writes
	 * no workflow, since it has nothing to pin.
	 */
	cliVersion?: string;
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
	/** The home folder whose Claude Code and Codex sessions `chamoji.whyFromSessions` reads; defaults to the real one. */
	home?: string;
	/** The terminal the composer runs on, or null when there is none; tests pass a fake. */
	terminal?: () => ComposerTerminal | null;
	/** Environment for the hook's CI check; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/**
	 * The publish credentials (`CHAMOJI_NPM_TOKEN` and the job's OIDC request)
	 * that cli.ts takes out of process.env, so git, gh and the repo's hooks
	 * never see them. Only the publish tools get them.
	 */
	credentials?: Record<string, string>;
	/** Jev's commit sorting for --ai; tests pass a fake. Defaults to the TypeSafe API. */
	jev?: JevClient;
	/** Jev's commit advice; tests pass a fake. Defaults to the TypeSafe API. */
	advise?: ReturnType<typeof createCommitAdvisor>;
	/** Jev's check of a Why (composer and `why --check --ai`); tests pass a fake. Defaults to the TypeSafe API. */
	whyChecker?: WhyChecker;
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
		checkWhy?: ComposerProps['checkWhy'],
		draft?: WhyDraft | Promise<WhyDraft | undefined>,
	): Promise<string | null>;
	close(): void;
};

export type GhRunner = (
	args: string[],
	/** `timeoutMs` kills gh after that long; the run then fails softly. */
	options?: {timeoutMs?: number},
) => Promise<{ok: boolean; message: string}>;

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
	  $ chamoji why --thin [path]      List the commits behind the most lines
	                                   whose Why is thin or missing
	  $ chamoji why --check [--ai] <reason...>
	                                   Say whether a reason is thin (exit 1) or
	                                   ok; --ai also asks Jev (TypeSafe)
	  $ chamoji why --amend <sha|file:line> <reason...>
	                                   Add a better reason to an old commit
	                                   in a git note (refs/notes/chamoji)
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
	  $ chamoji memory resolve <id> --because <reason>
	                                   Record that a card line ended, as an
	                                   empty commit with a Resolves: line
	  $ chamoji memory brief           Print the project's standing notes at
	                                   HEAD, as an agent reads them

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
	                                   MCP (stdio): search_memory, why,
	                                   workstream and brief, which only read,
	                                   and remember_why
	  $ chamoji agent-hook             The hook itself; Claude Code runs it

	Options
	  --format   markdown (default), md, json or html
	  --output   Write to this file instead of stdout
	  --from     changelog: leave out this release tag and everything older.
	             publish: publish what this tag released (repeatable), and
	             create its missing GitHub release once it is all on npm
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
	  --tag      publish and release --publish: the npm dist-tag to publish
	             under, instead of the one the version implies
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
	             memory sync: print the result; memory resolve: print
	             the id and the commit's hash; memory brief: print the
	             text and every card line in every state; setup: print
	             what it found and did (with no --yes, what it would do,
	             writing nothing; exits 2 when something would change)
	  --none     ws switch: clear the active workstream
	  --archived memory list: include archived entries
	  --purge    memory archive: delete the entry and its history instead;
	             memory sync then says what origin needs to lose it too
	  --because  memory resolve: why the line no longer holds (one line,
	             up to 200 characters)
	  --budget   memory brief: the most tokens it may take, 200 to 20000
	             (default 1500)
	  --section  memory brief: only this section: constraints, resolved,
	             gotchas, follow-ups, off-branch, workstreams or recent
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
			amend: {type: 'string'},
			thin: {type: 'boolean'},
			check: {type: 'boolean'},
			none: {type: 'boolean'},
			purge: {type: 'boolean'},
			archived: {type: 'boolean'},
			because: {type: 'string'},
			budget: {type: 'string'},
			section: {type: 'string'},
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
	const jevHost: {step?: Step} = {};
	const jev = jevFace(face, () => jevHost.step);
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
			// themselves, as does why --check. agent-hook has none, and stdout is its decision.
			const classify =
				flags.ai &&
				command !== 'card' &&
				command !== 'memory' &&
				command !== 'mcp' &&
				command !== 'why' &&
				command !== 'agent-hook'
					? jev.wrap(await jevClassifier(io, jev.progress))
					: undefined;
			const ctx: CommandContext = {
				input: cli.input,
				flags,
				io,
				face,
				froms,
				jev,
				jevHost,
				classify,
				run,
			};
			switch (command) {
				case 'changelog': {
					return await changelogCommand(ctx);
				}

				case 'next-version': {
					return await nextVersionCommand(ctx);
				}

				case 'release': {
					return await releaseCommand(ctx);
				}

				case 'publish': {
					return await publish(ctx);
				}

				case 'hook': {
					return await hook(ctx, cli.input[1]);
				}

				case 'commit': {
					return await commit(ctx);
				}

				case 'card': {
					return await card();
				}

				case 'ws': {
					return await runWorkstream(cli.input.slice(1), flags, io);
				}

				case 'why': {
					return await runWhy(cli.input.slice(1), flags, io, async () =>
						realWhyChecker(io),
					);
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
					// Claude Code runs this before and after a Bash command and when a
					// session starts. Whatever happens it prints a decision, the brief,
					// a nudge or nothing, and exits 0. A brief or nudge that runs late
					// has printed nothing, and exiting then keeps a slow git from
					// holding the agent; a warm-up started first finishes the work for
					// next time.
					return await runAgentHook({
						...io,
						stdin: process.stdin,
						warmUp: startWarmUp,
						onTimeout: () => process.exit(0),
					});
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
						{...io, gh: io.gh ?? ghIn(io.cwd)},
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
}

const GET_STARTED = 'Run `chamoji setup` to get started.';
