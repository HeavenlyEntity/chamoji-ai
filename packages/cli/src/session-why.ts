import {open, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {CAUSAL_MARKERS, judgeWhy, whyWords, type WhyDraft} from '@chamoji/core';
import {ADVICE_TIMEOUT_MS, withTimeout, type AdvisorClient} from './advisor.js';
import {redact} from './jev-classifier.js';
import {cleanReason, MAX_WHY} from './why-draft.js';

export type SessionSource = 'claude-code' | 'codex';
export type SessionMessages = {source: SessionSource; messages: string[]};

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
/** The whole read is abandoned after this long. */
const READ_BUDGET_MS = 300;
const KEEP_MESSAGES = 20;
/** Only the end of a session is read: the newest messages are the useful ones. */
const TAIL_BYTES = 256 * 1024;
/** The Codex meta line must end within this many bytes. */
const FIRST_LINE_BYTES = 64 * 1024;
const MAX_MESSAGE = 2000;
const MAX_CANDIDATES = 12;
/** A run this long looks like a key or token, not a word. */
const TOKEN_LIKE = /[A-Za-z0-9_-]{24,}/;
/** A run of key characters this long, with a letter and a digit, looks like a secret. */
const KEY_RUN = /[A-Za-z0-9+/=_-]{20,}/g;
/** `scheme://user:pass@host`, or `scheme://token@host` with a long token. */
const URL_CREDENTIALS =
	/[a-z][a-z\d+.-]*:\/\/(?:[^\s/@:]+:[^\s/@]+|[^\s/@:]{8,})@/i;
/** A secret's name, a `:`, `=` or `is` a few characters on, then a value. */
const KEYWORD_VALUE =
	/\b(?:password|passwd|pwd|secret|token|api[ _-]?key|access key|private key|client secret|auth)s?\b[^\n]{0,6}?(?:[:=]|\bis\b)\s*\S{6,}/i;
/** Prefixes of well-known keys, which give them away even when short. */
const KEY_PREFIX =
	/(?<![A-Za-z\d])(?:sk[-_]|rk_|pk_live|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|A[SK]IA[A-Z\d]{12}|AIza)|-----BEGIN|eyJ[A-Za-z\d_-]{10}/;
/** A run of hex this long is a hash or a key. */
const HEX_RUN = /[\da-f]{16}/i;
/** Shorter file names match too many words to mean anything. */
const MIN_NAME = 3;
const SENTENCES = /(?<=[.!?])\s+|\n+/;

type Session = {source: SessionSource; messages: string[]; mtime: number};

/**
 * The user's own recent messages from their Claude Code or Codex session for
 * this repo, or undefined. It reads only user lines and only files under
 * `home` that belong to this repo and are recent. It never throws.
 */
export async function recentUserMessages(
	root: string,
	options: {home: string; now: Date; maxAgeMs?: number},
): Promise<SessionMessages | undefined> {
	const {home, now, maxAgeMs = TWO_HOURS_MS} = options;
	let timer: NodeJS.Timeout | undefined;
	const budget = new Promise<undefined>(resolve => {
		timer = setTimeout(() => {
			resolve(undefined);
		}, READ_BUDGET_MS);
	});
	try {
		const read = (async () => {
			const [claude, codex] = await Promise.all([
				readClaude(root, home, now, maxAgeMs).catch(() => undefined),
				readCodex(root, home, now, maxAgeMs).catch(() => undefined),
			]);
			const best =
				claude && codex
					? codex.mtime > claude.mtime
						? codex
						: claude
					: (claude ?? codex);
			return best && best.messages.length > 0
				? {source: best.source, messages: best.messages}
				: undefined;
		})().catch(() => undefined);
		return await Promise.race([read, budget]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** The files in `dir` ending in .jsonl and modified within the age, newest first. */
async function recentFiles(
	dir: string,
	now: Date,
	maxAgeMs: number,
): Promise<Array<{file: string; mtime: number}>> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const found: Array<{file: string; mtime: number}> = [];
	for (const name of names) {
		if (!name.endsWith('.jsonl')) continue;
		const file = path.join(dir, name);
		const info = await stat(file).catch(() => undefined);
		if (!info?.isFile()) continue;
		if (now.getTime() - info.mtimeMs > maxAgeMs) continue;
		found.push({file, mtime: info.mtimeMs});
	}

	return found.sort((a, b) => b.mtime - a.mtime);
}

/** The last 256 KiB of a file as lines, without a first line that may be cut. */
async function readTail(file: string): Promise<string> {
	const handle = await open(file, 'r');
	try {
		const {size} = await handle.stat();
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.subarray(0, bytesRead).toString('utf8');
		if (start === 0) return text;
		const newline = text.indexOf('\n');
		return newline === -1 ? '' : text.slice(newline + 1);
	} finally {
		await handle.close();
	}
}

/** The first line of a file, or undefined when it doesn't end within 64 KiB. */
async function readFirstLine(file: string): Promise<string | undefined> {
	const handle = await open(file, 'r');
	try {
		const buffer = Buffer.alloc(FIRST_LINE_BYTES);
		const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytesRead).toString('utf8');
		const newline = text.indexOf('\n');
		if (newline !== -1) return text.slice(0, newline);
		return bytesRead < FIRST_LINE_BYTES ? text : undefined;
	} finally {
		await handle.close();
	}
}

function parseLines(text: string): unknown[] {
	const lines: unknown[] = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			// Not ours to read: skip it.
		}
	}

	return lines;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/** Keeps a text a person typed; the tools wrap their own notes in `<...>`. */
function keep(text: unknown, into: string[]): void {
	if (typeof text !== 'string') return;
	const trimmed = text.trim();
	// Codex puts the repo's AGENTS.md in a user message; that is not the user's.
	if (
		trimmed === '' ||
		trimmed.startsWith('<') ||
		trimmed.startsWith('# AGENTS.md')
	) {
		return;
	}

	into.push(trimmed.slice(0, MAX_MESSAGE));
}

async function readClaude(
	root: string,
	home: string,
	now: Date,
	maxAgeMs: number,
): Promise<Session | undefined> {
	const dir = path.join(
		home,
		'.claude',
		'projects',
		root.replaceAll(/[^A-Za-z0-9]/g, '-'),
	);
	const newest = (await recentFiles(dir, now, maxAgeMs))[0];
	if (!newest) return undefined;
	const messages: string[] = [];
	for (const line of parseLines(await readTail(newest.file))) {
		// Summaries and subagent turns are written by the model, not the user.
		// The folder name is lossy, so each line must say it ran in this repo.
		const cwd = isObject(line) ? line['cwd'] : undefined;
		if (
			!isObject(line) ||
			typeof cwd !== 'string' ||
			!within(root, cwd) ||
			line['type'] !== 'user' ||
			line['isMeta'] === true ||
			line['isCompactSummary'] === true ||
			line['isSidechain'] === true
		) {
			continue;
		}

		const message = line['message'];
		if (!isObject(message)) continue;
		const {content} = message;
		if (typeof content === 'string') {
			keep(content, messages);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (isObject(part) && part['type'] === 'text')
					keep(part['text'], messages);
			}
		}
	}

	return {
		source: 'claude-code',
		messages: messages.slice(-KEEP_MESSAGES),
		mtime: newest.mtime,
	};
}

