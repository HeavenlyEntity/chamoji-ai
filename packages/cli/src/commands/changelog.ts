import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	buildChangelog,
	loadConfig,
	render,
	type OutputFormat,
} from '@chamoji/core';
import type {CommandContext} from './context.js';
import {
	changelogUnits,
	refuseUnitFlags,
	releasesUnits,
} from './release-units.js';

const FORMATS: Record<string, OutputFormat> = {
	markdown: 'markdown',
	md: 'markdown',
	json: 'json',
	html: 'html',
};

/** `chamoji changelog`: per unit when the config releases units. */
export async function changelogCommand(ctx: CommandContext): Promise<number> {
	const {io, flags, froms, classify} = ctx;
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
		return await changelogUnits(ctx, config, format, classify);
	}

	refuseUnitFlags(ctx);
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
