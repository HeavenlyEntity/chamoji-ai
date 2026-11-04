import {DEFAULT_GROUP_CONFIG} from '../config.js';
import {insertSection, stripTitle} from '../release.js';
import {renderMarkdown} from '../render/markdown.js';
import {safeRepositoryUrl} from '../render/shared.js';
import type {Group, Release} from '../types.js';

export type ChangelogStyle = {
	/** The `## ` line for a release; `version` is the plain version, e.g. `1.3.0`. */
	heading: (r: {
		version: string;
		tag: string;
		date: string;
		previousTag: string | null;
		repositoryUrl?: string;
	}) => string;
	/** Section labels by group, e.g. `{added: 'Features'}`. */
	labels: Record<string, string>;
};

/** Labels other changelogs use, lowercased, and the group each one means. */
const SYNONYMS: Record<string, string> = {
	added: 'added',
	features: 'added',
	feature: 'added',
	'new features': 'added',
	changed: 'changed',
	changes: 'changed',
	deprecated: 'deprecated',
	deprecations: 'deprecated',
	removed: 'removed',
	removals: 'removed',
	fixed: 'fixed',
	fixes: 'fixed',
	'bug fixes': 'fixed',
	bugfixes: 'fixed',
	security: 'security',
	'breaking changes': 'breaking_changes',
	breaking: 'breaking_changes',
	documentation: 'documentation',
	docs: 'documentation',
	maintenance: 'maintenance',
	chores: 'maintenance',
	dependencies: 'dependencies',
	miscellaneous: 'misc',
	other: 'misc',
};

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
/** `[`, `v`, the version, then `]` and an optional `(link)`, then the rest. */
const HEADING = new RegExp(
	String.raw`^## (\[)?(v)?(${VERSION})(?:(\])(\([^)\s]+\))?)?(.*)$`,
);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LONG_DATE = /^(\d{1,2}) ([A-Z][a-z]+) \d{4}$/;
/**
 * What `renderMarkdown` writes for a released section: the version, or the
 * version linked to a compare view, then ` - YYYY-MM-DD`.
 */
const OURS =
	/^## (?:\[[^\]]+\]\(https?:\/\/[^)\s]+\/compare\/[^)\s]+\)|[^\s[]+) - \d{4}-\d{2}-\d{2}$/;

const CHANGED = 'changed';
const ORDER = DEFAULT_GROUP_CONFIG.map(item => item.group);
const defaultLabel = (group: string) =>
	DEFAULT_GROUP_CONFIG.find(item => item.group === group)?.label;

/** The style of an existing changelog's newest entry, or null for chamoji's own. */
export function readStyle(existing: string): ChangelogStyle | null {
	const lines = existing.split('\n').map(line => line.trimEnd());
	const start = lines.findIndex(
		line => line.startsWith('## ') && !/^## \[?unreleased\]?/i.test(line),
	);
	if (start === -1) {
		return null;
	}

	const line = lines[start]!;
	const labels: Record<string, string> = {};
	for (const next of lines.slice(start + 1)) {
		if (next.startsWith('## ')) {
			break;
		}

		if (next.startsWith('### ')) {
			const label = next.slice(4).trim();
			const group = SYNONYMS[label.toLowerCase()];
			if (group !== undefined && labels[group] === undefined) {
				labels[group] = label;
			}
		}
	}

	if (
		OURS.test(line) &&
		Object.entries(labels).every(
			([group, label]) => label === defaultLabel(group),
		)
	) {
		return null;
	}

	const heading = parseHeading(line);
	return heading ? {heading, labels} : null;
}

type DateForm = {
	form: 'iso' | 'long' | 'none';
	/** ` - `, ` – `, or ` (` for a date in parentheses. */
	separator: string;
	padDay: boolean;
};

function parseHeading(line: string): ChangelogStyle['heading'] | null {
	const match = HEADING.exec(line);
	if (!match) {
		return null;
	}

	const [, open, v, , close, link, rest = ''] = match;
	if ((open === undefined) !== (close === undefined)) {
		return null;
	}

	const date = parseDate(rest);
	if (date === null) {
		return null;
	}

	return r => {
		const version = `${v ?? ''}${r.version.replace(/^v/, '')}`;
		const url = safeRepositoryUrl({
			...(r.repositoryUrl ? {repositoryUrl: r.repositoryUrl} : {}),
			releases: [],
		});
		const title =
			open === undefined
				? version
				: link !== undefined && url && r.previousTag
					? `[${version}](${url}/compare/${r.previousTag}...${r.tag})`
					: `[${version}]`;
		const when = formatDate(r.date, date);
		if (when === '') {
			return `## ${title}`;
		}

		return date.separator === ' ('
			? `## ${title} (${when})`
			: `## ${title}${date.separator}${when}`;
	};
}