const pad = (value: number) => String(value).padStart(2, '0');

async function readCodex(
	root: string,
	home: string,
	now: Date,
	maxAgeMs: number,
): Promise<Session | undefined> {
	const days = [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)];
	const files: Array<{file: string; mtime: number}> = [];
	for (const day of days) {
		const dir = path.join(
			home,
			'.codex',
			'sessions',
			String(day.getFullYear()),
			pad(day.getMonth() + 1),
			pad(day.getDate()),
		);
		files.push(...(await recentFiles(dir, now, maxAgeMs)));
	}

	files.sort((a, b) => b.mtime - a.mtime);
	for (const {file, mtime} of files) {
		const first = await readFirstLine(file);
		if (first === undefined) continue;
		const meta = parseLines(first)[0];
		const payload = isObject(meta) ? meta['payload'] : undefined;
		const cwd = isObject(payload) ? payload['cwd'] : undefined;
		if (
			!isObject(meta) ||
			meta['type'] !== 'session_meta' ||
			typeof cwd !== 'string' ||
			!within(root, cwd)
		) {
			continue;
		}

		const messages: string[] = [];
		for (const line of parseLines(await readTail(file))) {
			if (!isObject(line) || line['type'] !== 'response_item') continue;
			const item = line['payload'];
			if (
				!isObject(item) ||
				item['type'] !== 'message' ||
				item['role'] !== 'user' ||
				!Array.isArray(item['content'])
			) {
				continue;
			}

			for (const part of item['content']) {
				if (isObject(part) && part['type'] === 'input_text')
					keep(part['text'], messages);
			}
		}

		return {source: 'codex', messages: messages.slice(-KEEP_MESSAGES), mtime};
	}

	return undefined;
}

/** True when `cwd` is `root` or a folder inside it. */
export function within(root: string, cwd: string): boolean {
	const relative = path.relative(root, cwd);
	return (
		relative !== '..' &&
		!relative.startsWith('..' + path.sep) &&
		!path.isAbsolute(relative)
	);
}

