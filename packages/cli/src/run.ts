import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	buildChangelog,
	loadConfig,
	render,
	type CommitClassifier,
	type OutputFormat,
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
};

const HELP = `
	Usage
	  $ chamoji changelog [options]    Generate a changelog from git history
	  $ chamoji next-version [options] Print the next semver version
	                                   (exits 3 when no release is needed)

	Options
	  --format   markdown (default), md, json or html
	  --output   Write to this file instead of stdout
	  --from     Leave out this release tag and everything older
	  --to       Ref to treat as the head of history (default: HEAD)
	  --release  Name the unreleased section with this version
	  --config   Config file (default: chamoji.config.json if present)
	  --ai       Sort commits no rule can place with Jev (TypeSafe).
	             Needs TYPESAFE_API_KEY, from the environment or from
	             .env.local / .env here. Sends up to 300 characters of
	             each such commit's subject and body, with emails and
	             trailer lines removed; never diffs, code or authors.
	  --no-update-check
	             Don't check npm for a newer chamoji. Also off in CI, when
	             NO_UPDATE_NOTIFIER or CHAMOJI_NO_UPDATE_CHECK=1 is set,
	             and when stderr isn't a terminal.

	Examples
	  $ chamoji changelog --output CHANGELOG.md
	  $ version=$(chamoji next-version) && chamoji changelog --release "$version" -o CHANGELOG.md
	  $ chamoji changelog --format html --output changelog.html
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
			config: {type: 'string'},
			ai: {type: 'boolean'},
			updateCheck: {type: 'boolean', default: true},
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

				default: {
					io.stderr(
						`${command ? `chamoji: unknown command "${command}"\n` : ''}${cli.help}\n`,
					);
					return 2;
				}
			}
		} catch (error) {
			io.stderr(`chamoji: ${(error as Error).message}\n`);
			return 1;
		}
	}
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
