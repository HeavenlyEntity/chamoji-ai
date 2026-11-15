import {execFile} from 'node:child_process';
import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {
	cardLineId,
	readCardState,
	resolveLine,
	snapshotWorkstream,
	writeNoteCard,
	type CardLine,
} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {run} from '../src/run.js';
import {recordingFace} from './helpers/recording-face.js';

// The real card state, wrapped so a test can stand in for it or make it fail.
vi.mock('@chamoji/core', async importOriginal => {
	const original = await importOriginal<typeof import('@chamoji/core')>();
	return {...original, readCardState: vi.fn(original.readCardState)};
});

const execFileAsync = promisify(execFile);

let repo: FixtureRepo | undefined;
let loose: string | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.mocked(readCardState).mockClear();
	await repo?.cleanup();
	repo = undefined;
	if (loose) await rm(loose, {recursive: true, force: true});
	loose = undefined;
});

async function chamoji(argv: string[], cwd: string) {
	let stdout = '';
	let stderr = '';
	const code = await run(argv, {
		cwd,
		stdout: text => (stdout += text),
		stderr: text => (stderr += text),
	});
	return {code, stdout, stderr};
}

const FILES = {'src/a.ts': 'one\ntwo\nthree\n'};

test('prints the commit and its card', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: because\nConstraint: no network\nGotcha: order matters\nFollow-up: tidy later',
			files: FILES,
		},
	]);
	const {code, stdout, stderr} = await chamoji(['why', 'src/a.ts:2'], repo.dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toMatch(/^[0-9a-f]{7} ✨ Add a\nFixture Bot, 2026-01-01\n\n/);
	expect(stdout).toContain(
		[
			'Why: because',
			`Constraint [${cardLineId('constraint', 'no network')}]: no network`,
			`Gotcha [${cardLineId('gotcha', 'order matters')}]: order matters`,
			`Follow-up [${cardLineId('followUp', 'tidy later')}]: tidy later`,
			'',
		].join('\n'),
	);
	expect(stdout).not.toContain('This reason is thin');
});

/** A state line for a card line of `kind` and `text`, open unless `extra` says otherwise. */
function stateLine(
	kind: CardLine['kind'],
	text: string,
	extra: Partial<CardLine> = {},
): CardLine {
	return {
		id: cardLineId(kind, text),
		kind,
		text,
		state: 'open',
		sources: [],
		date: '2026-01-01T00:00:00Z',
		files: [],
		...extra,
	};
}

