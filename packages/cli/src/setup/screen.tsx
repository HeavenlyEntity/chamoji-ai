import {
	applyAnswer,
	questions,
	summary,
	type Preview,
	type ReplayLine,
} from '@chamoji/core';
import {Box, render, Text, useInput} from 'ink';
import {useEffect, useRef, useState} from 'react';
import type {ComposeStreams} from '../composer.js';
import {shouldAnimate, shouldDrawIcons} from '../face-settings.js';
import {ASCII_FACES, FACES, IDLE_LOOP, useAscii} from '../faces.js';
import {detectTheme, paintFoil, queryBackground, type Rgb} from '../foil.js';
import {stripControlLines} from '../text.js';
import type {Terminal} from '../tty.js';
import {colorsFor, frameworksOf} from './frameworks-view.js';
import {PreviewPane, type Loaded} from './preview-pane.js';
import {
	Answer,
	Picker,
	Summary,
	viewFor,
	type AnswerView,
} from './question-views.js';
import type {
	ScreenResult,
	SetupScreen as Screen,
	SetupScreenProps,
} from './setup.js';
import {asksReleases, stepPrompts, type StepName} from './steps.js';

export type {ScreenResult} from './setup.js';

/**
 * How the screen looks. The face wears the foil and looks around only when
 * `animate` is on, which cli.ts decides under the terminal-face rules; `level`
 * is chalk's, already 0 where the foil isn't drawn (a light background).
 * `icons` is on where `shouldDrawIcons` says so: the summary then draws each
 * framework's icon, and elsewhere setup says the frameworks in words.
 */
export type ScreenLook = {
	animate: boolean;
	level: 0 | 1 | 2 | 3;
	ascii: boolean;
	icons: boolean;
};

const PLAIN: ScreenLook = {
	animate: false,
	level: 0,
	ascii: false,
	icons: false,
};

/** Two columns from this width; narrower, the preview goes under the questions. */
const WIDE = 100;
/** The preview re-runs this long after the last change. */
const PREVIEW_DELAY_MS = 300;
/** How often the face changes expression while the preview runs. */
const FACE_MS = 700;
const FOIL_SPREAD = 30;

const PROMPTS: Record<Exclude<StepName, 'releases'>, string> = {
	memory: 'Share memory through origin?',
	agents: 'Connect Claude Code here?',
	hook: 'Install the commit composer hook?',
};
/** The hook is offered, never assumed (ruling R17); the others default to yes. */
const DEFAULT_YES = (step: StepName) => step !== 'hook';

/** Repo text (names, paths, tags, notes) never reaches the terminal raw. */
const clean = stripControlLines;

type Phase = 'summary' | 'change' | 'answer' | 'prompts' | 'closed';

export type SetupScreenComponentProps = SetupScreenProps & {
	onDone: (result: ScreenResult) => void;
	look?: ScreenLook;
};

/**
 * `chamoji setup`'s screen: the summary, one Enter to save, `c` to change
 * something, a live preview and the replay, then the per-clone step prompts.
 */
