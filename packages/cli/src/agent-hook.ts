import {judgeWhy, readIntent} from '@chamoji/core';
import {isRecord, own} from './records.js';
import type {Io} from './run.js';

/** Said to the agent when it commits with no card. */
export const DENY_REASON =
	'Add why this change was made: put a "Why: <reason>" line at the end of the commit message, after a blank line. Constraint:, Gotcha: and Follow-up: lines are welcome too. Only if the user told you to skip this, prefix the command with CHAMOJI_NO_CARD=1.';

/** More than a hook input ever holds: a command and a few fields. */
const MAX_INPUT = 1024 * 1024;

const CARD_KEY = '(?:why|constraint|gotcha|follow-up)';

/**
 * A line of the body that the intent card parser reads (core's intent.ts): it
 * trims the line, then wants a card key, a colon, a space and some text.
 */
const CARD_LINE = new RegExp(`^[ \\t]*${CARD_KEY}:[ \\t]+\\S`, 'im');

/**
 * A card line in git's trailer form, which `--trailer` values and the last
 * paragraph of a message use, and which lets the colon touch the value.
 */
const CARD_TRAILER = new RegExp(`^[ \\t]*${CARD_KEY}[ \\t]*:[ \\t]*\\S`, 'i');

/** A line git would count as part of a trailer block: `Key: value`, or a continuation. */
const TRAILER_LINE = /^(?:[\w-]+[ \t]*:|[ \t]+\S)/;

/** Long flags whose next word is their value, so that word is not read as a flag. */
const TAKES_VALUE = new Set([
	'--template',
	'--author',
	'--date',
	'--cleanup',
	'--pathspec-from-file',
]);

/** Flags that name the message elsewhere, or mean nothing is committed. */
const KEEPS_MESSAGE = new Set([
	'--file',
	'--reuse-message',
	'--reedit-message',
	'--fixup',
	'--squash',
	'--dry-run',
	'--help',
]);

/** `<<EOF`, `<<-'EOF'`: the dash strips tabs, and quoting the delimiter is only about expansion. */
const HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s&|;()<>]+))/;

/** `git -C dir`, `git -c key=value` and the like, before the subcommand. */
const GIT_TAKES_VALUE = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--super-prefix',
	'--config-env',
]);

/** One simple command: its words with the quotes taken off, and the heredoc bodies fed to it. */
type Segment = {words: string[]; heredocs: string[]};

/**
 * Splits shell text into commands at `&&`, `||`, `;`, `|`, `&`, newlines and
 * parentheses, so a mention of `git commit` inside a quoted string, a heredoc
 * or an `echo` is not a commit. It is not a shell: it knows quotes, escapes,
 * `$( )`, backticks and heredocs, and nothing else (no variables, aliases or
 * `sh -c`).
 */
function split(text: string): Segment[] {
	const segments: Segment[] = [];
	let segment: Segment = {words: [], heredocs: []};
	segments.push(segment);
	let word: string | undefined;
	const waiting: Array<{
		delimiter: string;
		stripTabs: boolean;
		segment: Segment;
	}> = [];
	let i = 0;

	const endWord = () => {
		if (word !== undefined) segment.words.push(word);
		word = undefined;
	};

	const endSegment = () => {
		endWord();
		segment = {words: [], heredocs: []};
		segments.push(segment);
	};

	/** Reads heredoc bodies from `start`; returns where the next line begins. */
	const readBodies = (start: number): number => {
		let at = start;
		for (const {delimiter, stripTabs, segment: owner} of waiting.splice(0)) {
			const [body, next] = heredocBody(text, at, delimiter, stripTabs);
			owner.heredocs.push(body);
			at = next;
		}

		return at;
	};

	while (i < text.length) {
		const char = text[i]!;
		if (char === '\\') {
			if (text[i + 1] !== '\n') word = (word ?? '') + (text[i + 1] ?? '');
			i += 2;
		} else if (char === "'") {
			const close = text.indexOf("'", i + 1);
			const end = close === -1 ? text.length : close;
			word = (word ?? '') + text.slice(i + 1, end);
			i = end + 1;
		} else if (char === '"' || (char === '$' && text[i + 1] === '"')) {
			// $"…" is a double-quoted string that bash may translate.
			const [value, next] = doubleQuoted(text, i + (char === '$' ? 2 : 1));
			word = (word ?? '') + value;
			i = next;
		} else if (char === '$' && text[i + 1] === "'") {
			const [value, next] = ansiQuoted(text, i + 2);
			word = (word ?? '') + value;
			i = next;
		} else if (char === '#' && word === undefined) {
			const newline = text.indexOf('\n', i);
			i = newline === -1 ? text.length : newline;
		} else if (char === ' ' || char === '\t' || char === '\r') {
			endWord();
			i++;
		} else if (char === '\n') {
			endSegment();
			i = readBodies(i + 1);
		} else if ('&|;()'.includes(char)) {
			endSegment();
			i++;
		} else if (text.startsWith('<<<', i)) {
			endWord();
			i += 3;
		} else if (text.startsWith('<<', i)) {
			const heredoc = HEREDOC.exec(text.slice(i, i + 200));
			endWord();
			if (heredoc) {
				waiting.push({
					delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? '',
					stripTabs: heredoc[1] === '-',
					segment,
				});
				i += heredoc[0].length;
			} else {
				i += 2;
			}
		} else {
			word = (word ?? '') + char;
			i++;
		}
	}

	endWord();
	readBodies(text.length);
	return segments.filter(
		({words, heredocs}) => words.length > 0 || heredocs.length > 0,
	);
}