test('why prints each of the six bracket forms', async () => {
	const texts = [
		'no network',
		'old proxy',
		'port 3000',
		'slow disk',
		'beta',
		'old cache',
	];
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: [
				'Why: the old form leaked sessions after the tab closed',
				...texts.map(text => `Constraint: ${text}`),
				'Gotcha: unknown to the state',
				'Follow-up: tidy later',
			].join('\n'),
			files: FILES,
		},
	]);
	const resolver = `3e9d1aa${'0'.repeat(33)}`;
	const replacer = `4d03905${'0'.repeat(33)}`;
	const reverter = `5c6d7e8${'0'.repeat(33)}`;
	const [open, resolved, replaced, doubted, offBranch, withdrawn] = texts;
	vi.mocked(readCardState).mockResolvedValueOnce({
		head: resolver,
		dangling: [],
		lines: [
			stateLine('constraint', open!),
			stateLine('constraint', resolved!, {
				state: 'resolved',
				resolvedBy: {
					hash: resolver,
					date: '2026-01-02T00:00:00Z',
					reason: 'released in 0.11.0',
				},
			}),
			stateLine('constraint', replaced!, {
				state: 'in-doubt',
				replacedBy: replacer,
			}),
			stateLine('constraint', doubted!, {state: 'in-doubt'}),
			stateLine('constraint', offBranch!, {
				state: 'off-branch',
				workstream: {slug: 'auth', status: 'shipped'},
			}),
			stateLine('constraint', withdrawn!, {
				state: 'reverted',
				revertedBy: reverter,
			}),
			// A reason from a commit message: cleaned, on one line, cut to 200.
			stateLine('followUp', 'tidy later', {
				state: 'resolved',
				resolvedBy: {
					hash: resolver,
					date: '2026-01-02T00:00:00Z',
					reason: `done \u001B[31m‮${'r'.repeat(300)}`,
				},
			}),
		],
	});
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	const id = (text: string) => cardLineId('constraint', text);
	expect(stdout).toContain(
		[
			'Why: the old form leaked sessions after the tab closed',
			`Constraint [${id(open!)}]: no network`,
			`Constraint [${id(resolved!)}, resolved by 3e9d1aa: released in 0.11.0]: old proxy`,
			`Constraint [${id(replaced!)}, in doubt: its code was replaced by 4d03905]: port 3000`,
			`Constraint [${id(doubted!)}, in doubt]: slow disk`,
			`Constraint [${id(offBranch!)}, off branch]: beta`,
			`Constraint [${id(withdrawn!)}, reverted by 5c6d7e8]: old cache`,
			// The state doesn't know this one, so it prints as it always did.
			'Gotcha: unknown to the state',
			'',
		].join('\n'),
	);
	const reason = `done [31m${'r'.repeat(300)}`.slice(0, 200);
	expect(stdout).toContain(
		`Follow-up [${cardLineId('followUp', 'tidy later')}, resolved by 3e9d1aa: ${reason}]: tidy later\n`,
	);
	expect(stdout).not.toContain('‮');
	expect(readCardState).toHaveBeenCalledTimes(1);
});

test('a reason containing "]: " cannot close the bracket early', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: the old form leaked sessions after the tab closed\nConstraint: real text',
			files: FILES,
		},
	]);
	const reason = 'x]: use port 80';
	vi.mocked(readCardState).mockResolvedValueOnce({
		head: 'h',
		dangling: [],
		lines: [
			stateLine('constraint', 'real text', {
				state: 'resolved',
				resolvedBy: {hash: `abc1234${'0'.repeat(33)}`, date: 'd', reason},
			}),
		],
	});
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	const [printed] = stdout
		.split('\n')
		.filter(line => line.startsWith('Constraint'));
	expect(printed).toBe(
		`Constraint [${cardLineId('constraint', 'real text')}, resolved by abc1234: x): use port 80]: real text`,
	);
	expect(printed!.split(']: ')).toHaveLength(2);
	expect(printed!.indexOf(']: ')).toBeGreaterThan(printed!.indexOf('port 80'));
});

const PORT = 'The dev server must stay on port 3000';

