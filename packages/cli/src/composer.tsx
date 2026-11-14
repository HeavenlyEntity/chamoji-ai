import {
	formatCommitMessage,
	getGitmoji,
	judgeWhy,
	WHY_ADVICE,
	searchGitmojis,
	type ComposeConfig,
	type WhyDraft,
	type CommitDraft,
	type GitmojiInfo,
} from '@chamoji/core';
import {Box, render, Text, useInput} from 'ink';
import {useEffect, useRef, useState} from 'react';
import {HINT_THRESHOLD, PRESELECT_THRESHOLD, type Advice} from './advisor.js';
import {stripControl} from './text.js';

type Step =
	| 'gitmoji'
	| 'scope'
	| 'title'
	| 'body'
	| 'why'
	| 'breaking'
	| 'breakingText'
	| 'release';

const PROMPTS: Record<Step, string> = {
	gitmoji: 'Gitmoji',
	scope: 'Scope (optional)',
	title: 'Title',
	body: 'Body (optional)',
	why: 'What would break, or come back, if someone undid this? (kept as Why:)',
	breaking: 'Breaking change? (y/N)',
	breakingText: 'What breaks?',
	release: 'Release',
};

/** Which units the staged change releases, and which only ride along. */
export type Impact = {own: string[]; rides: string[]};

const names = (units: string[]) => units.map(unit => stripControl(unit));

const LIST_SIZE = 7;

/** How long Enter on the Why waits for Jev's check before carrying on. */
const WHY_CHECK_TIMEOUT_MS = 2000;

/** How long the composer waits for Jev's advice before carrying on without it. */
const ADVICE_TIMEOUT_MS = 2000;

export type ComposerProps = {
	config: ComposeConfig;
	onSubmit: (message: string) => void;
	onCancel: () => void;
	/** Jev's advice, when AI is on. The composer never waits for it. */
	advice?: Promise<Advice | null>;
	adviceTimeoutMs?: number;
	/**
	 * Jev's second opinion on a Why the local rules passed, when AI is on:
	 * true means the reason is unclear. It only warns; a timeout or an error
	 * counts as fine.
	 */
	checkWhy?: (why: string, title: string) => Promise<boolean>;
	checkWhyTimeoutMs?: number;
	/** The units the staged change touches, with a release section. */
	impact?: Impact;
	/** A reason the user gave their agent. Tab on an empty Why fills it; nothing fills it on its own. */
	draft?: WhyDraft;
};

/**
 * The commit composer: pick a gitmoji, then scope, title, body, why and
 * breaking. Enter moves on, Esc goes back, Ctrl-C cancels.
 */
