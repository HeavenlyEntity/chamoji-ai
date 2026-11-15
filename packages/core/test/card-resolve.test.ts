import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {cardLineId} from '../src/card-lines.js';
import {
	ResolveError,
	isResolveCommit,
	resolveLine,
} from '../src/card-resolve.js';
import {readCardState} from '../src/card-state-repo.js';
import {snapshotWorkstream} from '../src/memory.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const PORT = 'The dev server must stay on port 3000';
const PORT_ID = cardLineId('constraint', PORT);

const rev = async (dir: string, ref: string) =>
	(await gitOutput(dir, ['rev-parse', ref])).trim();

const lineOf = async (dir: string, id: string) =>
	(await readCardState(dir)).lines.find(line => line.id === id);

async function serverRepo(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '✨ Add server',
			body: `Why: the app needs a dev server\nConstraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
	]);
}

/** The error `resolveLine` throws, or undefined when it doesn't. */
async function refusal(
	dir: string,
	id: string,
	reason: string,
): Promise<unknown> {
	return resolveLine(dir, id, reason).then(
		() => undefined,
		(error: unknown) => error,
	);
}

test('resolveLine makes an empty commit with the exact message, and the line reads as resolved', async () => {
	repo = await serverRepo();
	const before = await rev(repo.dir, 'HEAD');
	const {hash, line} = await resolveLine(
		repo.dir,
		PORT_ID.toUpperCase(),
		'  the proxy owns the port now  ',
	);

	expect(hash).toBe(await rev(repo.dir, 'HEAD'));
	expect(await rev(repo.dir, 'HEAD~1')).toBe(before);
	expect(line).toMatchObject({id: PORT_ID, text: PORT, state: 'open'});
	expect(await gitOutput(repo.dir, ['log', '-1', '--format=%B'])).toBe(
		`📝 Resolve ${PORT_ID}\n\nResolves: ${PORT_ID} the proxy owns the port now\n\n`,
	);
	// Empty: the commit's tree is its parent's.
	expect(await rev(repo.dir, 'HEAD^{tree}')).toBe(
		await rev(repo.dir, 'HEAD~1^{tree}'),
	);
	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({
		state: 'resolved',
		resolvedBy: {hash, reason: 'the proxy owns the port now'},
	});
});

test('an in-doubt line and an off-branch line can be resolved', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml':
					'workstreams:\n  auth:\n    title: Auth revamp\n    status: shipped\n',
			},
		},
		{
			commit: '✨ Add server',
			body: `Constraint: ${PORT}`,
			files: {'server.ts': 'listen(3000)\n'},
		},
		{commit: '📝 Tidy readme', files: {'README.md': 'hi\n'}},
		{commit: '♻️ Rewrite server', files: {'server.ts': 'serve()\n'}},
	]);
	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({state: 'in-doubt'});
	const doubted = await resolveLine(repo.dir, PORT_ID, 'the port is gone');
	expect(doubted.line.state).toBe('in-doubt');
	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({state: 'resolved'});

	const FLAKY = 'The login test is flaky on CI';
	const flakyId = cardLineId('gotcha', FLAKY);
	await gitOutput(repo.dir, ['switch', '-q', '-c', 'auth']);
	await writeFile(path.join(repo.dir, 'login.ts'), 'login\n');
	await gitOutput(repo.dir, ['add', 'login.ts']);
	await gitOutput(repo.dir, [
		'commit',
		'-q',
		'-m',
		`✨ Add login\n\nGotcha: ${FLAKY}\nWorkstream: auth`,
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	await gitOutput(repo.dir, ['switch', '-q', 'main']);
	await gitOutput(repo.dir, ['branch', '-q', '-D', 'auth']);
	expect(await lineOf(repo.dir, flakyId)).toMatchObject({state: 'off-branch'});

	const offBranch = await resolveLine(repo.dir, flakyId, 'the test was fixed');
	expect(offBranch.line.state).toBe('off-branch');
	expect(await lineOf(repo.dir, flakyId)).toMatchObject({state: 'resolved'});
});

test('an unknown id, a resolved id and a bad reason each throw their message', async () => {
	repo = await serverRepo();
	const head = await rev(repo.dir, 'HEAD');

	const unknown = await refusal(repo.dir, 'c-00000000', 'gone');
	expect(unknown).toBeInstanceOf(ResolveError);
	expect((unknown as Error).message).toBe('No card line has the id c-00000000');
	const misshapen = await refusal(repo.dir, 'port', 'gone');
	expect((misshapen as Error).message).toBe('No card line has the id port');

	for (const reason of ['', '   ', 'x'.repeat(201)]) {
		const error = await refusal(repo.dir, PORT_ID, reason);
		expect(error).toBeInstanceOf(ResolveError);
		expect((error as Error).message).toBe(
			'The reason must be one line of 1 to 200 characters',
		);
	}

	// The reason is checked before the id, and nothing reached git.
	expect(((await refusal(repo.dir, 'port', '')) as Error).message).toBe(
		'The reason must be one line of 1 to 200 characters',
	);
	expect(await rev(repo.dir, 'HEAD')).toBe(head);

	await resolveLine(repo.dir, PORT_ID, 'x'.repeat(200));
	const short = (await rev(repo.dir, 'HEAD')).slice(0, 7);
	const again = await refusal(repo.dir, PORT_ID, 'twice');
	expect(again).toBeInstanceOf(ResolveError);
	expect((again as Error).message).toBe(
		`${PORT_ID} is already resolved by ${short}`,
	);
});

test('staged changes stop it: no commit is made and the changes stay staged', async () => {
	repo = await serverRepo();
	const {dir} = repo;
	const before = await rev(dir, 'HEAD');
	await writeFile(path.join(dir, 'a.txt'), 'a\n');
	await gitOutput(dir, ['add', 'a.txt']);

	const error = await refusal(dir, PORT_ID, 'the proxy owns the port now');
	expect(error).toBeInstanceOf(ResolveError);
	expect((error as Error).message).toBe(
		'You have staged changes. Commit or unstage them first, so the resolve commit stays empty.',
	);
	expect(await gitOutput(dir, ['rev-parse', 'HEAD'])).toBe(`${before}\n`);
	expect(await gitOutput(dir, ['diff', '--cached', '--name-only'])).toBe(
		'a.txt\n',
	);
});

test('a hook that refuses the commit throws git’s message and leaves the repo as it was', async () => {
	repo = await serverRepo();
	const {dir} = repo;
	const before = await rev(dir, 'HEAD');
	const hooks = path.join(dir, '.git', 'hooks');
	await mkdir(hooks, {recursive: true});
	await writeFile(
		path.join(hooks, 'commit-msg'),
		'#!/bin/sh\necho "no resolves on Fridays" >&2\nexit 1\n',
		{mode: 0o755},
	);

	const error = await refusal(dir, PORT_ID, 'the proxy owns the port now');
	expect(error).toBeInstanceOf(ResolveError);
	expect((error as Error).message).toContain('no resolves on Fridays');
	expect(await rev(dir, 'HEAD')).toBe(before);
	expect(await lineOf(dir, PORT_ID)).toMatchObject({state: 'open'});
});

test('control characters and newlines in the reason are refused', async () => {
	repo = await serverRepo();
	const head = await rev(repo.dir, 'HEAD');
	for (const reason of [
		'the proxy\nowns it',
		'the proxy\rowns it',
		'the proxy\towns it',
		'the proxy \u001B[31mowns it',
		'the proxy\u0085owns it',
		'gone\u0000',
	]) {
		const error = await refusal(repo.dir, PORT_ID, reason);
		expect(error).toBeInstanceOf(ResolveError);
		expect((error as Error).message).toBe(
			'The reason must be one line of 1 to 200 characters',
		);
	}

	expect(await rev(repo.dir, 'HEAD')).toBe(head);
});

test('isResolveCommit is true only for the subject and trailer together', () => {
	const id = 'c-7f3a91be';
	const trailer = [{key: 'Resolves', value: `${id} the proxy owns it`}];
	expect(
		isResolveCommit({subject: `📝 Resolve ${id}`, trailers: trailer, body: ''}),
	).toBe(true);
	// The trailer may sit in the body, where a squash leaves it.
	expect(
		isResolveCommit({
			subject: `📝 Resolve ${id}`,
			trailers: [],
			body: `Resolves: ${id.toUpperCase()} gone`,
		}),
	).toBe(true);
	// The subject alone, or the trailer alone, is not one.
	expect(
		isResolveCommit({subject: `📝 Resolve ${id}`, trailers: [], body: ''}),
	).toBe(false);
	expect(
		isResolveCommit({subject: '♻️ Move the port', trailers: trailer, body: ''}),
	).toBe(false);
	// The subject and the trailer must name the same line.
	expect(
		isResolveCommit({
			subject: '📝 Resolve c-00000000',
			trailers: trailer,
			body: '',
		}),
	).toBe(false);
	// Nothing more on the subject line.
	expect(
		isResolveCommit({
			subject: `📝 Resolve ${id} and add a feature`,
			trailers: trailer,
			body: '',
		}),
	).toBe(false);
	expect(
		isResolveCommit({
			subject: `📝 Resolve #123`,
			trailers: [{key: 'Resolves', value: '#123'}],
			body: '',
		}),
	).toBe(false);
});