/** The body of a heredoc that starts at `start`, and where the line after its delimiter begins. */
function heredocBody(
	text: string,
	start: number,
	delimiter: string,
	stripTabs: boolean,
): [string, number] {
	let at = start;
	while (at < text.length) {
		const newline = text.indexOf('\n', at);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(at, end).replace(/\r$/, '');
		if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
			return [text.slice(start, at), end + 1];
		}

		at = end + 1;
	}

	return [text.slice(start), text.length];
}

/**
 * Reads a double-quoted string that starts after its opening quote. A `$( )`
 * inside it can hold quotes and a heredoc of its own, such as the usual
 * `-m "$(cat <<'EOF' ... EOF)"`, so it is skipped as a whole and kept as text.
 * Returns the text and where the string ends.
 */
function doubleQuoted(text: string, start: number): [string, number] {
	let value = '';
	let i = start;
	while (i < text.length) {
		const char = text[i]!;
		if (char === '"') return [value, i + 1];
		if (char === '\\') {
			const next = text[i + 1] ?? '';
			if (next === '\n') {
				// A line continuation vanishes.
			} else if ('"\\$`'.includes(next)) {
				value += next;
			} else {
				value += char + next;
			}

			i += 2;
		} else if (char === '$' && text[i + 1] === '(') {
			const end = substitutionEnd(text, i + 2);
			value += text.slice(i, end);
			i = end;
		} else if (char === '`') {
			const close = text.indexOf('`', i + 1);
			const end = close === -1 ? text.length : close + 1;
			value += text.slice(i, end);
			i = end;
		} else {
			value += char;
			i++;
		}
	}

	return [value, text.length];
}

/** What `\n` and the like mean inside `$'…'`. */
const ANSI_ESCAPES = new Map([
	['n', '\n'],
	['t', '\t'],
	['r', '\r'],
	['a', '\x07'],
	['b', '\b'],
	['e', '\x1B'],
	['E', '\x1B'],
	['f', '\f'],
	['v', '\v'],
	['\\', '\\'],
	["'", "'"],
	['"', '"'],
	['?', '?'],
]);

/**
 * Reads a `$'…'` string that starts after its opening quote, with the
 * escapes bash gives it (`\n`, `\x41`, `é`, `\101`, `\'`). Returns the
 * text and where the string ends.
 */
function ansiQuoted(text: string, start: number): [string, number] {
	let value = '';
	let i = start;
	while (i < text.length) {
		const char = text[i]!;
		if (char === "'") return [value, i + 1];
		if (char !== '\\' || i + 1 >= text.length) {
			value += char;
			i++;
			continue;
		}

		const next = text[i + 1]!;
		const simple = ANSI_ESCAPES.get(next);
		const numeric =
			/^(?:x([\da-f]{1,2})|u([\da-f]{1,4})|U([\da-f]{1,8})|([0-7]{1,3}))/i.exec(
				text.slice(i + 1, i + 11),
			);
		if (simple !== undefined) {
			value += simple;
			i += 2;
		} else if (numeric) {
			const code = Number.parseInt(
				numeric[1] ?? numeric[2] ?? numeric[3] ?? numeric[4]!,
				numeric[4] === undefined ? 16 : 8,
			);
			value += code <= 0x10_ffff ? String.fromCodePoint(code) : '';
			i += 1 + numeric[0].length;
		} else {
			value += char + next;
			i += 2;
		}
	}

	return [value, text.length];
}