/**
 * A staged file's name as a whole word, with or without its extension, or
 * undefined when the name is too short to mean anything.
 */
function namePattern(name: string): RegExp | undefined {
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';
	if (stem.length < MIN_NAME) return undefined;
	const escape = (text: string) =>
		text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
	return new RegExp(
		String.raw`(?<!\w)${escape(stem)}(?:${escape(extension)})?(?!\w)`,
	);
}

/**
 * True when the text looks like it holds a secret: a long token-like run, a
 * key-like run with a letter and a digit, a URL with credentials, a secret's
 * name followed by a value, a well-known key prefix, or a long hex run. It
 * errs toward dropping a sentence.
 */
export function looksSecret(text: string): boolean {
	return (
		TOKEN_LIKE.test(text) ||
		(text.match(KEY_RUN) ?? []).some(
			run => /[A-Za-z]/.test(run) && /\d/.test(run),
		) ||
		URL_CREDENTIALS.test(text) ||
		KEYWORD_VALUE.test(text) ||
		KEY_PREFIX.test(text) ||
		HEX_RUN.test(text)
	);
}

/**
 * The sentences, from what the user told their agent, that give a reason:
 * 6 to 60 words with a cause word or the name of a staged file, emails
 * replaced, nothing that looks secret, and rated at least ok by the local Why rules.
 * Newest first, at most 12.
 */
export function reasonCandidates(
	messages: string[],
	stagedFiles: string[],
): string[] {
	const names = stagedFiles
		.map(file => path.basename(file).toLowerCase())
		.map(namePattern)
		.filter(pattern => pattern !== undefined);
	const found: string[] = [];
	for (const message of [...messages].reverse()) {
		for (const piece of message.split(SENTENCES)) {
			const cleaned = cleanReason(piece);
			if (cleaned === '' || cleaned.length > MAX_WHY) continue;
			const words = whyWords(cleaned);
			if (words.length < 6 || words.length > 60) continue;
			const lower = cleaned.toLowerCase();
			if (
				!words.some(word => CAUSAL_MARKERS.has(word)) &&
				!names.some(name => name.test(lower))
			) {
				continue;
			}

			// Judge the unmasked text too: masking an email hides `user:pass@host`.
			const text = redact(cleaned);
			if (looksSecret(cleaned) || looksSecret(text)) continue;
			const verdict = judgeWhy(
				{why: [text], constraint: [], gotcha: [], followUp: []},
				'',
			);
			if (verdict.level === 'thin' || found.includes(text)) continue;
			found.push(text);
			if (found.length === MAX_CANDIDATES) return found;
		}
	}

	return found;
}

/**
 * A Why to offer from the user's own session, or undefined. With a Jev client
 * it asks which candidate best says why; only those sentences, redacted, and
 * the staged paths are sent. A failed request, or one with no answer within
 * the composer's advice timeout, offers nothing: the user asked Jev to choose.
 */
export async function draftFromSession(input: {
	root: string;
	home: string;
	now: Date;
	stagedFiles: string[];
	client?: AdvisorClient;
	timeoutMs?: number;
}): Promise<WhyDraft | undefined> {
	const {
		root,
		home,
		now,
		stagedFiles,
		client,
		timeoutMs = ADVICE_TIMEOUT_MS,
	} = input;
	const session = await recentUserMessages(root, {home, now});
	if (!session) return undefined;
	const candidates = reasonCandidates(session.messages, stagedFiles);
	if (candidates.length === 0) return undefined;
	const source =
		session.source === 'codex'
			? 'your Codex session'
			: 'your Claude Code session';
	if (!client) return {text: candidates[0]!, source};
	try {
		const criteria: Record<string, string> = {};
		for (const [index, text] of candidates.entries())
			criteria[`c${index}`] = text;
		criteria['none'] = 'None of these says why they made the change.';
		const reply = await withTimeout(
			client.systemOne({
				state: {files: stagedFiles},
				questions: {
					pick: {
						type: 'choice',
						instructions:
							'A developer is committing a change to `files`. Which of these sentences, from what they told their coding assistant, best says why they made the change?',
						criteria,
					},
				},
			}),
			timeoutMs,
		);
		if (!reply) return undefined;
		const {answers} = reply;
		const odds = Object.entries(answers['pick']?.probabilities ?? {}).sort(
			(a, b) => b[1] - a[1],
		)[0];
		if (!odds || odds[1] < 0.5 || odds[0] === 'none') return undefined;
		const text = candidates[Number(odds[0].slice(1))];
		return text === undefined ? undefined : {text, source};
	} catch {
		return undefined;
	}
}