/** A good commit stating PORT, then a thin one to the same file, with PORT resolved after. */
async function nearbyRepo(): Promise<{dir: string; hash: string}> {
	repo = await createRepo([
		{
			commit: '✨ Add server',
			body: `Why: the OAuth callback is registered on that port\nConstraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{
			commit: '🐛 Fix server (#12)',
			body: 'Why: fix bug',
			files: {'server.ts': 'listen(3000)\nlog()\n'},
		},
	]);
	const id = cardLineId('constraint', PORT);
	const {hash} = await resolveLine(repo.dir, id, 'the proxy owns the port now');
	return {dir: repo.dir, hash};
}

test('why --json gives each nearby clue card its lines, resolved for a constraint a later commit resolved', async () => {
	const {dir, hash} = await nearbyRepo();
	const result = JSON.parse(
		(await chamoji(['why', 'server.ts:2', '--json'], dir)).stdout,
	);
	expect(result.whyQuality).toBe('thin');
	expect(result).not.toHaveProperty('lines');
	const [near] = result.clues.nearby;
	expect(near.card.constraint).toEqual([PORT]);
	expect(near.lines).toEqual([
		{
			id: cardLineId('constraint', PORT),
			kind: 'constraint',
			text: PORT,
			state: 'resolved',
			resolvedBy: {
				hash,
				date: expect.any(String),
				reason: 'the proxy owns the port now',
			},
		},
	]);
	expect(readCardState).toHaveBeenCalledTimes(1);
});

test('why prints the bracket on a nearby clue card and on a card added later', async () => {
	const {dir, hash} = await nearbyRepo();
	const id = cardLineId('constraint', PORT);
	const nearby = await chamoji(['why', 'server.ts:2'], dir);
	expect(nearby.stdout).toContain(
		`  Constraint [${id}, resolved by ${hash.slice(0, 7)}: the proxy owns the port now]: ${PORT}\n`,
	);
	await repo!.cleanup();

	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const head = (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim();
	await writeNoteCard(
		repo.dir,
		head,
		'Why: the provider returns 422 for stays over 365 nights\nGotcha: the provider counts nights, not days',
	);
	const added = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	const gotcha = 'the provider counts nights, not days';
	expect(added.stdout).toContain(
		`Gotcha [${cardLineId('gotcha', gotcha)}]: ${gotcha} (added later)\n`,
	);
	// The added card's lines are part of the merged card, so --json has them in lines.
	const json = JSON.parse(
		(await chamoji(['why', 'src/a.ts:1', '--json'], repo.dir)).stdout,
	);
	expect(json.addedLater.gotcha).toEqual([gotcha]);
	expect(json.lines).toEqual([
		{
			id: cardLineId('gotcha', gotcha),
			kind: 'gotcha',
			text: gotcha,
			state: 'open',
		},
	]);
});

test('a commit with only a Why prints exactly as before', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: the old form leaked sessions after the tab closed',
			files: FILES,
		},
	]);
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	const short = (
		await gitOutput(repo.dir, ['rev-parse', '--short=7', 'HEAD'])
	).trim();
	expect(stdout).toBe(
		`${short} ✨ Add a\nFixture Bot, 2026-01-01\n\nWhy: the old form leaked sessions after the tab closed\n`,
	);
	// Nothing in the card has a state, so none is read.
	expect(readCardState).not.toHaveBeenCalled();
});

test('a card state that fails to read leaves why as it was and says so on stderr, and --json has linesUnavailable instead of lines', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: the old form leaked sessions after the tab closed\nConstraint: no network',
			files: FILES,
		},
	]);
	// Once for the text run, once for --json.
	vi.mocked(readCardState)
		.mockRejectedValueOnce(new Error('git failed'))
		.mockRejectedValueOnce(new Error('git failed'));
	const text = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(text.code).toBe(0);
	expect(text.stderr).toBe(
		'chamoji: line states could not be read, so cards are shown without them\n',
	);
	expect(text.stdout).toContain(
		'Why: the old form leaked sessions after the tab closed\nConstraint: no network\n',
	);
	const json = await chamoji(['why', 'src/a.ts:1', '--json'], repo.dir);
	expect(json.code).toBe(0);
	const result = JSON.parse(json.stdout);
	expect(result.card.constraint).toEqual(['no network']);
	expect(result).not.toHaveProperty('lines');
	expect(result.linesUnavailable).toBe(true);
	expect(json.stderr).toBe('');
});

test("after git revert of a line's only source, why --json and why carry it as reverted on the nearby clue", async () => {
	const id = cardLineId('constraint', PORT);
	repo = await createRepo([
		{commit: '🎉 Init', files: {'server.ts': 'listen(80)\nlog()\n'}},
		{
			commit: '✨ Pin the port',
			body: `Why: the OAuth callback is registered on that port\nConstraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\nlog()\n'},
		},
	]);
	// Dated the day after, so the pinning commit is near enough to be a clue.
	await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], {
		cwd: repo.dir,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: '2026-01-03T00:00:00Z',
			GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z',
		},
	});
	const revert = (await gitOutput(repo.dir, ['rev-parse', 'HEAD'])).trim();

	const json = JSON.parse(
		(await chamoji(['why', 'server.ts:1', '--json'], repo.dir)).stdout,
	);
	const [near] = json.clues.nearby;
	expect(near.card.constraint).toEqual([PORT]);
	expect(near.lines).toEqual([
		{
			id,
			kind: 'constraint',
			text: PORT,
			state: 'reverted',
			revertedBy: revert,
		},
	]);

	const {stdout} = await chamoji(['why', 'server.ts:1'], repo.dir);
	expect(stdout).toContain(
		`  Constraint [${id}, reverted by ${revert.slice(0, 7)}]: ${PORT}\n`,
	);
});

