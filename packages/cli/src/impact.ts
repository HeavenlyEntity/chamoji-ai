import {loadConfig, runGit, stagedImpact} from '@chamoji/core';
import type {Impact} from './composer.js';

/**
 * What the staged change touches, for the composer. Only a repo with release
 * units has any; anything that goes wrong means no line, never a failed commit.
 */
export async function composeImpact(root: string): Promise<Impact | undefined> {
	try {
		const config = await loadConfig(root);
		if (!config.release || config.release.shape === 'single') return undefined;
		const staged = await runGit(
			['diff', '--cached', '--name-only', '-z'],
			root,
		);
		const impact = await stagedImpact(
			root,
			config,
			staged.split('\0').filter(Boolean),
		);
		return impact.own.length + impact.rides.length > 0 ? impact : undefined;
	} catch {
		return undefined;
	}
}
