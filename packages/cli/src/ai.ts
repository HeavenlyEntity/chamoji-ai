import {openJudgmentCache, runGit, type CommitClassifier} from '@chamoji/core';
import {TypeSafeClient} from '@typesafe-ai/sdk';
import {createCommitAdvisor, type AdvisorClient} from './advisor.js';
import {MISSING_KEY, readTypesafeKey} from './env.js';
import {
	createJevClassifier,
	JUDGMENT_VERSION,
	type JevClassifierOptions,
} from './jev-classifier.js';
import {jevReranker, type MemoryReranker, type RerankClient} from './rerank.js';
import type {Io} from './run.js';
import {createWhyChecker, type WhyChecker} from './why-check.js';

export type AiSettings = {
	composer: boolean;
	sendDiffs: boolean;
	whyCheck: boolean;
	whyFromSessions: boolean;
};

/**
 * The composer's AI opt-ins, from git config (`chamoji.composer`,
 * `chamoji.sendDiffs`), never from files in the repository: a cloned repo
 * must not be able to switch on sending your changes anywhere.
 */
export async function readAiSettings(cwd: string): Promise<AiSettings> {
	const flag = async (key: string) =>
		(
			await runGit(['config', '--type=bool', '--get', key], cwd).catch(() => '')
		).trim() === 'true';
	return {
		composer: await flag('chamoji.composer'),
		sendDiffs: await flag('chamoji.sendDiffs'),
		whyCheck: await flag('chamoji.whyCheck'),
		whyFromSessions: await flag('chamoji.whyFromSessions'),
	};
}

/**
 * The commit advisor on the TypeSafe API, or null without a key. The key
 * comes from the environment, or a .env file git doesn't track.
 */
export async function realAdvisor(
	cwd: string,
): Promise<ReturnType<typeof createCommitAdvisor> | null> {
	const client = await realAdvisorClient(cwd);
	return client ? createCommitAdvisor(client) : null;
}

/** The TypeSafe client for choice and noul questions, or undefined without a usable key. */
export async function realAdvisorClient(
	cwd: string,
): Promise<AdvisorClient | undefined> {
	const key = await readTypesafeKey(cwd, process.env, {untrackedOnly: true});
	if (!key || /[^\x21-\x7E]/.test(key)) return undefined;
	const client = new TypeSafeClient({apiKey: key});
	return {
		// Only choice and noul questions are asked, so box answers never come back.
		systemOne: async request =>
			(await client.systemOne(
				request as Parameters<typeof client.systemOne>[0],
			)) as unknown as Awaited<ReturnType<AdvisorClient['systemOne']>>,
	};
}

/**
 * Jev's check of a Why on the TypeSafe API, or undefined without a key. For
 * the composer (`untrackedOnly`) a tracked `.env` can't supply the key, as
 * with the advisor. `why --check --ai` uses the same lookup as other `--ai`
 * commands.
 */
export async function realWhyChecker(
	io: Io,
	root = io.cwd,
	untrackedOnly = false,
): Promise<WhyChecker | undefined> {
	if (io.whyChecker) return io.whyChecker;
	if (untrackedOnly) {
		const key = await readTypesafeKey(root, process.env, {untrackedOnly});
		if (!key || /[^\x21-\x7E]/.test(key)) return undefined;
	}

	const client = await typesafeClient({...io, cwd: root}, {untrackedOnly});
	if (!client) return undefined;
	// The check asks only a noul question, so box answers never come back.
	return createWhyChecker({
		systemOne: async request =>
			(await client.systemOne(
				request as Parameters<typeof client.systemOne>[0],
			)) as unknown as Awaited<ReturnType<AdvisorClient['systemOne']>>,
	});
}

/**
 * The TypeSafe client, or undefined without a key. A key that can't go in a
 * header throws. With `untrackedOnly`, a key from a file git tracks is not used.
 */
async function typesafeClient(
	io: Io,
	options: {untrackedOnly?: boolean} = {},
): Promise<TypeSafeClient | undefined> {
	const key = await readTypesafeKey(io.cwd, process.env, options);
	if (!key) return undefined;
	// Keys copied from a dashboard often end in "…"; headers can't carry it.
	const invalid = /[^\x21-\x7E]/.exec(key);
	if (invalid) {
		throw new Error(
			invalid[0] === '\u2026'
				? 'TYPESAFE_API_KEY contains "…", so it looks truncated; copy the full key again'
				: 'TYPESAFE_API_KEY contains a character that is not plain ASCII; copy the full key again',
		);
	}

	return new TypeSafeClient({apiKey: key});
}

/**
 * `memory search --ai`'s reorder on the TypeSafe API, or undefined without a
 * key. It sends what a repository's commits say, so a tracked `.env` can't
 * supply the key: a cloned repo could name someone else's account.
 */
export async function realReranker(
	io: Io,
): Promise<MemoryReranker | undefined> {
	if (io.rerank) return io.rerank;
	const client = await typesafeClient(io, {untrackedOnly: true});
	if (!client) return undefined;
	return jevReranker(
		{
			// The rerank asks only score questions.
			systemOne: async request =>
				(await client.systemOne(
					request as Parameters<typeof client.systemOne>[0],
				)) as unknown as Awaited<ReturnType<RerankClient['systemOne']>>,
		},
		{report: line => io.stderr(`${line}\n`)},
	);
}

export async function jevClassifier(
	io: Io,
	progress: JevClassifierOptions['progress'],
): Promise<CommitClassifier> {
	const client = io.jev ?? (await typesafeClient(io));
	if (!client) throw new Error(MISSING_KEY);
	// Outside a repository there's nowhere to keep judgments, so none are cached.
	const cache = await openJudgmentCache(io.cwd, JUDGMENT_VERSION).catch(
		() => undefined,
	);
	return createJevClassifier(
		{systemOne: async request => client.systemOne(request)},
		{report: line => io.stderr(`${line}\n`), cache, progress},
	);
}
