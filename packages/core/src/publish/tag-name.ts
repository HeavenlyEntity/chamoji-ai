import semver from 'semver';

/**
 * Whether `tag` can be an npm dist-tag: a plain word that npm can't mistake
 * for an option, a version or a range.
 */
export function isDistTag(tag: string): boolean {
	return (
		/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag) &&
		!semver.valid(tag) &&
		!semver.validRange(tag)
	);
}
