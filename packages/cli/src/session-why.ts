import {open, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {CAUSAL_MARKERS, judgeWhy, type WhyDraft} from '@chamoji/core';
import type {AdvisorClient} from './advisor.js';
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
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu;
/** A run this long looks like a key or token, not a word. */
const TOKEN_LIKE = /[A-Za-z0-9_-]{24,}/;
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
		if (
			!isObject(line) ||
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
function within(root: string, cwd: string): boolean {
	const relative = path.relative(root, cwd);
	return (
		relative === '' ||
		(!relative.startsWith('..') && !path.isAbsolute(relative))
	);
}

/**
 * The sentences, from what the user told their agent, that give a reason:
 * 6 to 60 words with a cause word or the name of a staged file, emails
 * replaced, nothing token-like, and rated at least ok by the local Why rules.
 * Newest first, at most 12.
 */
export function reasonCandidates(
	messages: string[],
	stagedFiles: string[],
): string[] {
	const names = stagedFiles
		.map(file => path.basename(file).toLowerCase())
		.filter(name => name !== '');
	const found: string[] = [];
	for (const message of [...messages].reverse()) {
		for (const piece of message.split(SENTENCES)) {
			const cleaned = cleanReason(piece);
			if (cleaned === '' || cleaned.length > MAX_WHY) continue;
			const words = cleaned.toLowerCase().match(WORD) ?? [];
			if (words.length < 6 || words.length > 60) continue;
			const lower = cleaned.toLowerCase();
			if (
				!words.some(word => CAUSAL_MARKERS.has(word)) &&
				!names.some(name => lower.includes(name))
			) {
				continue;
			}

			const text = redact(cleaned);
			if (TOKEN_LIKE.test(text)) continue;
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
 * the staged paths are sent. A failed request offers nothing.
 */
export async function draftFromSession(input: {
	root: string;
	home: string;
	now: Date;
	stagedFiles: string[];
	client?: AdvisorClient;
}): Promise<WhyDraft | undefined> {
	const {root, home, now, stagedFiles, client} = input;
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
		const {answers} = await client.systemOne({
			state: {files: stagedFiles},
			questions: {
				pick: {
					type: 'choice',
					instructions:
						'A developer is committing a change to `files`. Which of these sentences, from what they told their coding assistant, best says why they made the change?',
					criteria,
				},
			},
		});
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