/** Where the `$(` that opened before `start` closes: past its `)`, or the end of the text. */
function substitutionEnd(text: string, start: number): number {
	let depth = 1;
	let i = start;
	const waiting: Array<{delimiter: string; stripTabs: boolean}> = [];
	while (i < text.length) {
		const char = text[i]!;
		if (char === '\\') {
			i += 2;
		} else if (char === "'") {
			const close = text.indexOf("'", i + 1);
			i = close === -1 ? text.length : close + 1;
		} else if (char === '$' && text[i + 1] === "'") {
			i = ansiQuoted(text, i + 2)[1];
		} else if (char === '"') {
			i = doubleQuoted(text, i + 1)[1];
		} else if (char === '(') {
			depth++;
			i++;
		} else if (char === ')') {
			depth--;
			i++;
			if (depth === 0) return i;
		} else if (char === '\n') {
			i++;
			for (const {delimiter, stripTabs} of waiting.splice(0)) {
				i = heredocBody(text, i, delimiter, stripTabs)[1];
			}
		} else if (text.startsWith('<<<', i)) {
			i += 3;
		} else if (text.startsWith('<<', i)) {
			const heredoc = HEREDOC.exec(text.slice(i, i + 200));
			if (heredoc) {
				waiting.push({
					delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? '',
					stripTabs: heredoc[1] === '-',
				});
				i += heredoc[0].length;
			} else {
				i += 2;
			}
		} else {
			i++;
		}
	}

	return text.length;
}

/** `$(cat <<'EOF' ... EOF)` as one word is the heredoc's text. */
const CAT_HEREDOC =
	/^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)$/;

function unwrapCat(text: string): string {
	return CAT_HEREDOC.exec(text.trim())?.[3] ?? text;
}

/**
 * The message the commit will have, as far as the hook can read it: the own
 * `-m` values and heredocs joined by blank lines. A `$(cat <<EOF ...)` in `-m`
 * is the heredoc's text, which is read as the message instead.
 */
function buildMessage(parts: string[], heredocs: string[]): string {
	const messages = parts.map(unwrapCat);
	const own =
		heredocs.length > 0
			? messages.filter(text => !text.includes('$(') && !text.includes('`'))
			: messages;
	return [...own, ...heredocs].join('\n\n').trimStart();
}

/**
 * Whether the message the commit will have carries a card, by the parser's
 * own rules. The subject is the first paragraph, as git counts it, and is never
 * read for a card, so `-m "Why: because"` is a subject, not a card.
 */
function hasCard(
	messages: string[],
	trailers: string[],
	heredocs: string[],
): boolean {
	if (trailers.some(trailer => CARD_TRAILER.test(trailer))) return true;
	const message = buildMessage(messages, heredocs);
	const [, ...paragraphs] = message.trimEnd().split(/\r?\n[ \t\r]*\n/);
	if (paragraphs.some(paragraph => CARD_LINE.test(paragraph))) return true;
	// The parser also takes git's trailer block, the last paragraph, and that
	// reads `Why:nospace`, which a line scan does not.
	const last = paragraphs.at(-1)?.split('\n') ?? [];
	return (
		last.length > 0 &&
		last.every(line => TRAILER_LINE.test(line)) &&
		last.some(line => CARD_TRAILER.test(line))
	);
}

/** The message parts of one `git commit` that has a message to read. */
type Parts = {messages: string[]; trailers: string[]};

/**
 * What one `git commit` puts in its message, or undefined when the message
 * is elsewhere (a file, another commit) or nothing is committed.
 */
function readParts(args: string[]): Parts | undefined {
	// Only what goes into the message can hold a card: -m, --trailer and heredocs.
	const messages: string[] = [];
	const trailers: string[] = [];
	let noEdit = false;
	let hasMessage = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i]!;
		if (word === '--') break;
		if (word.startsWith('--')) {
			const equals = word.indexOf('=');
			const name = equals === -1 ? word : word.slice(0, equals);
			if (KEEPS_MESSAGE.has(name)) return undefined;
			if (name === '--no-edit') {
				noEdit = true;
			} else if (name === '--message' || name === '--trailer') {
				const value = equals === -1 ? args[++i] : word.slice(equals + 1);
				if (value !== undefined) {
					(name === '--trailer' ? trailers : messages).push(value);
				}

				hasMessage ||= name === '--message';
			} else if (equals === -1 && TAKES_VALUE.has(name)) {
				i++;
			}
		} else if (word.startsWith('-') && word.length > 1) {
			// A cluster such as -am: the first flag that takes a value ends it.
			for (let at = 1; at < word.length; at++) {
				const flag = word[at]!;
				if (flag === 'h' || 'FCc'.includes(flag)) return undefined;
				if (flag === 'm' || flag === 't') {
					const value = at === word.length - 1 ? args[++i] : word.slice(at + 1);
					if (value !== undefined && flag === 'm') messages.push(value);
					hasMessage ||= flag === 'm';
					break;
				}

				// -S and -u take only what is attached to them.
				if (flag === 'S' || flag === 'u') break;
			}
		}
	}

	// --no-edit reuses the message of an amend or a merge. Given a message too,
	// it is a plain commit and that message needs its card.
	if (noEdit && !hasMessage) return undefined;
	return {messages, trailers};
}