test('a resolve commit that also carries a Workstream: trailer is still a resolve commit', async () => {
	repo = await serverRepo();
	const body = `Resolves: ${PORT_ID} the proxy owns the port now\nWorkstream: auth`;
	expect(
		isResolveCommit({
			subject: `📝 Resolve ${PORT_ID}`,
			trailers: [
				{key: 'Resolves', value: `${PORT_ID} the proxy owns the port now`},
				{key: 'Workstream', value: 'auth'},
			],
			body,
		}),
	).toBe(true);

	await gitOutput(repo.dir, [
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		`📝 Resolve ${PORT_ID}`,
		'-m',
		body,
	]);
	const hash = await rev(repo.dir, 'HEAD');
	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({
		state: 'resolved',
		resolvedBy: {hash, reason: 'the proxy owns the port now'},
	});
});

test('a reverted line is refused: it was withdrawn with its commit', async () => {
	repo = await serverRepo();
	await gitOutput(repo.dir, ['revert', '--no-edit', 'HEAD']);
	const head = await rev(repo.dir, 'HEAD');
	expect(await lineOf(repo.dir, PORT_ID)).toMatchObject({state: 'reverted'});

	const error = await refusal(repo.dir, PORT_ID, 'the port is gone');
	expect(error).toBeInstanceOf(ResolveError);
	expect((error as Error).message).toBe(
		`${PORT_ID} was withdrawn when ${head.slice(0, 7)} reverted its commit`,
	);
	expect(await rev(repo.dir, 'HEAD')).toBe(head);
});