test('a commit with no card still prints its subject and says so', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('✨ Add a');
	expect(stdout).toContain('This commit records no intent.');
});

test('--json prints the BlameResult', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Why: because', files: FILES},
	]);
	const {code, stdout} = await chamoji(
		['why', 'src/a.ts:3', '--json'],
		repo.dir,
	);
	expect(code).toBe(0);
	const result = JSON.parse(stdout);
	expect(result.kind).toBe('commit');
	expect(result.commit.subject).toBe('✨ Add a');
	expect(result.commit.card.why).toEqual(['because']);
});

test('strips terminal escapes from commit text', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add \u001B[31mred\u001B[0m',
			body: 'Why: \u001B]0;owned\u0007because\u009B1m',
			files: FILES,
		},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Add [31mred[0m');
	expect(stdout).toContain('Why: ]0;ownedbecause1m');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('says when the line is not committed yet', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	await appendFile(path.join(repo.dir, 'src/a.ts'), 'four\n');
	const {code, stdout} = await chamoji(['why', 'src/a.ts:4'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toBe('src/a.ts:4 is not committed yet.\n');
});

test('reports a bad location plainly', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stderr} = await chamoji(['why', 'src/a.ts'], repo.dir);
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: ');
	expect(stderr).toContain('src/a.ts');
});

test('asks for exactly one location', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const none = await chamoji(['why'], repo.dir);
	expect(none.code).toBe(2);
	expect(none.stderr).toContain('why needs one location');
	const two = await chamoji(['why', 'a.ts:1', 'b.ts:2'], repo.dir);
	expect(two.code).toBe(2);
});

test('outside a repo reports it plainly', async () => {
	loose = await mkdtemp(path.join(tmpdir(), 'chamoji-why-'));
	const {code, stderr} = await chamoji(['why', 'a.ts:1'], loose);
	expect(code).toBe(1);
	expect(stderr).toContain('chamoji: Not a git repository');
});

const SHIPPED = {
	'.chamoji/workstreams.yml':
		'workstreams:\n  auth:\n    title: Auth revamp\n    emoji: 🔐\n    status: shipped\n',
};

test('why falls back to the workstream summary', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	// With the file gone, only the memory ref knows the title.
	await rm(path.join(repo.dir, '.chamoji'), {recursive: true});
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('This commit records no intent.\n');
	expect(stdout).toContain('Workstream: 🔐 Auth revamp (shipped)\n');
});

test('why takes the title from the workstreams file before any snapshot', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Workstream: 🔐 Auth revamp (shipped)\n');
});

test('a commit with a good card shows no workstream line', async () => {
	const why = 'the old form leaked sessions after the tab closed';
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{
			commit: '✨ Add a',
			body: `Why: ${why}\nWorkstream: auth`,
			files: FILES,
		},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain(`Why: ${why}\n`);
	expect(stdout).not.toContain('Auth revamp');
});

test('a thin card still shows the workstream line', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: SHIPPED},
		{commit: '✨ Add a', body: 'Why: because\nWorkstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Workstream: 🔐 Auth revamp (shipped)\n');
});

test('a workstream nothing knows about leaves the plain answer', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Workstream: gone', files: FILES},
	]);
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('This commit records no intent.\n');
	expect(stdout).not.toContain('Workstream:');
});

test('a corrupt workstreams file does not stop why', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	await mkdir(path.join(repo.dir, '.chamoji'));
	await writeFile(path.join(repo.dir, '.chamoji/workstreams.yml'), 'a: [\n');
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('This commit records no intent.\n');
});

