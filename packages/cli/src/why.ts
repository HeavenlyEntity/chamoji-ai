import {
	assertGitRepo,
	blameLine,
	findClues,
	judgeWhy,
	listThinWhys,
	mergeCards,
	noteCard,
	parseLocation,
	readCommits,
	parseCommit,
	readNoteCard,
	runGit,
	WHY_ADVICE,
	writeNoteCard,
	NOTES_REF,
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
	/** The reason added later in a git note, when there is one. */
	added?: IntentCard;
	/** The commit's card with the added reason first. */
	card?: IntentCard;
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
	flags: {json?: boolean; amend?: string; thin?: boolean},
	io: Io,
): Promise<number> {
	if (flags.amend !== undefined) return amendWhy(flags.amend, input, io);
	if (flags.thin) return thinWhys(input, flags, io);
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
		const {quality, reasons, clues, added} = reading!;
		io.stdout(
			`${JSON.stringify({...result, whyQuality: quality, whyReasons: reasons, clues, addedLater: added}, null, 2)}\n`,
		);
	} else {
		io.stdout(describe(result.commit, reading!, summary));
	}

	return 0;
}

/**
 * `chamoji why --thin [path]`: the commits behind the most lines under `path`
 * whose Why is thin or missing, so a team fixing old reasons knows where to
 * start. Reads git only.
 */
async function thinWhys(
	input: string[],
	flags: {json?: boolean},
	io: Io,
): Promise<number> {
	if (input.length > 1) {
		io.stderr(
			'chamoji: why --thin takes one path: chamoji why --thin [path]\n',
		);
		return USAGE_ERROR;
	}

	await assertGitRepo(io.cwd);
	const path = input[0] ?? '.';
	const found = await runStep(
		io.face ?? NO_FACE,
		'Reading who wrote each line',
		async () => listThinWhys(io.cwd, path),
		items => ({
			outcome: 'ok',
			text:
				items.length === 0
					? 'Every commit gives a reason'
					: `Found ${items.length} ${items.length === 1 ? 'commit' : 'commits'} to improve`,
		}),
	);
	if (flags.json) {
		io.stdout(`${JSON.stringify(found, null, 2)}\n`);
		return 0;
	}

	if (found.length === 0) {
		io.stdout(`No thin Whys behind ${stripControl(path)}.\n`);
		return 0;
	}

	const lines = found.flatMap(item => [
		`${item.lines} ${item.lines === 1 ? 'line' : 'lines'}  ${stripControl(item.shortHash)} ${stripControl(item.subject)}`,
		item.kind === 'thin' ? `    Why: ${stripControl(item.why)}` : '    No Why.',
	]);
	lines.push(
		'',
		'Add a better reason with: chamoji why --amend <hash> "<reason>"',
	);
	io.stdout(`${lines.join('\n')}\n`);
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
	const added = await readNoteCard(cwd, commit.hash);
	const card = mergeCards(added, commit.card);
	const extra = {
		...(added === undefined ? {} : {added}),
		...(card === undefined ? {} : {card}),
	};
	if (card === undefined) {
		return {
			quality: 'none',
			reasons: [],
			clues: await findClues(cwd, commit, file),
		};
	}

	const {level, reasons} = judgeWhy(card, commit.description);
	return level === 'ok'
		? {quality: 'ok', reasons, ...extra}
		: {
				quality: 'thin',
				reasons,
				clues: await findClues(cwd, commit, file),
				...extra,
			};
}

/**
 * `chamoji why --amend <sha|file:line> <reason...>`: keeps a better reason for
 * a commit in a git note, so history is not rewritten. A reason that is thin
 * against the commit's subject is refused.
 */
async function amendWhy(
	target: string,
	words: string[],
	io: Io,
): Promise<number> {
	const reason = words.join(' ').trim();
	if (target === '' || reason === '') {
		io.stderr(
			'chamoji: why --amend needs a commit and a reason: chamoji why --amend <sha|file:line> <reason...>\n',
		);
		return USAGE_ERROR;
	}

	await assertGitRepo(io.cwd);
	let hash: string;
	let location: {file: string; line: number} | undefined;
	try {
		if (target.includes(':')) location = parseLocation(target);
	} catch {
		location = undefined;
	}

	if (location) {
		const result = await blameLine(io.cwd, location.file, location.line);
		if (result.kind === 'uncommitted') {
			io.stderr(
				`chamoji: ${stripControl(target)} is not committed yet, so there is no commit to add a reason to.\n`,
			);
			return 1;
		}

		hash = result.commit.hash;
	} else {
		try {
			hash = (
				await runGit(['rev-parse', '--verify', `${target}^{commit}`], io.cwd)
			).trim();
		} catch {
			io.stderr(`chamoji: ${stripControl(target)} is not a commit.\n`);
			return 1;
		}
	}

	const [raw] = await readCommits(io.cwd, hash, {maxCount: 1});
	const commit = parseCommit(raw!);
	const card = noteCard(reason);
	const verdict = card && judgeWhy(card, commit.description);
	if (verdict && verdict.level !== 'ok') {
		const advice = WHY_ADVICE[verdict.reasons[0]!];
		io.stderr(`chamoji: that reason is thin too. ${advice}\n`);
		return 1;
	}

	await writeNoteCard(io.cwd, hash, reason);
	io.stdout(
		`Added a reason to ${stripControl(commit.shortHash)} ${stripControl(commit.subject)}. Share it with: git push origin ${NOTES_REF}\n`,
	);
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
	{quality, clues, added}: WhyReading,
	workstream?: Pick<Workstream, 'title' | 'emoji' | 'status'>,
) {
	const lines = [
		`${stripControl(shortHash)} ${stripControl(subject)}`,
		`${stripControl(authorName)}, ${stripControl(date).slice(0, 10)}`,
		'',
	];
	const recorded = [
		...cardLines(added).map(line => `${line} (added later)`),
		...cardLines(card),
	];
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
