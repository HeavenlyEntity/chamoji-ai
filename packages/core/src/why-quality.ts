import type {IntentCard} from './types.js';

/** Why a `Why:` line was judged thin. */
export type WhyReason =
	| 'filler'
	| 'too-short'
	| 'repeats-subject'
	| 'what-not-why'
	| 'ai-unclear';

/** The verdict on a card's Why: `advice` is the first reason's, or empty. */
export type WhyVerdict = {
	level: 'ok' | 'thin';
	reasons: WhyReason[];
	advice: string;
};

const ASK =
	'Name the bug, limit or request behind this, or what breaks if someone reverts it.';

/** One sentence of advice per reason, in plain words. */
export const WHY_ADVICE: Record<WhyReason, string> = {
	filler: ASK,
	'too-short': ASK,
	'what-not-why': ASK,
	'repeats-subject':
		'This repeats the subject. Say what made the change necessary.',
	'ai-unclear':
		"This doesn't say what would go wrong without the change. Name the cause or the limit behind it.",
};

/** Phrases that say nothing, so a Why made only of them says nothing. */
export const FILLER_PHRASES: readonly string[] = [
	'fix',
	'fixes',
	'fixed',
	'fix bug',
	'bug fix',
	'update',
	'updates',
	'updated',
	'cleanup',
	'clean up',
	'refactor',
	'needed',
	'required',
	'requested',
	'as discussed',
	'per review',
	'per request',
	'for the ticket',
	'wip',
	'minor',
	'small change',
	'it was broken',
	'to make it work',
	'improvement',
	'improvements',
	'changes',
	'tweak',
	'tweaks',
];

/** Words that make up no part of the reason, such as articles and glue. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
	'a',
	'an',
	'the',
	'to',
	'of',
	'for',
	'in',
	'on',
	'and',
	'or',
	'is',
	'it',
	'this',
	'that',
	'with',
	'so',
]);

/** Verbs that open a sentence saying what changed rather than why. */
export const ACTION_VERBS: ReadonlySet<string> = new Set([
	'add',
	'adds',
	'added',
	'remove',
	'removes',
	'removed',
	'update',
	'updates',
	'updated',
	'change',
	'changes',
	'changed',
	'rename',
	'renamed',
	'move',
	'moved',
	'bump',
	'bumped',
	'refactor',
	'refactored',
	'use',
	'switch',
	'make',
]);

/** Words that tie a sentence to a cause, a limit or a consequence. */
export const CAUSAL_MARKERS: ReadonlySet<string> = new Set([
	'because',
	'so',
	'otherwise',
	'since',
	'when',
	'after',
	'caused',
	'causes',
	'fails',
	'failed',
	'failing',
	'broke',
	'breaks',
	'broken',
	'returns',
	'returned',
	'until',
	'before',
	'without',
	'unless',
	'if',
]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu;
/** Scripts written without spaces, where each character counts as a word. */
const CHARACTER_WORD =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;
const MIN_WORDS = 5;
const REPEAT_SHARE = 0.7;

/**
 * The words in a text, lowercased. Chinese, Japanese and Thai are written
 * without spaces, so each of their characters counts as one word.
 */
export function whyWords(text: string): string[] {
	return (
		text.toLowerCase().replaceAll(CHARACTER_WORD, ' $& ').match(WORD) ?? []
	);
}

const escapeRegex = (text: string): string =>
	text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** One whole-word pattern for every filler phrase, longest phrase first. */
const FILLER = new RegExp(
	`(?<![\\p{L}\\p{N}'_-])(?:${[...FILLER_PHRASES]
		.sort((a, b) => b.length - a.length)
		.map(phrase => escapeRegex(phrase).replaceAll(' ', String.raw`\s+`))
		.join('|')})(?![\\p{L}\\p{N}'_-])`,
	'gu',
);

/**
 * Whether a card's `Why:` says why. Local and deterministic. A card with a
 * constraint, gotcha or follow-up line, or with no Why at all, is ok, since
 * it says something else useful or has nothing to judge. Otherwise the Why
 * lines are judged together, and the rules lean toward letting a Why through.
 * Reasons come in check order and `advice` is the first reason's.
 */
export function judgeWhy(card: IntentCard, subject: string): WhyVerdict {
	const ok: WhyVerdict = {level: 'ok', reasons: [], advice: ''};
	if (
		card.why.length === 0 ||
		card.constraint.length > 0 ||
		card.gotcha.length > 0 ||
		card.followUp.length > 0
	) {
		return ok;
	}

	const text = card.why.join(' ').toLowerCase();
	const left = whyWords(text.replaceAll(FILLER, ' '));
	const reasons: WhyReason[] = [];
	if (left.length === 0) {
		reasons.push('filler');
	}

	if (left.length < MIN_WORDS) {
		reasons.push('too-short');
	}

	if (repeatsSubject(whyWords(text), whyWords(subject))) {
		reasons.push('repeats-subject');
	}

	if (describesChange(text)) {
		reasons.push('what-not-why');
	}

	return reasons.length === 0
		? ok
		: {level: 'thin', reasons, advice: WHY_ADVICE[reasons[0]!]};
}

/** True when most of the Why's content words are the subject's own. */
function repeatsSubject(why: string[], subject: string[]): boolean {
	const content = why.filter(word => !STOP_WORDS.has(word));
	if (content.length === 0) {
		return false;
	}

	const known = new Set(subject.filter(word => !STOP_WORDS.has(word)));
	const shared = content.filter(word => known.has(word)).length;
	return shared / content.length >= REPEAT_SHARE;
}

/** True when the Why opens with an action verb and names no cause. */
function describesChange(text: string): boolean {
	const all = whyWords(text);
	if (!ACTION_VERBS.has(all[0] ?? '')) {
		return false;
	}

	return !(
		all.some(word => CAUSAL_MARKERS.has(word)) ||
		/\d/.test(text) ||
		/["`]/.test(text)
	);
}