test('the workstream summary strips terminal escapes', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml':
					'workstreams:\n  auth:\n    title: "Auth \\e[31mred"\n    status: active\n',
			},
		},
		{commit: '✨ Add a', body: 'Workstream: auth', files: FILES},
	]);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain('Workstream: Auth [31mred (active)\n');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('a separator byte in an author name puts no escape text on stdout', async () => {
	// Git keeps \u001F inside a name, which moves every field after it along.
	vi.stubEnv('GIT_AUTHOR_NAME', 'a\u001Fb\u001F\u001B[31mevil');
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	vi.unstubAllEnvs();
	const {code, stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(code).toBe(0);
	expect(stdout).toContain('[31mevil');
	// eslint-disable-next-line no-control-regex
	expect(stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test('why is one step, and prints what it printed before', async () => {
	repo = await createRepo([
		{commit: '✨ Add a', body: 'Why: because', files: FILES},
	]);
	const plain = await chamoji(['why', 'src/a.ts:2'], repo.dir);
	const {face, calls} = recordingFace();
	let stdout = '';
	const code = await run(['why', 'src/a.ts:2'], {
		cwd: repo.dir,
		stdout: text => (stdout += text),
		stderr() {},
		face,
	});
	expect(code).toBe(0);
	expect(stdout).toBe(plain.stdout);
	expect(calls).toEqual([
		['step', 'Finding the commit that wrote the line'],
		['end', 'ok', 'Found the commit'],
		['stop'],
	]);
});

const NOTICE =
	'This reason is thin. Look at the PR, issue and nearby commits too.';

async function thinRepo(why: string) {
	return createRepo([
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked sessions after the tab closed, so logins stayed open',
			files: FILES,
		},
		{
			commit: '🐛 Fix login (#12)',
			body: `Why: ${why}`,
			files: {'src/a.ts': 'one\ntwo\nthree\nfour\n'},
		},
	]);
}

test('a thin card prints the notice, the PR and nearby commits', async () => {
	repo = await thinRepo('fix bug');
	const {stdout} = await chamoji(['why', 'src/a.ts:4'], repo.dir);
	expect(stdout).toContain(`Why: fix bug\n${NOTICE}\n`);
	expect(stdout).toContain('PR: #12\n');
	expect(stdout).toMatch(
		/Nearby: [0-9a-f]{7} ✨ Add login\n {2}Why: the old form leaked sessions/,
	);
});

test('a good card prints no notice and no clues', async () => {
	repo = await thinRepo(
		'a retry storm took the login service down when the token expired',
	);
	const {stdout} = await chamoji(['why', 'src/a.ts:4'], repo.dir);
	expect(stdout).not.toContain(NOTICE);
	expect(stdout).not.toContain('Nearby:');
	expect(stdout).not.toContain('PR:');
});

test('--json adds whyQuality, whyReasons and clues', async () => {
	repo = await thinRepo('fix bug');
	const {stdout} = await chamoji(['why', 'src/a.ts:4', '--json'], repo.dir);
	const result = JSON.parse(stdout);
	expect(result.kind).toBe('commit');
	expect(result.whyQuality).toBe('thin');
	expect(result.whyReasons).toEqual(['filler', 'too-short']);
	expect(result.clues.pr).toBe(12);
	expect(result.clues.nearby).toHaveLength(1);
});

const REASON = 'the provider returns 422 for stays over 365 nights';

async function hashOf(dir: string, rev = 'HEAD') {
	return (await gitOutput(dir, ['rev-parse', rev])).trim();
}

test('--amend adds a reason that shows first, marked as added later', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const hash = await hashOf(repo.dir);
	const added = await chamoji(
		['why', '--amend', hash, ...REASON.split(' ')],
		repo.dir,
	);
	expect(added.stderr).toBe('');
	expect(added.code).toBe(0);
	expect(added.stdout).toMatch(
		/^Added a reason to [0-9a-f]{7} 🐛 Fix bug\. Share it with: git push origin refs\/notes\/chamoji\n$/,
	);
	const {stdout} = await chamoji(['why', 'src/a.ts:1'], repo.dir);
	expect(stdout).toContain(`Why: ${REASON} (added later)\nWhy: fix bug\n`);
	expect(stdout).not.toContain('This reason is thin');
});

test('--amend refuses a reason that is thin too and writes nothing', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const {code, stderr} = await chamoji(
		['why', '--amend', await hashOf(repo.dir), 'fix', 'it'],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stderr).toContain('that reason is thin too.');
	expect(await gitOutput(repo.dir, ['notes', '--ref=chamoji', 'list'])).toBe(
		'',
	);
});

test('--amend takes a file:line and refuses an empty reason', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	const done = await chamoji(
		['why', '--amend', 'src/a.ts:1', ...REASON.split(' ')],
		repo.dir,
	);
	expect(done.code).toBe(0);
	expect((await chamoji(['why', 'src/a.ts:2'], repo.dir)).stdout).toContain(
		`Why: ${REASON} (added later)`,
	);
	const empty = await chamoji(['why', '--amend', 'src/a.ts:1'], repo.dir);
	expect(empty.code).toBe(2);
});

