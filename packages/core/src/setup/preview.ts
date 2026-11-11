import {ReleaseError} from '../release.js';
import type {ChamojiConfig} from '../types.js';
import {committedSection, unitChangelog} from '../units/history.js';
import {renderUnitSection} from '../units/notes.js';
import {planUnitReleases} from '../units/plan.js';
import {parseReleaseSettings} from '../units/settings.js';
import {runGit} from '../git.js';
import type {SetupAnswers} from './answers.js';
import {releaseSection} from './section.js';

export type PreviewUnit =
	| {
			unit: string;
			status: 'releases';
			/** The version before this release: the last tag's, else the manifest's. */
			from: string | null;
			version: string;
			tag: string;
			bump: string;
			own: number;
			shared: number;
			notes: string[];
	  }
	| {unit: string; status: 'waits'; own: number; shared: number};

export type Preview = {
	heading: string;
	units: PreviewUnit[];
	warnings: string[];
	/** The other files setup would write, which the CLI adds; the engine's preview has none. */
	files?: Array<{file: string; how: string}>;
};

const NOTE_LINES = 6;
const REPLAY_TAGS = 5;
const REPLAY_EXAMPLES = 2;

/** The config as it would be once the answers are written. */
function withAnswers(config: ChamojiConfig, answers: SetupAnswers) {
	return {
		...config,
		release: parseReleaseSettings(
			releaseSection(answers),
			'chamoji.config.json',
		),
	};
}

/**
 * What the next release would be under these answers: the engine's own plan,
 * run on whatever is checked out, with nothing fetched or written.
 */
export async function previewReleases(
	root: string,
	config: ChamojiConfig,
	answers: SetupAnswers,
	today: string,
): Promise<Preview> {
	const heading = 'The next release from here would be:';
	try {
		const plan = await planUnitReleases({
			cwd: root,
			config: withAnswers(config, answers),
			fetch: false,
			allowDirty: true,
			anyBranch: true,
			today,
		});
		const units: PreviewUnit[] = [];
		const releasing = new Set<string>();
		if (plan.status === 'ready') {
			for (const item of plan.units) {
				releasing.add(item.unit);
				units.push({
					unit: item.unit,
					status: 'releases',
					from: item.from,
					version: item.version,
					tag: item.tag,
					bump: item.bump,
					own: item.own,
					shared: item.shared,
					notes: item.notes.split('\n').slice(0, NOTE_LINES),
				});
			}
		}

		for (const item of plan.pending) {
			if (releasing.has(item.unit)) continue;
			units.push({
				unit: item.unit,
				status: 'waits',
				own: item.own,
				shared: item.shared,
			});
		}

		return {
			heading,
			units,
			warnings: plan.status === 'ready' ? plan.warnings : [],
		};
	} catch (error) {
		if (error instanceof ReleaseError) {
			return {heading, units: [], warnings: [error.message]};
		}

		throw error;
	}
}

export type ReplayLine = {
	unit: string;
	tag: string;
	/** The release's version, as the unit's tag formats read it. */
	version: string;
	/** Entries in the section the release shipped with; null when it had none. */
	shipped: number | null;
	/** Entries chamoji would write now. */
	chamoji: number;
	/** In chamoji's section and not in the shipped one. */
	extra: string[];
	/** In the shipped section and not in chamoji's. */
	missing: string[];
};

const HASH = String.raw`(?:\[[0-9a-f]{6,40}\]\([^)]*\)|[0-9a-f]{6,40})`;
const TRAILER = new RegExp(
	String.raw`(?:\s*\((?:${HASH}|via \`[^\`]*\`)\))+\s*$`,
	'i',
);

const entries = (section: string): string[] =>
	section
		.split('\n')
		.filter(line => line.startsWith('- '))
		.map(line => line.slice(2).replace(TRAILER, '').trim());

/** What entries are matched on: the text without emoji or shortcodes. */
const key = (entry: string): string =>
	entry
		.replaceAll(/\p{Extended_Pictographic}️?|:[a-z0-9_+-]+:/gu, '')
		.replaceAll(/\s+/g, ' ')
		.trim();

/** Entries of `from` that `other` has no match for, one match used once. */
function lacking(from: string[], other: string[]): string[] {
	const spare = new Map<string, number>();
	for (const entry of other) {
		spare.set(key(entry), (spare.get(key(entry)) ?? 0) + 1);
	}

	return from.filter(entry => {
		const left = spare.get(key(entry)) ?? 0;
		if (left > 0) {
			spare.set(key(entry), left - 1);
			return false;
		}

		return true;
	});
}

/**
 * The last releases of each unit as chamoji would write them under these
 * answers, set beside the section each one shipped with.
 */
export async function replayReleases(
	root: string,
	config: ChamojiConfig,
	answers: SetupAnswers,
): Promise<ReplayLine[]> {
	const candidate = withAnswers(config, answers);
	const top = (await runGit(['rev-parse', '--show-toplevel'], root)).trim();
	const lines: ReplayLine[] = [];
	for (const unit of candidate.release.units) {
		const changelog = await unitChangelog({
			cwd: top,
			config: candidate,
			unit: unit.name,
		});
		const released = changelog.releases
			.filter(release => release.tag !== null)
			.slice(0, REPLAY_TAGS);
		for (const release of released) {
			const mine = entries(
				renderUnitSection(release, changelog.repositoryUrl, null),
			);
			const shippedText = await committedSection(
				top,
				release.tag!,
				unit.changelog,
				release.version,
			);
			const shipped = shippedText === null ? null : entries(shippedText);
			lines.push({
				unit: unit.name,
				tag: release.tag!,
				version: release.version,
				shipped: shipped?.length ?? null,
				chamoji: mine.length,
				extra: shipped ? lacking(mine, shipped).slice(0, REPLAY_EXAMPLES) : [],
				missing: shipped
					? lacking(shipped, mine).slice(0, REPLAY_EXAMPLES)
					: [],
			});
		}
	}

	return lines;
}

const count = (n: number): string => `${n} ${n === 1 ? 'entry' : 'entries'}`;
const quoted = (items: string[]): string =>
	items.map(item => `"${item}"`).join(' and ');

/** One line saying how a past release compares. */
export function replayText(line: ReplayLine): string {
	const name = `${line.unit} v${line.version}`;
	if (line.shipped === null) {
		return `${name}: no changelog then; chamoji would write ${count(line.chamoji)}`;
	}

	if (
		line.shipped === line.chamoji &&
		line.extra.length === 0 &&
		line.missing.length === 0
	) {
		return `${name}: same ${count(line.chamoji)}`;
	}

	const parts = [
		`${name}: you shipped ${count(line.shipped)}; chamoji would write ${line.chamoji}`,
	];
	if (line.extra.length > 0) {
		parts.push(
			`and the ${line.extra.length === 1 ? 'extra one is' : 'extras are'} ${quoted(line.extra)}`,
		);
	}

	if (line.missing.length > 0) {
		parts.push(`and it would leave out ${quoted(line.missing)}`);
	}

	return parts.join(', ');
}
