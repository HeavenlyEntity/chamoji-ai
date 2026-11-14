import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {writePendingWhy} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';

vi.mock('../src/session-why.js', async importOriginal => {
	const actual = await importOriginal<typeof import('../src/session-why.js')>();
	return {...actual, draftFromSession: vi.fn(actual.draftFromSession)};
});

const {run} = await import('../src/run.js');
const {draftFromSession} = await import('../src/session-why.js');

const REASON =
	'The provider returns 422 for stays over 365 nights so guests lose the booking after paying.';
const repos: FixtureRepo[] = [];
const homes: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.mocked(draftFromSession).mockClear();
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
	await Promise.all(
		homes.splice(0).map(async home => rm(home, {recursive: true})),
	);
});

/**
 * Runs `chamoji commit` and returns what the composer was handed as a draft,
 * as it was handed: a draft still being read stays a promise.
 */
async function composeWith(flag: boolean, pending = false, composer = false) {
	const repo = await createRepo([{commit: '🎉 Init'}]);
	repos.push(repo);
	if (flag) {
		await gitOutput(repo.dir, ['config', 'chamoji.whyFromSessions', 'true']);
	}

	if (composer) {
		await gitOutput(repo.dir, ['config', 'chamoji.composer', 'true']);
	}

	const root = (
		await gitOutput(repo.dir, ['rev-parse', '--show-toplevel'])
	).trim();
	const home = await mkdtemp(path.join(tmpdir(), 'chamoji-home-'));
	homes.push(home);
	const folder = path.join(
		home,
		'.claude',
		'projects',
		root.replaceAll(/[^A-Za-z0-9]/g, '-'),
	);
	await mkdir(folder, {recursive: true});
	await writeFile(
		path.join(folder, 's.jsonl'),
		`${JSON.stringify({type: 'user', message: {role: 'user', content: REASON}})}\n`,
	);
	await writeFile(path.join(repo.dir, 'stays.ts'), 'export {};\n');
	await gitOutput(repo.dir, ['add', '-A']);
	if (pending) {
		await writePendingWhy(repo.dir, {
			why: 'the cache is stale after a deploy so users see old prices',
			source: 'your Cursor chat',
		});
	}

	let given: unknown;
	const code = await run(['commit'], {
		cwd: repo.dir,
		stdout() {},
		stderr() {},
		home,
		env: {},
		terminal: () => ({
			async compose(
				_config: unknown,
				_advice: unknown,
				_impact: unknown,
				_check: unknown,
				draft: unknown,
			) {
				given = draft;
				return '✨ Add stays';
			},
			close() {},
		}),
	} as never);
	return {code, given};
}

test('with chamoji.whyFromSessions unset, no session file is read', async () => {
	const {code, given} = await composeWith(false);
	expect(code).toBe(0);
	expect(given).toBeUndefined();
	expect(draftFromSession).not.toHaveBeenCalled();
});

test('with chamoji.whyFromSessions on, the composer gets a draft from the session', async () => {
	const {code, given} = await composeWith(true);
	expect(code).toBe(0);
	expect(given).toBeInstanceOf(Promise);
	expect(await given).toEqual({
		text: REASON,
		source: 'your Claude Code session',
	});
});

test('a session read that never ends does not hold the composer back', async () => {
	vi.mocked(draftFromSession).mockImplementationOnce(
		async () => new Promise(() => undefined),
	);
	const {code, given} = await composeWith(true);
	expect(code).toBe(0);
	expect(given).toBeInstanceOf(Promise);
});

test('a reason an agent handed over wins, and the session is not read', async () => {
	const {given} = await composeWith(true, true);
	expect(given).toMatchObject({source: 'your Cursor chat'});
	expect(draftFromSession).not.toHaveBeenCalled();
});

/** The client the composer path handed to the reader; the real one is never called. */
async function clientSeen(composer: boolean, key: string) {
	vi.stubEnv('TYPESAFE_API_KEY', key);
	vi.mocked(draftFromSession).mockImplementationOnce(async () => undefined);
	const {given} = await composeWith(true, false, composer);
	await given;
	const [input] = vi.mocked(draftFromSession).mock.calls[0] ?? [];
	return input?.client;
}

test('Jev gets the candidates only with chamoji.composer on and a key', async () => {
	expect(await clientSeen(true, 'test-key-123')).toBeDefined();
	vi.mocked(draftFromSession).mockClear();
	expect(await clientSeen(false, 'test-key-123')).toBeUndefined();
	vi.mocked(draftFromSession).mockClear();
	expect(await clientSeen(true, '')).toBeUndefined();
});
