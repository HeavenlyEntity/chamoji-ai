import {execFile} from 'node:child_process';
import {runGit, runGitWithInput} from './git.js';
import {readIntent} from './intent.js';
import type {IntentCard} from './types.js';

/** Where a better reason for an old commit lives; history is never rewritten. */
export const NOTES_REF = 'refs/notes/chamoji';

const CARD_LINE = /^(why|constraint|gotcha|follow-up):[ \t]+\S/im;

/**
 * A note as card text. Text with a card line is kept as it is. Anything else
 * is a reason, so it becomes `Why: <first paragraph on one line>`.
 */
export function noteText(reason: string): string {
	if (CARD_LINE.test(reason)) return reason;
	const paragraph = reason.trim().split(/\n\s*\n/)[0] ?? '';
	return `Why: ${paragraph.trim().replaceAll(/\s*\n\s*/g, ' ')}`;
}

/** The card a note holds, or undefined when it says nothing. */
export function noteCard(text: string): IntentCard | undefined {
	return readIntent([], noteText(text));
}

/** The card added to one commit. No notes ref, or no note on it, gives undefined. */
export async function readNoteCard(
	cwd: string,
	hash: string,
): Promise<IntentCard | undefined> {
	try {
		const text = await runGit(['notes', '--ref=chamoji', 'show', hash], cwd);
		return noteCard(text);
	} catch {
		return undefined;
	}
}

/** Every added card, by full commit hash. */
export async function readNoteCards(
	cwd: string,
): Promise<Map<string, IntentCard>> {
	const cards = new Map<string, IntentCard>();
	let listing: string;
	try {
		listing = await runGit(['notes', '--ref=chamoji', 'list'], cwd);
	} catch {
		return cards;
	}

	const owners = new Map<string, string[]>();
	for (const line of listing.split('\n')) {
		const [blob, hash] = line.trim().split(' ');
		if (!blob || !hash) continue;
		owners.set(blob, [...(owners.get(blob) ?? []), hash]);
	}

	if (owners.size === 0) return cards;
	let output: Buffer;
	try {
		output = await catBlobs(cwd, [...owners.keys()]);
	} catch {
		return cards;
	}

	// Each entry is `<oid> <type> <size>\n<size bytes>\n`, or `<oid> missing\n`.
	let at = 0;
	while (at < output.length) {
		const end = output.indexOf(0x0a, at);
		if (end === -1) break;
		const [oid, type, size] = output.toString('latin1', at, end).split(' ');
		at = end + 1;
		if (type === undefined || size === undefined) continue;
		const length = Number(size);
		if (!Number.isInteger(length) || at + length > output.length) break;
		const text = output.toString('utf8', at, at + length);
		at += length + 1;
		if (type !== 'blob') continue;
		const card = noteCard(text);
		if (!card) continue;
		for (const hash of owners.get(oid!) ?? []) cards.set(hash, card);
	}

	return cards;
}

/** `git cat-file --batch` for `blobs`, as raw bytes so sizes stay exact. */
function catBlobs(cwd: string, blobs: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'git',
			['cat-file', '--batch'],
			{cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
		child.stdin?.on('error', () => {});
		child.stdin?.end(`${blobs.join('\n')}\n`);
	});
}

/** Sets the commit's note, replacing any earlier one. */
export async function writeNoteCard(
	cwd: string,
	hash: string,
	reason: string,
): Promise<void> {
	await runGitWithInput(
		['notes', '--ref=chamoji', 'add', '-f', '-F', '-', hash],
		cwd,
		`${noteText(reason)}\n`,
	);
}

/** One card from an added one and the commit's own; added lines come first. */
export function mergeCards(
	added: IntentCard | undefined,
	own: IntentCard | undefined,
): IntentCard | undefined {
	if (!added) return own;
	if (!own) return added;
	return {
		why: [...added.why, ...own.why],
		constraint: [...added.constraint, ...own.constraint],
		gotcha: [...added.gotcha, ...own.gotcha],
		followUp: [...added.followUp, ...own.followUp],
	};
}