/** The date form after the version: none, or a known date after `-`, `–` or in `( )`. */
function parseDate(rest: string): DateForm | null {
	if (rest === '') {
		return {form: 'none', separator: '', padDay: false};
	}

	const parts = /^( [-–] )(.+)$/.exec(rest) ?? /^( \()(.+)\)$/.exec(rest);
	if (parts === null) {
		return null;
	}

	const separator = parts[1]!;
	const text = parts[2]!;
	if (ISO_DATE.test(text)) {
		return {form: 'iso', separator, padDay: false};
	}

	const long = LONG_DATE.exec(text);
	if (long && MONTHS.includes(long[2]!)) {
		return {form: 'long', separator, padDay: long[1]!.length === 2};
	}

	return null;
}

function formatDate(iso: string, {form, padDay}: DateForm): string {
	if (form === 'none' || !ISO_DATE.test(iso)) {
		return '';
	}

	if (form === 'iso') {
		return iso;
	}

	const [year, month, day] = iso.split('-');
	const dayText = padDay ? day! : String(Number(day));
	return `${dayText} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** The markdown section for one unit release, in `style` when given. */
export function renderUnitSection(
	release: Release,
	repositoryUrl: string | undefined,
	style: ChangelogStyle | null,
	options?: {rootChanges?: number},
): string {
	const rootChanges = options?.rootChanges ?? 0;
	let groups: Group[] = style
		? release.groups.map(group => ({
				...group,
				label: style.labels[group.group] ?? group.label,
			}))
		: release.groups;
	if (rootChanges > 0 && !groups.some(group => group.group === CHANGED)) {
		groups = withChanged(
			groups,
			style?.labels[CHANGED] ?? defaultLabel(CHANGED) ?? 'Changed',
		);
	}

	const lines = stripTitle(
		renderMarkdown({
			...(repositoryUrl ? {repositoryUrl} : {}),
			releases: [{...release, groups}],
		}),
	).split('\n');

	if (style) {
		lines[0] = style.heading({
			version: plainVersion(release.version),
			tag: release.tag ?? 'HEAD',
			date: release.date ?? '',
			previousTag: release.previousTag,
			...(repositoryUrl ? {repositoryUrl} : {}),
		});
	}

	if (rootChanges > 0) {
		const before =
			(release.highlights?.length ? 1 : 0) +
			groups.findIndex(group => group.group === CHANGED);
		addToSection(
			lines,
			before,
			`- Tooling and CI: ${rootChanges} change${rootChanges === 1 ? '' : 's'}`,
		);
	}

	return lines.join('\n');
}

/** `groups` with an empty Changed group where chamoji's order puts it. */
function withChanged(groups: Group[], label: string): Group[] {
	const rank = (group: string) => {
		const index = ORDER.indexOf(group);
		return index === -1 ? Infinity : index;
	};

	const at = groups.findIndex(group => rank(group.group) > rank(CHANGED));
	const changed: Group = {group: CHANGED, label, commits: []};
	return at === -1
		? [...groups, changed]
		: [...groups.slice(0, at), changed, ...groups.slice(at)];
}

/** Adds `item` as the last line of the `index`-th `### ` section, in place. */
function addToSection(lines: string[], index: number, item: string): void {
	let seen = -1;
	const heading = lines.findIndex(
		line => line.startsWith('### ') && ++seen === index,
	);
	let end = lines.findIndex(
		(line, at) => at > heading && line.startsWith('### '),
	);
	if (end === -1) {
		end = lines.length;
	}

	const items = lines.slice(heading + 1, end).filter(line => line !== '');
	lines.splice(
		heading,
		end - heading,
		lines[heading]!,
		'',
		...items,
		item,
		...(end < lines.length ? [''] : []),
	);
}

/** `1.3.0` from `1.3.0`, `v1.3.0`, `web/v1.3.0` or `@acme/ui@1.3.0`. */
function plainVersion(version: string): string {
	return new RegExp(`${VERSION}$`).exec(version)?.[0] ?? version;
}

/**
 * The section for `version` in a changelog: from its `## ` heading, in any
 * style `readStyle` reads, to the next `## ` heading, without trailing blank
 * lines. Null when no heading names that version.
 */
export function sectionFor(changelog: string, version: string): string | null {
	const lines = changelog.split('\n').map(line => line.trimEnd());
	const start = lines.findIndex(line => {
		const match = HEADING.exec(line);
		return match !== null && match[3] === version;
	});
	if (start === -1) {
		return null;
	}

	let end = lines.findIndex(
		(line, index) => index > start && line.startsWith('## '),
	);
	if (end === -1) {
		end = lines.length;
	}

	return lines.slice(start, end).join('\n').trimEnd();
}

/** The new text of the unit's changelog file: a new file with the title and this section, or `insertSection` into the existing one. */
export function writeUnitChangelog(
	existing: string | null,
	section: string,
): string {
	return existing === null || existing.trim() === ''
		? `# Changelog\n\n${section}\n`
		: insertSection(existing, section);
}
