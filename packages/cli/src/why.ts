import {
	assertGitRepo,
	blameLine,
	parseLocation,
	type IntentCard,
	type ParsedCommit,
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
		io.stdout(describe(result.commit));
	}

	return 0;
}

/** Commit text can come from a clone, so none of it reaches the terminal raw. */
function describe({shortHash, subject, authorName, date, card}: ParsedCommit) {
	const lines = [
		`${shortHash} ${stripControl(subject)}`,
		`${stripControl(authorName)}, ${date.slice(0, 10)}`,
		'',
	];
	const recorded = CARD_LABELS.flatMap(([key, label]) =>
		(card?.[key] ?? []).map(value => `${label}: ${stripControl(value)}`),
	);
	lines.push(
		...(recorded.length > 0 ? recorded : ['This commit records no intent.']),
	);
	return `${lines.join('\n')}\n`;
}