test('--amend on an uncommitted line exits 1 and an unknown commit exits 1', async () => {
	repo = await createRepo([{commit: '🐛 Fix bug', files: FILES}]);
	await appendFile(path.join(repo.dir, 'src/a.ts'), 'four\n');
	const line = await chamoji(
		['why', '--amend', 'src/a.ts:4', REASON],
		repo.dir,
	);
	expect(line.code).toBe(1);
	expect(line.stderr).toBe(
		'chamoji: src/a.ts:4 is not committed yet, so there is no commit to add a reason to.\n',
	);
	const unknown = await chamoji(['why', '--amend', 'nope', REASON], repo.dir);
	expect(unknown.code).toBe(1);
});

test('--thin lists thin and missing Whys behind a path', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: 'Why: the provider returns 422 for stays over 365 nights',
			files: {'src/a.ts': 'a1\na2\n'},
		},
		{
			commit: '🐛 Fix b',
			body: 'Why: fix bug',
			files: {'src/b.ts': 'b1\nb2\nb3\nb4\nb5\n'},
		},
		{commit: '✨ Add c', files: {'src/c.ts': 'c1\n'}},
	]);
	const {code, stdout, stderr} = await chamoji(['why', '--thin'], repo.dir);
	expect(stderr).toBe('');
	expect(code).toBe(0);
	expect(stdout).toContain('5 lines');
	expect(stdout).toContain('Why: fix bug');
	expect(stdout).toContain('No Why.');
	expect(stdout).toContain(
		'Add a better reason with: chamoji why --amend <hash> "<reason>"',
	);

	const none = await chamoji(['why', '--thin', 'src/a.ts'], repo.dir);
	expect(none.code).toBe(0);
	expect(none.stdout).toContain('No thin Whys behind src/a.ts.');

	const json = await chamoji(['why', '--thin', '--json'], repo.dir);
	expect(JSON.parse(json.stdout)).toHaveLength(2);
});

test('--thin refuses a path outside the repository with exit 2', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stdout, stderr} = await chamoji(
		['why', '--thin', '../outside'],
		repo.dir,
	);
	expect(code).toBe(2);
	expect(stdout).toBe('');
	expect(stderr).toBe('chamoji: ../outside is outside the repository.\n');
});

test('--thin refuses an absolute path outside the repository with exit 2', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const outside = path.dirname(repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['why', '--thin', outside],
		repo.dir,
	);
	expect(code).toBe(2);
	expect(stdout).toBe('');
	expect(stderr).toBe(`chamoji: ${outside} is outside the repository.\n`);
});

test('--check says a thin reason is thin and exits 1', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stdout} = await chamoji(['why', '--check', 'fix bug'], repo.dir);
	expect(code).toBe(1);
	expect(stdout).toMatch(/^thin: Name the bug/);
});

test('--check says ok to a reason that names its cause and exits 0', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stdout} = await chamoji(
		['why', '--check', 'Safari drops the session cookie when the tab sleeps'],
		repo.dir,
	);
	expect(code).toBe(0);
	expect(stdout).toBe('ok\n');
});

