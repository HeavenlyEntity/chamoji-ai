import semver from 'semver';
import {ReleaseError} from '../release.js';
import {isDistTag} from './tag-name.js';

/** The dist-tag a version goes under, or why it can't go under `latest`. */
export function distTagFor(
	version: string,
	latest: string | null,
	options: {tag?: string; prereleaseTag: string},
): string {
	const checked = (tag: string): string => {
		if (!isDistTag(tag)) {
			throw new ReleaseError(
				'publish-check',
				`"${tag}" can't be a dist-tag; use a word such as next or v1, not a version, a range or an option`,
			);
		}

		return tag;
	};

	if (options.tag) return checked(options.tag);
	if (semver.prerelease(version)) return checked(options.prereleaseTag);
	if (latest && semver.valid(latest) && semver.lt(version, latest)) {
		throw new ReleaseError(
			'publish-check',
			`${version} is lower than latest (${latest}); pass --tag to publish it under another dist-tag, for example --tag release-${semver.major(version)}`,
		);
	}

	return 'latest';
}