export function SetupScreen({
	detection,
	initial,
	states,
	preview,
	replay,
	columns,
	onDone,
	look = PLAIN,
}: SetupScreenComponentProps) {
	const asking = asksReleases(detection, states);
	const prompts = stepPrompts(states);
	const [answers, setAnswers] = useState(initial);
	const [phase, setPhase] = useState<Phase>(asking ? 'summary' : 'prompts');
	const [cursor, setCursor] = useState(0);
	const [view, setView] = useState<AnswerView | null>(null);
	const [prompt, setPrompt] = useState(0);
	const [picked, setPicked] = useState<StepName[]>([]);
	const [result, setResult] = useState<ScreenResult | null>(null);
	const [shown, setShown] = useState<Loaded<Preview>>({running: true});
	const [replayed, setReplayed] = useState<Loaded<ReplayLine[]>>({
		running: true,
	});
	const [beat, setBeat] = useState(0);
	const started = useRef(false);

	// The preview and replay for the newest answers: at once on opening, then
	// PREVIEW_DELAY_MS after the last change. A run whose answers have since
	// changed is dropped, however late it lands.
	useEffect(() => {
		if (!asking) return;
		let live = true;
		setShown({running: true});
		setReplayed({running: true});
		const run = () => {
			const settle =
				<T,>(set: (loaded: Loaded<T>) => void) =>
				(loaded: Loaded<T>) => {
					if (live) set(loaded);
				};

			load(() => preview(answers), settle(setShown));
			load(() => replay(answers), settle(setReplayed));
		};

		let timer: NodeJS.Timeout | undefined;
		if (started.current) {
			timer = setTimeout(run, PREVIEW_DELAY_MS);
		} else {
			started.current = true;
			run();
		}

		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [answers]);

	const moving = look.animate && asking && shown.running && phase !== 'prompts';
	useEffect(() => {
		if (!moving) return;
		const timer = setInterval(() => setBeat(beat => beat + 1), FACE_MS);
		return () => clearInterval(timer);
	}, [moving]);

	// The last frame is empty, so the screen leaves nothing behind; then it's done.
	useEffect(() => {
		if (result) onDone(result);
	}, [result]);

	const finish = (done: ScreenResult) => {
		if (phase === 'closed') return;
		setPhase('closed');
		setResult(done);
	};

	const all = questions(detection, answers);
	const save = () => {
		if (prompts.length > 0) {
			setPrompt(0);
			setPicked([]);
			setPhase('prompts');
		} else {
			finish({saved: true, answers, steps: []});
		}
	};

	const answer = (value: string | string[]) => {
		if (!view) return;
		try {
			const next = applyAnswer(detection, answers, view.question.id, value);
			const index = questions(detection, next).findIndex(
				question => question.id === view.question.id,
			);
			setAnswers(next);
			if (index !== -1) setCursor(index);
			setView(null);
			setPhase('change');
		} catch (error) {
			setView({...view, error: (error as Error).message});
		}
	};

	const decide = (yes: boolean) => {
		const step = prompts[prompt]!.step;
		const chosen = yes ? [...picked, step] : picked;
		if (prompt + 1 < prompts.length) {
			setPicked(chosen);
			setPrompt(prompt + 1);
		} else {
			finish({saved: true, answers, steps: chosen});
		}
	};

	useInput((input, key) => {
		if (phase === 'closed') return;
		if (key.ctrl && input === 'c') {
			finish({saved: false});
			return;
		}

		// Ink reads a newline (an Enter pressed before raw mode) as 'enter',
		// not 'return'.
		const enter = key.return || input === '\n';

		switch (phase) {
			case 'summary': {
				if (enter) save();
				else if (key.escape) finish({saved: false});
				else if (input === 'c') {
					setCursor(index => Math.min(index, all.length - 1));
					setPhase('change');
				}

				return;
			}

			case 'change': {
				if (key.escape) setPhase('summary');
				else if (key.upArrow) setCursor(index => Math.max(0, index - 1));
				else if (key.downArrow) {
					setCursor(index => Math.min(all.length - 1, index + 1));
				} else if (enter && all[cursor]) {
					setView(viewFor(all[cursor], answers));
					setPhase('answer');
				}

				return;
			}

			case 'answer': {
				if (view) onAnswerKey(view, input, key, enter);
				return;
			}

			case 'prompts': {
				if (key.escape) {
					if (prompt > 0) {
						setPicked(chosen =>
							chosen.filter(step => step !== prompts[prompt - 1]!.step),
						);
						setPrompt(prompt - 1);
					} else if (asking) {
						setPhase('summary');
					} else {
						finish({saved: false});
					}
				} else if (input.toLowerCase() === 'y') decide(true);
				else if (input.toLowerCase() === 'n') decide(false);
				else if (enter) decide(DEFAULT_YES(prompts[prompt]!.step));
			}
		}
	});

	function onAnswerKey(
		current: AnswerView,
		input: string,
		key: Parameters<Parameters<typeof useInput>[0]>[1],
		enter: boolean,
	): void {
		const {question} = current;
		const rows = question.options.length + (question.kind === 'text' ? 1 : 0);
		if (key.escape) {
			setView(null);
			setPhase('change');
		} else if (key.upArrow) {
			setView({...current, row: Math.max(0, current.row - 1)});
		} else if (key.downArrow) {
			setView({...current, row: Math.min(rows - 1, current.row + 1)});
		} else if (enter) {
			if (question.kind === 'ticks') answer(current.ticked);
			else if (current.row < question.options.length) {
				answer(question.options[current.row]!.value);
			} else answer(current.typed);
		} else if (question.kind === 'ticks' && input === ' ') {
			const value = question.options[current.row]?.value;
			if (value === undefined) return;
			setView({
				...current,
				error: null,
				ticked: current.ticked.includes(value)
					? current.ticked.filter(each => each !== value)
					: [...current.ticked, value],
			});
		} else if (question.kind === 'text') {
			// An edit answers the error, so the message goes with it.
			const edited = {...current, row: question.options.length, error: null};
			if (key.backspace || key.delete) {
				setView({...edited, typed: current.typed.slice(0, -1)});
			} else if (
				input &&
				!input.includes('\n') &&
				!key.ctrl &&
				!key.meta &&
				!key.tab
			) {
				setView({...edited, typed: current.typed + input});
			}
		}
	}

	if (phase === 'closed') return <Text />;

	const faces = look.ascii ? ASCII_FACES : FACES;
	const face = faces[moving ? IDLE_LOOP[beat % IDLE_LOOP.length]! : 'rest'];
	const title = `${face} chamoji setup`;
	const header = (
		<Text bold>
			{look.animate
				? paintFoil(title, {offset: 0, spread: FOIL_SPREAD, level: look.level})
				: title}
		</Text>
	);

	if (phase === 'prompts') {
		return (
			<Box flexDirection="column" paddingX={1} width={columns}>
				{header}
				{prompts.slice(0, prompt + 1).map((state, index) => (
					<Box key={state.step} flexDirection="column" marginTop={1}>
						<Text dimColor>{clean(state.line)}</Text>
						<Text>
							<Text bold>{PROMPTS[state.step as keyof typeof PROMPTS]}</Text>{' '}
							{DEFAULT_YES(state.step) ? '(Y/n)' : '(y/N)'}
							{index < prompt && (picked.includes(state.step) ? ' yes' : ' no')}
						</Text>
					</Box>
				))}
				<Box marginTop={1}>
					<Text dimColor>y yes · n no · Enter the default · Esc back</Text>
				</Box>
			</Box>
		);
	}

	const wide = columns >= WIDE;
	const left = wide ? Math.floor(columns * 0.55) : columns - 2;
	const right = wide ? columns - left - 4 : columns - 2;
	const frameworks = look.icons ? frameworksOf(detection.layout) : [];
	// Where the model asks which units get versions, a ● in each one's colour.
	const marks = look.icons
		? Object.fromEntries(
				detection.layout.candidates
					.filter(facts => facts.framework)
					.map(facts => [
						facts.path,
						look.level === 0 ? undefined : colorsFor(facts.framework!.id).icon,
					]),
			)
		: undefined;
	const body =
		phase === 'summary' ? (
			<Summary
				frameworks={frameworks}
				width={left}
				level={look.level}
				text={clean(summary(detection, answers))}
				replayed={replayed}
				asked={all.filter(question => question.needsAnswer)}
				answers={answers}
			/>
		) : phase === 'change' ? (
			<Picker all={all} cursor={cursor} />
		) : (
			view && <Answer view={view} marks={marks} />
		);
	const hint =
		phase === 'summary'
			? 'Enter save · c change something · Esc cancel'
			: phase === 'change'
				? '↑↓ move · Enter pick · Esc back'
				: view?.question.kind === 'ticks'
					? '↑↓ move · Space tick · Enter save · Esc back'
					: view?.question.kind === 'text'
						? '↑↓ move · type another · Enter pick · Esc back'
						: '↑↓ move · Enter pick · Esc back';
	return (
		<Box flexDirection="column" paddingX={1} width={columns}>
			{header}
			<Box flexDirection={wide ? 'row' : 'column'} gap={wide ? 2 : 0}>
				<Box flexDirection="column" width={left}>
					{body}
					<Box marginTop={1}>
						<Text dimColor>{hint}</Text>
					</Box>
				</Box>
				<Box flexDirection="column" width={right} marginTop={1}>
					<PreviewPane loaded={shown} />
				</Box>
			</Box>
		</Box>
	);
}

/** Runs `get`, reporting it as running, then its result or its error's message. */
function load<T>(get: () => Promise<T>, set: (loaded: Loaded<T>) => void) {
	// A get that throws at once reports like one that rejects.
	void Promise.resolve()
		.then(get)
		.then(
			value => set({running: false, value}),
			(error: unknown) =>
				set({
					running: false,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
}

/**
 * Mounts the screen on `streams` (stdin, and stderr as Ink's output) and
 * resolves with what it hands back.
 */
export async function runSetupScreen(
	props: SetupScreenProps,
	streams: ComposeStreams,
	look?: ScreenLook,
): Promise<ScreenResult> {
	// Preview and replay runs read git. One still running when the screen
	// closes, as after an early Enter, must finish before setup goes on, or
	// git keeps working (and holding the repo's files) after setup has saved.
	const running = new Set<Promise<unknown>>();
	const tracked =
		<A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
		(...args: A): Promise<T> => {
			const promise = run(...args);
			running.add(promise);
			const done = () => running.delete(promise);
			promise.then(done, done);
			return promise;
		};

	return new Promise(resolve => {
		const app = render(
			<SetupScreen
				{...props}
				preview={tracked(props.preview)}
				replay={tracked(props.replay)}
				look={look}
				onDone={result => {
					app.unmount();
					void Promise.allSettled([...running]).then(() => resolve(result));
				}}
			/>,
			{
				stdin: streams.stdin,
				stdout: streams.stdout,
				exitOnCtrlC: false,
				patchConsole: false,
				// Setup opens the screen only on a terminal, so it draws as one,
				// frame by frame, wherever Ink would guess otherwise.
				interactive: streams.stdout.isTTY === true,
			},
		);
	});
}

export type TerminalScreenOptions = {
	env: Record<string, string | undefined>;
	argv: readonly string[];
	/** Where the screen draws. */
	stderr: NodeJS.WriteStream;
	/** stderr's chalk level. */
	level: 0 | 1 | 2 | 3;
	platform: NodeJS.Platform;
	openTerminal: () => Terminal | null;
	/** Asks the terminal for its background; tests pass a fake. */
	ask?: (
		stdin: NodeJS.ReadStream,
		stderr: NodeJS.WriteStream,
	) => Promise<Rgb | undefined>;
};

/**
 * The OSC 11 query, resolved only once stdin is back as it was (the reply
 * came, or its grace window passed), so a late reply never reaches Ink.
 */
async function askSettled(
	stdin: NodeJS.ReadStream,
	stderr: NodeJS.WriteStream,
): Promise<Rgb | undefined> {
	let settled = () => {};
	const back = new Promise<void>(resolve => {
		settled = resolve;
	});
	const answer = await queryBackground(stdin, stderr, undefined, undefined, {
		onSettled: settled,
	});
	await back;
	return answer;
}

/**
 * The screen on the real terminal: it reads the terminal (a git hook's stdin
 * isn't it) and draws on stderr. It moves and wears the foil only where a
 * face could. The theme follows BRAND.md: CHAMOJI_THEME, then the terminal's
 * own answer, asked before Ink reads the terminal as the intro asks before
 * it plays, then COLORFGBG, then dark. Light means no foil.
 */
export function terminalSetupScreen({
	env,
	argv,
	stderr,
	level,
	platform,
	openTerminal,
	ask = askSettled,
}: TerminalScreenOptions): Screen {
	return async props => {
		const terminal = openTerminal();
		if (!terminal) {
			throw new Error(
				'setup needs a terminal to ask on; run chamoji setup --yes to take every recommended answer',
			);
		}

		try {
			const animate = shouldAnimate({
				env,
				stderrIsTTY: Boolean(stderr.isTTY),
				argv,
			});
			const theme = animate
				? await detectTheme(env, async () =>
						terminal.stdin.isTTY ? ask(terminal.stdin, stderr) : undefined,
					)
				: 'light';
			return await runSetupScreen(
				props,
				{stdin: terminal.stdin, stdout: stderr},
				{
					animate,
					level: theme === 'dark' ? level : 0,
					ascii: useAscii(env, platform),
					icons: shouldDrawIcons({
						env,
						stderrIsTTY: Boolean(stderr.isTTY),
						argv,
					}),
				},
			);
		} finally {
			terminal.close();
		}
	};
}
