import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	applyRelease,
	buildChangelog,
	loadConfig,
	planRelease,
	pushRelease,
	ReleaseError,
	render,
	runGit,
	type CommitClassifier,
	type OutputFormat,
	type ReadyPlan,
} from '@chamoji/core';
import {TypeSafeClient} from '@typesafe-ai/sdk';
import meow from 'meow';
import {readTypesafeKey} from './env.js';
import {createJevClassifier} from './jev-classifier.js';
import type {UpdateCheck} from './update-check.js';

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
	  --dry-run  release: show the version and notes, change nothing
	  --push     release: push HEAD and the tag, then create the GitHub
	             release when the gh CLI is installed
	  --trailer  release: add "Key: value" to the release commit (repeatable)
	  --any-branch
	             release: allow a branch other than origin's default
	  --json     release: print the result as JSON
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
	const check = flags.updateCheck ? io.updateCheck : undefined;
	check?.refreshIfStale();
	const code = await execute(cli.input[0]);
	const notice = check?.notice();
	if (notice) {
		io.stderr(`\n${notice}\n`);
	}

	return code;

	async function execute(command: string | undefined): Promise<number> {
		try {
			const classify = flags.ai ? await jevClassifier(io) : undefined;
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

				default: {
					io.stderr(
						`${command ? `chamoji: unknown command "${command}"\n` : ''}${cli.help}\n`,
					);
					return 2;
				}
			}
		} catch (error) {
			io.stderr(`chamoji: ${(error as Error).message}\n`);
			return error instanceof ReleaseError ? PREFLIGHT_FAILED : 1;
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
		if (flags.push) {
			try {
				await pushRelease(plan);
				pushed = `yes (HEAD and ${plan.tag})`;
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
					: `; GitHub release not created: ${result.message}`;
			} catch (error) {
				pushError = (error as Error).message;
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
				notes: plan.notes,
			},
		);
		return pushError ? 1 : 0;
	}
}

/** Exit code for a release check that failed before anything changed. */
export const PREFLIGHT_FAILED = 2;

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

async function jevClassifier(io: Io): Promise<CommitClassifier> {
	const key = await readTypesafeKey(io.cwd, process.env);
	if (!key) {
		throw new Error(
			'--ai needs a TypeSafe API key: set TYPESAFE_API_KEY in the environment or in .env.local (get one at https://typesafe.ai)',
		);
	}

	// Keys copied from a dashboard often end in "…"; headers can't carry it.
	const invalid = /[^\x21-\x7E]/.exec(key);
	if (invalid) {
		throw new Error(
			invalid[0] === '\u2026'
				? 'TYPESAFE_API_KEY contains "…", so it looks truncated; copy the full key again'
				: 'TYPESAFE_API_KEY contains a character that is not plain ASCII; copy the full key again',
		);
	}

	const client = new TypeSafeClient({apiKey: key});
	return createJevClassifier(
		{systemOne: async request => client.systemOne(request)},
		{report: line => io.stderr(`${line}\n`)},
	);
}
