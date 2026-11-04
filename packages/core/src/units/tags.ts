import semver from 'semver';
import type {ReleaseTag} from '../git.js';
import type {ReleaseSettings} from './settings.js';
import type {ResolvedUnit} from './workspace.js';

export type UnitTag = {tag: string; version: string; date: string};

type Values = {unit: string; name: string};

const PLACEHOLDER = /\{(unit|name|version)\}/g;
// `v?`, digits and dots, then an optional prerelease. `semver.coerce` tidies it.
const VERSION_PATTERN = 'v?\\d[\\d.]*(?:-[0-9A-Za-z.-]+)?';

/** Escapes regex syntax so `text` matches itself outside a character class. */
export const escapeRegExp = (text: string): string =>
	text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Fills a tag template. Throws when a placeholder it uses has no value. */
export function renderTag(
	template: string,
	values: {unit: string; name: string; version: string},
): string {
	return template.replaceAll(
		PLACEHOLDER,
		(_match, key: keyof typeof values) => {
			const value = values[key];
			if (value === '') {
				throw new Error(
					`Can't fill {${key}} in tag template "${template}": it has no value`,
				);
			}

			return value;
		},
	);
}

/** The version a tag carries under `template`, or null. Loose: '1.2' -> '1.2.0', '1.2.3.4' -> '1.2.3', prereleases kept. */
export function versionFromTag(
	tag: string,
	template: string,
	values: Values,
): string | null {
	let source = '';
	let last = 0;
	let hasVersion = false;
	for (const match of template.matchAll(PLACEHOLDER)) {
		source += escapeRegExp(template.slice(last, match.index));
		last = match.index + match[0].length;
		const key = match[1] as 'unit' | 'name' | 'version';
		if (key === 'version') {
			// Only the first one is captured.
			source += hasVersion ? `(?:${VERSION_PATTERN})` : `(${VERSION_PATTERN})`;
			hasVersion = true;
		} else {
			if (values[key] === '') return null;
			source += escapeRegExp(values[key]);
		}
	}

	if (!hasVersion) return null;
	source += escapeRegExp(template.slice(last));

	const found = new RegExp(`^${source}$`).exec(tag);
	if (!found) return null;
	return semver.coerce(found[1]!, {includePrerelease: true})?.version ?? null;
}

/** Whether one `tags.ignore` pattern matches the tag. */
export function matchesTagPattern(tag: string, pattern: string): boolean {
	return new RegExp(pattern).test(tag);
}

/** Whether an ignore pattern from `tags.ignore` matches the whole tag name. */
export function isIgnoredTag(tag: string, settings: ReleaseSettings): boolean {
	return settings.tags.ignore.some(pattern => matchesTagPattern(tag, pattern));
}

/** This unit's releases, newest version first, after ignore patterns and aliases. */
export function unitTagHistory(
	tags: ReleaseTag[],
	unit: ResolvedUnit,
	settings: ReleaseSettings,
): UnitTag[] {
	const values: Values = {unit: unit.name, name: unit.pkg?.name ?? ''};
	const templates = [unit.tag, ...unit.read];
	// Per version: the best-ranked tag (template, then read template, then alias).
	const best = new Map<string, {rank: number; entry: UnitTag}>();

	for (const {name: tag, date} of tags) {
		if (isIgnoredTag(tag, settings)) continue;

		let version: string | null = null;
		let rank = templates.length;
		const alias = settings.tags.aliases[tag];
		if (alias) {
			// An alias is an explicit assignment: it wins over what a template
			// would read, and keeps the tag out of every other unit's history.
			if (alias.unit !== unit.name) continue;
			version = semver.valid(
				semver.coerce(alias.version, {includePrerelease: true}),
			);
		} else {
			for (const [index, template] of templates.entries()) {
				version = versionFromTag(tag, template, values);
				if (version !== null) {
					rank = index;
					break;
				}
			}
		}

		if (version === null) continue;
		const current = best.get(version);
		if (!current || rank < current.rank) {
			best.set(version, {rank, entry: {tag, version, date}});
		}
	}

	return [...best.values()]
		.map(({entry}) => entry)
		.sort((a, b) => semver.rcompare(a.version, b.version));
}
