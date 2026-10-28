import {
	formatCommitMessage,
	getGitmoji,
	searchGitmojis,
	type ComposeConfig,
	type CommitDraft,
	type GitmojiInfo,
} from '@chamoji/core';
import {Box, render, Text, useInput} from 'ink';
import {useEffect, useRef, useState} from 'react';
import {HINT_THRESHOLD, PRESELECT_THRESHOLD, type Advice} from './advisor.js';

type Step =
	'gitmoji' | 'scope' | 'title' | 'body' | 'why' | 'breaking' | 'breakingText';

const PROMPTS: Record<Step, string> = {
	gitmoji: 'Gitmoji',
	scope: 'Scope (optional)',
	title: 'Title',
	body: 'Body (optional)',
	why: 'Why? (optional, kept as a Why: trailer)',
	breaking: 'Breaking change? (y/N)',
	breakingText: 'What breaks?',
};

const LIST_SIZE = 7;

/** How long the composer waits for Jev's advice before carrying on without it. */
const ADVICE_TIMEOUT_MS = 2000;

export type ComposerProps = {
	config: ComposeConfig;
	onSubmit: (message: string) => void;
	onCancel: () => void;
	/** Jev's advice, when AI is on. The composer never waits for it. */
	advice?: Promise<Advice | null>;
	adviceTimeoutMs?: number;
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
}: ComposerProps) {
	const steps: Step[] = [
		'gitmoji',
		...(config.scopePrompt ? (['scope'] as const) : []),
		'title',
		...(config.messagePrompt ? (['body'] as const) : []),
		'why',
		'breaking',
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
	});
	const [selected, setSelected] = useState(0);
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
	const draft = (breaking?: string | boolean): CommitDraft => ({
		gitmoji: gitmoji ?? 'sparkles',
		scope: text.scope,
		title: text.title,
		body: text.body,
		why: text.why,
		breaking,
	});
	const format = (breaking?: string | boolean) =>
		formatCommitMessage(draft(breaking), {
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
			onCancel();
			return;
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

		if (step === 'breaking') {
			if (input.toLowerCase() === 'y') {
				setStep('breakingText');
			} else if (key.return || input.toLowerCase() === 'n') {
				onSubmit(format());
			}

			return;
		}

		if (key.return) {
			if (step === 'breakingText') {
				onSubmit(format(text.breakingText.trim() || true));
			} else if (step !== 'title' || text.title.trim()) {
				move(1);
			}

			return;
		}

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
			{gitmoji && <Text color="cyan">{format().split('\n')[0] || ' '}</Text>}
			<Box marginTop={1}>
				<Text bold>{PROMPTS[step]} › </Text>
				{step !== 'breaking' && (
					<Text>
						{text[step]}
						<Text inverse> </Text>
					</Text>
				)}
			</Box>
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

/** Runs the composer on a terminal. Resolves with the message, or null when cancelled. */
export async function compose(
	config: ComposeConfig,
	streams: ComposeStreams,
	advice?: Promise<Advice | null>,
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
