import semver from 'semver';
import {ReleaseError} from '../release.js';

/** The dist-tag a version goes under, or why it can't go under `latest`. */
export function distTagFor(
	version: string,
	latest: string | null,
	options: {tag?: string; prereleaseTag: string},
): string {
	if (options.tag) return options.tag;
	if (semver.prerelease(version)) return options.prereleaseTag;
	if (latest && semver.valid(latest) && semver.lt(version, latest)) {
		throw new ReleaseError(
			'publish-check',
			`${version} is lower than latest (${latest}); pass --tag to publish it under another dist-tag, for example --tag v${semver.major(version)}`,
		);
	}

	return 'latest';
}