export function Composer({
	config,
	onSubmit,
	onCancel,
	advice: pendingAdvice,
	adviceTimeoutMs = ADVICE_TIMEOUT_MS,
	checkWhy,
	checkWhyTimeoutMs = WHY_CHECK_TIMEOUT_MS,
	impact,
	draft: whyDraft,
}: ComposerProps) {
	// A change that releases no unit of its own but rides along to some can
	// release them now, with a Release: trailer each.
	const offered = impact && impact.own.length === 0 ? impact.rides : [];
	const steps: Step[] = [
		'gitmoji',
		...(config.scopePrompt ? (['scope'] as const) : []),
		'title',
		...(config.messagePrompt ? (['body'] as const) : []),
		'why',
		'breaking',
		...(offered.length > 0 ? (['release'] as const) : []),
	];
	const [step, setStep] = useState<Step>('gitmoji');
	const [text, setText] = useState<Record<Step, string>>({
		gitmoji: '',
		scope: '',
		title: '',
		body: '',
		why: '',
		breaking: '',
		breakingText: '',
		release: '',
	});
	const [breakingValue, setBreakingValue] = useState<string | boolean>();
	const [selected, setSelected] = useState(0);
	// The thin Why the person was last warned about; Enter on it again keeps it.
	const [warnedFor, setWarnedFor] = useState<string | null>(null);
	const [whyAdvice, setWhyAdvice] = useState('');
	// A Jev check on the Why is out. Any key but Enter drops its answer.
	const [checking, setChecking] = useState(false);
	const checkToken = useRef(0);
	const [gitmoji, setGitmoji] = useState<string | null>(null);
	const [advice, setAdvice] = useState<Advice | null>(null);
	// Suggestions reorder the list only if they arrive before any keypress,
	// so the list never moves under someone who has started typing.
	const [suggestFirst, setSuggestFirst] = useState(false);
	const touched = useRef(false);

	useEffect(() => {
		if (!pendingAdvice) return;
		let live = true;
		const timer = setTimeout(() => {
			live = false;
		}, adviceTimeoutMs);
		pendingAdvice
			.then(result => {
				if (!live || !result) return;
				setAdvice(result);
				setSuggestFirst(!touched.current);
			})
			.catch(() => undefined);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [pendingAdvice, adviceTimeoutMs]);

	const advised: GitmojiInfo[] =
		advice && suggestFirst && text.gitmoji === ''
			? advice.gitmojis.flatMap(item => getGitmoji(item.code) ?? [])
			: [];
	const confident =
		(advice?.gitmojis[0]?.probability ?? 0) >= PRESELECT_THRESHOLD;
	const suggested = confident ? advised : [];
	const suggestedCodes = new Set(suggested.map(item => item.code));
	const matches = [
		...suggested,
		...searchGitmojis(text.gitmoji, 20).filter(
			item => !suggestedCodes.has(item.code),
		),
	].slice(0, 20);
	const hint = (value: number | undefined) =>
		value !== undefined && value >= HINT_THRESHOLD;
	const draft = (
		breaking?: string | boolean,
		release = false,
	): CommitDraft => ({
		gitmoji: gitmoji ?? 'sparkles',
		scope: text.scope,
		title: text.title,
		body: text.body,
		why: text.why,
		breaking,
		trailers: release ? offered.map(unit => `Release: ${unit}`) : [],
	});
	const format = (breaking?: string | boolean, release = false) =>
		formatCommitMessage(draft(breaking, release), {
			emojiFormat: config.emojiFormat,
			capitalizeTitle: config.capitalizeTitle,
		});

	const move = (by: 1 | -1) => {
		if (step === 'breakingText') {
			setStep('breaking');
			return;
		}

		const next = steps[steps.indexOf(step) + by];
		if (next) setStep(next);
	};

	useInput((input, key) => {
		touched.current = true;
		if (key.ctrl && input === 'c') {
			checkToken.current++;
			onCancel();
			return;
		}

		if (checking) {
			if (key.return) return;
			checkToken.current++;
			setChecking(false);
		}

		if (key.escape) {
			move(-1);
			return;
		}

		if (step === 'gitmoji') {
			if (key.upArrow) {
				setSelected(index => Math.max(0, index - 1));
				return;
			}

			if (key.downArrow) {
				setSelected(index => Math.min(matches.length - 1, index + 1));
				return;
			}

			if (key.return) {
				const pick = matches[selected];
				if (pick) {
					setGitmoji(pick.code);
					move(1);
				}

				return;
			}
		}

		// Past the breaking question: ask about releasing, or submit.
		const finish = (breaking?: string | boolean) => {
			if (offered.length > 0) {
				setBreakingValue(breaking);
				setStep('release');
			} else {
				onSubmit(format(breaking));
			}
		};

		if (step === 'release') {
			if (input.toLowerCase() === 'y') {
				onSubmit(format(breakingValue, true));
			} else if (key.return || input.toLowerCase() === 'n') {
				onSubmit(format(breakingValue));
			}

			return;
		}

		if (step === 'breaking') {
			if (input.toLowerCase() === 'y') {
				setStep('breakingText');
			} else if (key.return || input.toLowerCase() === 'n') {
				finish();
			}

			return;
		}

		if (key.return) {
			if (step === 'breakingText') {
				finish(text.breakingText.trim() || true);
			} else if (step === 'why') {
				// Warn once about a thin Why, never block. Enter again moves on.
				const why = text.why.trim();
				if (why && warnedFor !== why) {
					const verdict = judgeWhy(
						{why: [why], constraint: [], gotcha: [], followUp: []},
						text.title,
					);
					if (verdict.level === 'thin') {
						setWarnedFor(why);
						setWhyAdvice(verdict.advice);
						return;
					}

					if (checkWhy) {
						const token = ++checkToken.current;
						setChecking(true);
						void askJev(checkWhy, why, text.title, checkWhyTimeoutMs).then(
							unclear => {
								if (token !== checkToken.current) return;
								setChecking(false);
								if (unclear) {
									setWarnedFor(why);
									setWhyAdvice(WHY_ADVICE['ai-unclear']);
								} else {
									move(1);
								}
							},
						);
						return;
					}
				}

				move(1);
			} else if (step !== 'title' || text.title.trim()) {
				move(1);
			}

			return;
		}

		if (key.tab && step === 'why' && whyDraft && text.why === '') {
			setText(all => ({...all, why: whyDraft.text}));
			return;
		}

		if (step === 'why') setWarnedFor(null);
		if (key.backspace || key.delete) {
			setText(all => ({...all, [step]: all[step].slice(0, -1)}));
			if (step === 'gitmoji') setSelected(0);
			return;
		}

		if (input && !key.ctrl && !key.meta && !key.tab) {
			setText(all => ({...all, [step]: all[step] + input}));
			if (step === 'gitmoji') setSelected(0);
		}
	});

	const first = Math.max(0, selected - LIST_SIZE + 1);
	const visible = matches.slice(first, first + LIST_SIZE);
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box gap={2}>
				<Text bold>chamoji commit</Text>
				<Text dimColor>Enter next · Esc back · Ctrl-C cancel</Text>
			</Box>
			{impact && (impact.own.length > 0 || impact.rides.length > 0) && (
				<Text dimColor>
					{[
						impact.own.length > 0
							? `releases with: ${names(impact.own).join(', ')}`
							: '',
						impact.rides.length > 0
							? `rides along to: ${names(impact.rides).join(', ')}`
							: '',
					]
						.filter(Boolean)
						.join(' · ')}
				</Text>
			)}
			{gitmoji && <Text color="cyan">{format().split('\n')[0] || ' '}</Text>}
			<Box marginTop={1}>
				<Text bold>
					{step === 'release'
						? `Release ${names(offered).join(', ')} now? (y/N)`
						: PROMPTS[step]}{' '}
					›{' '}
				</Text>
				{step !== 'breaking' && step !== 'release' && (
					<Text>
						{text[step]}
						<Text inverse> </Text>
						{step === 'why' && whyDraft && text.why === '' && (
							<Text dimColor>{whyDraft.text}</Text>
						)}
					</Text>
				)}
			</Box>
			{step === 'why' && whyDraft && text.why === '' && (
				<Text dimColor>Tab fills it from {whyDraft.source}.</Text>
			)}
			{step === 'why' && checking && <Text dimColor>Checking the reason…</Text>}
			{step === 'why' &&
				warnedFor !== null &&
				warnedFor === text.why.trim() && (
					<Text color="yellow">
						{whyAdvice} Enter again keeps it as written.
					</Text>
				)}
			{step === 'title' && hint(advice?.split) && (
				<Text color="yellow">
					Jev thinks these changes mix unrelated work; consider committing them
					separately.
				</Text>
			)}
			{(step === 'breaking' || step === 'breakingText') &&
				hint(advice?.breaking) && (
					<Text color="yellow">
						Jev thinks this may be breaking (
						{Math.round((advice?.breaking ?? 0) * 100)}%). It's your call; the
						default is still No.
					</Text>
				)}
			{step === 'gitmoji' && !confident && advised.length > 0 && (
				<Text color="magenta">
					Jev suggests{' '}
					{advised.map(item => `${item.emoji} ${item.code}`).join(' · ')}
				</Text>
			)}
			{step === 'gitmoji' &&
				(visible.length > 0 ? (
					visible.map((item, index) => {
						const active = first + index === selected;
						return (
							<Text key={item.code} color={active ? 'cyan' : undefined}>
								{active ? '❯ ' : '  '}
								{item.emoji} {item.code.padEnd(28)}
								<Text dimColor>{item.description}</Text>
								{suggestedCodes.has(item.code) && (
									<Text color="magenta"> suggested</Text>
								)}
							</Text>
						);
					})
				) : (
					<Text dimColor>No gitmoji matches “{text.gitmoji}”.</Text>
				))}
		</Box>
	);
}