/** A card whose Why says nothing, with what to tell the agent. */
export type ThinCard = {why: string; advice: string};

/** The thin verdict on the message these parts make, if its card is readable and thin. */
function thinCard(
	{messages, trailers}: Parts,
	heredocs: string[],
): ThinCard | undefined {
	const message = buildMessage(messages, heredocs);
	const [subject = '', ...paragraphs] = message
		.trimEnd()
		.split(/\r?\n[ \t\r]*\n/);
	const rest = [...paragraphs, trailers.join('\n')]
		.filter(paragraph => paragraph.trim() !== '')
		.join('\n\n');
	const card = readIntent([], rest);
	if (!card) return undefined;
	const verdict = judgeWhy(card, subject.split(/\r?\n/)[0] ?? '');
	return verdict.level === 'thin'
		? {why: card.why.join(' '), advice: verdict.advice}
		: undefined;
}

/**
 * Whether the shell text commits something, and whether that commit carries a
 * card. Every `git commit` in it needs one, unless it is prefixed with
 * `CHAMOJI_NO_CARD=1`, names its message in a file or another commit, only
 * shows or checks (`--dry-run`, `--help`), or reuses a message with `--no-edit`.
 * A bare `git commit` has no message to read, so it is denied.
 */
export function decideCommit(command: string): 'allow' | 'deny' {
	return judgeCommit(command) === 'deny' ? 'deny' : 'allow';
}

/**
 * Like `decideCommit`, and for a commit with a readable card it also judges
 * the Why: the first thin one comes back as a `ThinCard`. A `deny` anywhere
 * wins over a thin card.
 */
export function judgeCommit(command: string): 'allow' | 'deny' | ThinCard {
	let thin: ThinCard | undefined;
	for (const {words, heredocs} of split(command)) {
		let at = 0;
		let optedOut = false;
		for (;;) {
			const word = words[at];
			if (word === undefined) break;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
				optedOut ||= word === 'CHAMOJI_NO_CARD=1';
			} else if (word !== 'env') {
				break;
			}

			at++;
		}

		const git = words[at];
		if (git !== 'git' && !git?.endsWith('/git')) continue;
		at++;
		while (words[at]?.startsWith('-')) {
			at += GIT_TAKES_VALUE.has(words[at]!) ? 2 : 1;
		}

		if (words[at] !== 'commit') continue;
		if (optedOut) continue;
		const parts = readParts(words.slice(at + 1));
		if (!parts) continue;
		if (!hasCard(parts.messages, parts.trailers, heredocs)) return 'deny';
		thin ??= thinCard(parts, heredocs);
	}

	return thin ?? 'allow';
}

/** Said to the agent when its Why line is there but says nothing. */
export function thinReason(thin: ThinCard): string {
	const why = thin.why.length > 80 ? `${thin.why.slice(0, 79)}…` : thin.why;
	return `Your Why ("${why}") doesn't say why. ${thin.advice} Only if the user told you to keep it, prefix the command with CHAMOJI_NO_CARD=1.`;
}

/** Reads the hook's input, or undefined when it is longer than any real one. */
async function readInput(
	stdin: NodeJS.ReadableStream,
): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stdin) {
		const buffer =
			typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
		size += buffer.length;
		if (size > MAX_INPUT) return undefined;
		chunks.push(buffer);
	}

	return Buffer.concat(chunks).toString('utf8');
}

/**
 * `chamoji agent-hook`: what Claude Code runs before a Bash command. It
 * denies a `git commit` that carries no intent card, so the agent can write
 * one while it still can, and prints nothing for anything else. Whatever goes
 * wrong, it prints nothing and exits 0: a broken hook must not stop the agent.
 */
export async function runAgentHook(
	io: Io & {stdin: NodeJS.ReadableStream},
): Promise<number> {
	try {
		const raw = await readInput(io.stdin);
		if (raw === undefined) return 0;
		const input: unknown = JSON.parse(raw);
		if (!isRecord(input) || own(input, 'tool_name') !== 'Bash') return 0;
		const toolInput = own(input, 'tool_input');
		const command = isRecord(toolInput) ? own(toolInput, 'command') : undefined;
		if (typeof command !== 'string') return 0;
		const verdict = judgeCommit(command);
		if (verdict === 'allow') return 0;
		const reason = verdict === 'deny' ? DENY_REASON : thinReason(verdict);

		io.stdout(
			`${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: reason,
				},
			})}\n`,
		);
	} catch {
		// A hook that fails says nothing and lets the command through.
	}

	return 0;
}
