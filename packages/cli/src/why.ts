import {
	assertGitRepo,
	blameLine,
	findClues,
	judgeWhy,
	parseLocation,
	readMemory,
	readWorkstreams,
	type IntentCard,
	type ParsedCommit,
	type Workstream,
	type WhyClues,
	type WhyQuality,
	type WhyReason,
} from '@chamoji/core';
import {NO_FACE, runStep} from './face.js';
import type {Io} from './run.js';
import {stripControl} from './text.js';

/** Same code run.ts uses for a command that was used wrongly. */
const USAGE_ERROR = 2;

const THIN_NOTICE =
	'This reason is thin. Look at the PR, issue and nearby commits too.';

/** A commit's reason: how good it is and, when it isn't good, where to look. */
export type WhyReading = {
	quality: WhyQuality;
	reasons: WhyReason[];
	clues?: WhyClues;
};

const CARD_LABELS: [keyof IntentCard, string][] = [
	['why', 'Why'],
	['constraint', 'Constraint'],
	['gotcha', 'Gotcha'],
	['followUp', 'Follow-up'],
];

/**
 * `chamoji why <file:line>`: the commit that wrote the line, with the intent
 * it recorded. `input` is what follows `why`. A location git can't blame
 * throws a WhyError, which run.ts reports and exits 1 for; misuse of the
 * command exits 2. Reads git only; nothing is changed or sent anywhere.
 */
export async function runWhy(
	input: string[],
	flags: {json?: boolean},
	io: Io,
): Promise<number> {
	const [location, ...extra] = input;
	if (location === undefined || extra.length > 0) {
		io.stderr('chamoji: why needs one location: chamoji why <file:line>\n');
		return USAGE_ERROR;
	}

	await assertGitRepo(io.cwd);
	const {file, line} = parseLocation(location);
	const {result, reading, summary} = await runStep(
		io.face ?? NO_FACE,
		'Finding the commit that wrote the line',
		async () => {
			const result = await blameLine(io.cwd, file, line);
			if (result.kind === 'uncommitted') return {result};
			const {workstream} = result.commit;
			const reading = await readWhy(io.cwd, result.commit, file);
			if (flags.json) return {result, reading};
			const summary =
				reading.quality !== 'ok' && workstream !== undefined
					? await findWorkstream(io.cwd, workstream)
					: undefined;
			return {result, reading, summary};
		},
		({result}) => ({
			outcome: 'ok',
			text:
				result.kind === 'uncommitted'
					? 'The line is not committed yet'
					: 'Found the commit',
		}),
	);
	if (result.kind === 'uncommitted') {
		io.stdout(
			flags.json
				? `${JSON.stringify(result, null, 2)}\n`
				: `${stripControl(`${file}:${line}`)} is not committed yet.\n`,
		);
	} else if (flags.json) {
		const {quality, reasons, clues} = reading!;
		io.stdout(
			`${JSON.stringify({...result, whyQuality: quality, whyReasons: reasons, clues}, null, 2)}\n`,
		);
	} else {
		io.stdout(describe(result.commit, reading!, summary));
	}

	return 0;
}

/**
 * How good the commit's Why is, judged against its description. A thin or
 * missing one comes with clues; a good one needs none.
 */
export async function readWhy(
	cwd: string,
	commit: ParsedCommit,
	file: string,
): Promise<WhyReading> {
	if (commit.card === undefined) {
		return {
			quality: 'none',
			reasons: [],
			clues: await findClues(cwd, commit, file),
		};
	}

	const {level, reasons} = judgeWhy(commit.card, commit.description);
	return level === 'ok'
		? {quality: 'ok', reasons}
		: {quality: 'thin', reasons, clues: await findClues(cwd, commit, file)};
}

/**
 * What memory, or failing that the workstreams file, knows of `slug`. Memory
 * outlives the branch. This only adds to the answer, so a damaged entry or
 * file leaves it out instead of failing the command.
 */
export async function findWorkstream(
	cwd: string,
	slug: string,
): Promise<Pick<Workstream, 'title' | 'emoji' | 'status'> | undefined> {
	const remembered = await readMemory(cwd, slug).catch(() => undefined);
	if (remembered) return remembered;
	const workstreams = await readWorkstreams(cwd).catch(() => []);
	return workstreams.find(item => item.slug === slug);
}

/**
 * Commit text can come from a clone, so none of it reaches the terminal raw.
 * That goes for the hash and date too: a separator byte in an author name
 * moves other text into those fields.
 */
function describe(
	{shortHash, subject, authorName, date, card}: ParsedCommit,
	{quality, clues}: WhyReading,
	workstream?: Pick<Workstream, 'title' | 'emoji' | 'status'>,
) {
	const lines = [
		`${stripControl(shortHash)} ${stripControl(subject)}`,
		`${stripControl(authorName)}, ${stripControl(date).slice(0, 10)}`,
		'',
	];
	const recorded = cardLines(card);
	lines.push(
		...(recorded.length > 0 ? recorded : ['This commit records no intent.']),
	);
	if (quality === 'thin') lines.push(THIN_NOTICE);
	if (clues?.pr !== undefined) lines.push(`PR: #${clues.pr}`);
	for (const near of clues?.nearby ?? []) {
		lines.push(
			`Nearby: ${stripControl(near.shortHash)} ${stripControl(near.subject)}`,
			...cardLines(near.card).map(line => `  ${line}`),
		);
	}

	if (workstream) {
		const {emoji, title, status} = workstream;
		lines.push(
			`Workstream: ${stripControl(`${emoji ? `${emoji} ` : ''}${title}`)} (${status})`,
		);
	}

	return `${lines.join('\n')}\n`;
}

/** A card as `Label: value` lines, safe to print. */
export function cardLines(card: IntentCard | undefined): string[] {
	return CARD_LABELS.flatMap(([key, label]) =>
		(card?.[key] ?? []).map(value => `${label}: ${stripControl(value)}`),
	);
}