test('--check with no reason exits 2', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const {code, stderr} = await chamoji(['why', '--check'], repo.dir);
	expect(code).toBe(2);
	expect(stderr).toContain('why --check needs a reason');
});

test('--check --ai with no key says so and exits 2', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	vi.stubEnv('TYPESAFE_API_KEY', '');
	const {code, stdout, stderr} = await chamoji(
		['why', '--check', '--ai', 'x'],
		repo.dir,
	);
	expect(code).toBe(2);
	expect(stdout).toBe('');
	expect(stderr).toContain('--ai needs a TypeSafe API key');
});

test('--check --ai asks Jev about a reason the local rules pass', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const reason = 'this makes the code better and easier to maintain';
	let stdout = '';
	const code = await run(['why', '--check', '--ai', reason], {
		cwd: repo.dir,
		stdout: text => (stdout += text),
		stderr: () => undefined,
		whyChecker: async () => true,
	});
	expect(code).toBe(1);
	expect(stdout).toMatch(/^thin: This doesn't say what would go wrong/);
});

test('--check --ai keeps ok when Jev finds the reason fine or fails', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const reason = 'Safari drops the session cookie when the tab sleeps';
	for (const whyChecker of [
		async () => false,
		async () => {
			throw new Error('offline');
		},
	]) {
		let stdout = '';
		const code = await run(['why', '--check', '--ai', reason], {
			cwd: repo.dir,
			stdout: text => (stdout += text),
			stderr: () => undefined,
			whyChecker,
		});
		expect(code).toBe(0);
		expect(stdout).toBe('ok\n');
	}
});

test('--check --ai gives the local verdict when Jev never answers', async () => {
	repo = await createRepo([{commit: '✨ Add a', files: FILES}]);
	const reason = 'Safari drops the session cookie when the tab sleeps';
	let stdout = '';
	const started = Date.now();
	const code = await run(['why', '--check', '--ai', reason], {
		cwd: repo.dir,
		stdout: text => (stdout += text),
		stderr: () => undefined,
		whyChecker: async () => new Promise<boolean>(() => undefined),
	});
	expect(code).toBe(0);
	expect(stdout).toBe('ok\n');
	expect(Date.now() - started).toBeLessThan(4000);
});

test('--amend refuses a merge commit and writes nothing', async () => {
	repo = await createRepo([
		{commit: '🎉 Init', files: FILES},
		{mergeBranch: 'side', commits: ['✨ Add side']},
	]);
	const merge = await hashOf(repo.dir);
	const {code, stdout, stderr} = await chamoji(
		['why', '--amend', 'HEAD', ...REASON.split(' ')],
		repo.dir,
	);
	expect(code).toBe(1);
	expect(stdout).toBe('');
	expect(stderr).toBe(
		'chamoji: HEAD is a merge commit; add the reason to the commit that made the change.\n',
	);
	expect(
		await gitOutput(repo.dir, ['rev-list', '--parents', '-n1', merge]),
	).toMatch(/^\S+ \S+ \S+\n?$/);
	expect(await gitOutput(repo.dir, ['notes', '--ref=chamoji', 'list'])).toBe(
		'',
	);
});

test('--json puts the merged card at the top, beside addedLater and the commit', async () => {
	repo = await createRepo([
		{commit: '🐛 Fix bug', body: 'Why: fix bug', files: FILES},
	]);
	await chamoji(
		['why', '--amend', await hashOf(repo.dir), ...REASON.split(' ')],
		repo.dir,
	);
	const result = JSON.parse(
		(await chamoji(['why', 'src/a.ts:1', '--json'], repo.dir)).stdout,
	);
	expect(result.card.why).toEqual([REASON, 'fix bug']);
	expect(result.addedLater.why).toEqual([REASON]);
	expect(result.commit.card.why).toEqual(['fix bug']);
	expect(result.whyQuality).toBe('ok');
});
