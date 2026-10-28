import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	buildChangelog,
	loadConfig,
	render,
	type OutputFormat,
} from '@chamoji/core';
import meow from 'meow';

export type Io = {
	cwd: string;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** `YYYY-MM-DD` used for `--release`; defaults to today. */
	today?: string;
};

const HELP = `
	Usage
	  $ chamoji changelog [options]    Generate a changelog from git history
	  $ chamoji next-version [options] Print the next semver version

	Options
	  --format   markdown (default), md, json or html
	  --output   Write to this file instead of stdout
	  --from     Leave out this release tag and everything older
	  --to       Ref to treat as the head of history (default: HEAD)
	  --release  Name the unreleased section with this version
	  --config   Config file (default: chamoji.config.json if present)

	Examples
	  $ chamoji changelog --output CHANGELOG.md
	  $ chamoji changelog --release $(chamoji next-version) --output CHANGELOG.md
	  $ chamoji changelog --format html --output changelog.html
`;

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

	const [command] = cli.input;
	try {
		switch (command) {
			case 'changelog': {
				const format = FORMATS[flags.format];
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
				});
				const unreleased = releases.find(release => release.tag === null);
				io.stdout(`${unreleased?.nextVersion ?? 'none'}\n`);
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
