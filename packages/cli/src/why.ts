import {
	assertGitRepo,
	blameLine,
	parseLocation,
	readMemory,
	readWorkstreams,
	type IntentCard,
	type ParsedCommit,
	type Workstream,
} from '@chamoji/core';
import type {Io} from './run.js';
import {stripControl} from './text.js';

/** Same code run.ts uses for a command that was used wrongly. */
const USAGE_ERROR = 2;

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
	const result = await blameLine(io.cwd, file, line);
	if (flags.json) {
		io.stdout(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.kind === 'uncommitted') {
		io.stdout(`${stripControl(`${file}:${line}`)} is not committed yet.\n`);
	} else {
		const {card, workstream} = result.commit;
		const summary =
			card === undefined && workstream !== undefined
				? await findWorkstream(io.cwd, workstream)
				: undefined;
		io.stdout(describe(result.commit, summary));
	}

	return 0;
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