export type ComposeStreams = {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
};

/**
 * Jev's verdict on a Why: true only when it says the reason is unclear. A
 * timeout or an error is false, since the check must never get in the way.
 */
async function askJev(
	check: (why: string, title: string) => Promise<boolean>,
	why: string,
	title: string,
	timeoutMs: number,
): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<boolean>(resolve => {
		timer = setTimeout(() => {
			resolve(false);
		}, timeoutMs);
	});
	try {
		return await Promise.race([check(why, title).catch(() => false), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Runs the composer on a terminal. Resolves with the message, or null when cancelled. */
export async function compose(
	config: ComposeConfig,
	streams: ComposeStreams,
	advice?: Promise<Advice | null>,
	impact?: Impact,
	checkWhy?: ComposerProps['checkWhy'],
	draft?: WhyDraft,
): Promise<string | null> {
	return new Promise(resolve => {
		let done = false;
		const finish = (message: string | null) => {
			if (done) return;
			done = true;
			app.unmount();
			resolve(message);
		};

		const app = render(
			<Composer
				config={config}
				onSubmit={message => finish(message)}
				onCancel={() => finish(null)}
				advice={advice}
				impact={impact}
				checkWhy={checkWhy}
				draft={draft}
			/>,
			{
				stdin: streams.stdin,
				stdout: streams.stdout,
				exitOnCtrlC: false,
				patchConsole: false,
			},
		);
	});
}