test('a hook that stages files makes resolve report a commit that is not empty, and leaves it in place', async () => {
	repo = await serverRepo();
	const {dir} = repo;
	const before = await rev(dir, 'HEAD');
	await writeFile(path.join(dir, 'stray.txt'), 'stray\n');
	const hooks = path.join(dir, '.git', 'hooks');
	await mkdir(hooks, {recursive: true});
	await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\ngit add -A\n', {
		mode: 0o755,
	});

	const error = await refusal(dir, PORT_ID, 'the proxy owns the port now');
	const made = await rev(dir, 'HEAD');
	expect(made).not.toBe(before);
	expect(error).toBeInstanceOf(ResolveError);
	expect((error as Error).message).toBe(
		`The resolve commit ${made.slice(0, 7)} is not empty: a hook changed files in it. Check it, and amend it if those changes were not meant to be there.`,
	);
	// Nothing was undone: the commit, and the file the hook added, stay.
	expect(await rev(dir, 'HEAD~1')).toBe(before);
	expect(await gitOutput(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe(
		'stray.txt\n',
	);
});

test('resolve refuses during a merge in progress and makes no commit', async () => {
	repo = await serverRepo();
	const {dir} = repo;
	await gitOutput(dir, ['switch', '-q', '-c', 'side']);
	await gitOutput(dir, ['commit', '-q', '--allow-empty', '-m', 'side']);
	await gitOutput(dir, ['switch', '-q', 'main']);
	const before = await rev(dir, 'HEAD');
	await gitOutput(dir, ['merge', '-q', '--no-ff', '--no-commit', 'side']);
	// Nothing is staged, so only the merge itself stops it.
	expect(await gitOutput(dir, ['diff', '--cached', '--name-only'])).toBe('');

	const error = await refusal(dir, PORT_ID, 'the proxy owns the port now');
	expect(error).toBeInstanceOf(ResolveError);
	expect((error as Error).message).toBe(
		'A merge, cherry-pick, revert or rebase is in progress. Finish it first, then resolve the line.',
	);
	expect(await rev(dir, 'HEAD')).toBe(before);
	expect(await rev(dir, 'MERGE_HEAD')).toBe(await rev(dir, 'side'));
});

test('resolve refuses during a cherry-pick in progress and makes no commit', async () => {
	repo = await serverRepo();
	const {dir} = repo;
	await gitOutput(dir, ['switch', '-q', '-c', 'side']);
	await writeFile(path.join(dir, 'server.ts'), 'listen(4000)\n');
	await gitOutput(dir, ['commit', '-q', '-a', '-m', 'side']);
	await gitOutput(dir, ['switch', '-q', 'main']);
	await writeFile(path.join(dir, 'server.ts'), 'listen(5000)\n');
	await gitOutput(dir, ['commit', '-q', '-a', '-m', 'main']);
	const before = await rev(dir, 'HEAD');
	// The pick conflicts, so git stops with it in progress.
	await expect(gitOutput(dir, ['cherry-pick', 'side'])).rejects.toThrow();

	const error = await refusal(dir, PORT_ID, 'the proxy owns the port now');
	expect(error).toBeInstanceOf(ResolveError);
	expect((error as Error).message).toBe(
		'A merge, cherry-pick, revert or rebase is in progress. Finish it first, then resolve the line.',
	);
	expect(await rev(dir, 'HEAD')).toBe(before);
});

test('resolve refuses during a rebase in progress', async () => {
	repo = await serverRepo();
	const {dir} = repo;
	await gitOutput(dir, ['switch', '-q', '-c', 'side']);
	await writeFile(path.join(dir, 'server.ts'), 'listen(4000)\n');
	await gitOutput(dir, ['commit', '-q', '-a', '-m', 'side']);
	await gitOutput(dir, ['switch', '-q', 'main']);
	await writeFile(path.join(dir, 'server.ts'), 'listen(5000)\n');
	await gitOutput(dir, ['commit', '-q', '-a', '-m', 'main']);
	await gitOutput(dir, ['switch', '-q', 'side']);
	await expect(gitOutput(dir, ['rebase', 'main'])).rejects.toThrow();

	const error = await refusal(dir, PORT_ID, 'the proxy owns the port now');
	expect((error as Error).message).toBe(
		'A merge, cherry-pick, revert or rebase is in progress. Finish it first, then resolve the line.',
	);
});
