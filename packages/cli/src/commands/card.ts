import {
	buildChangelog,
	CARD_ENDPOINT,
	cardUrl,
	loadConfig,
	repoStats,
} from '@chamoji/core';
import {githubRepo} from '../setup/advice.js';
import type {CommandContext} from './context.js';

export async function card(ctx: CommandContext): Promise<number> {
	const {io, flags} = ctx;
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
