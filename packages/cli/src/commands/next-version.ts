import {buildChangelog, loadConfig} from '@chamoji/core';
import {runStep} from '../face.js';
import {NO_RELEASE_NEEDED, type CommandContext} from './context.js';
import {planned} from './release-steps.js';
import {
	monorepoHint,
	nextVersions,
	refuseUnitFlags,
	releasesUnits,
} from './release-units.js';

/** `chamoji next-version`: one line per unit when the config releases units. */
export async function nextVersionCommand(ctx: CommandContext): Promise<number> {
	const {io, flags, face, jevHost, classify} = ctx;
	const config = await loadConfig(io.cwd, flags.config);
	if (releasesUnits(config)) {
		return await nextVersions(ctx, config, classify);
	}

	refuseUnitFlags(ctx);
	await monorepoHint(ctx, config);
	// Only --ai has a face here, and Jev's progress shows on this step.
	const next = await runStep(
		face,
		'Working out the next version',
		async step => {
			jevHost.step = step;
			try {
				const {releases} = await buildChangelog({
					cwd: io.cwd,
					config,
					to: flags.to,
					classify,
					classifyReleases: 'unreleased',
				});
				return releases.find(release => release.tag === null)?.nextVersion;
			} finally {
				jevHost.step = undefined;
			}
		},
		found => planned(ctx, found ? `Next version is ${found}` : undefined),
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
