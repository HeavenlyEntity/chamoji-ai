import {
	currentAnswer,
	replayText,
	type Question,
	type ReplayLine,
	type SetupAnswers,
} from '@chamoji/core';
import {Box, Text} from 'ink';
import {stripControlLines} from '../text.js';
import {FrameworkSummary, type FrameworkRow} from './frameworks-view.js';
import type {Loaded} from './preview-pane.js';

/** Repo text (names, paths, tags, notes) never reaches the terminal raw. */
const clean = stripControlLines;

/** Questions shown at once under "Change something". */
const PICKER_SIZE = 6;

export type AnswerView = {
	question: Question;
	/** The highlighted row: an option, or for text the row after them, typed. */
	row: number;
	ticked: string[];
	typed: string;
	error: string | null;
};

/** The label of an answer as the screen shows it, with "(recommended)" when it is. */
function answerLabel(question: Question, value: string | string[]): string {
	if (Array.isArray(value)) {
		const labels = question.options
			.filter(option => value.includes(option.value))
			.map(option => option.label);
		return labels.length > 0 ? labels.join(', ') : 'none';
	}

	const option = question.options.find(each => each.value === value);
	if (!option) return value === '' ? 'none' : value;
	return option.recommended ? `${option.label} (recommended)` : option.label;
}

/** The answer view for `question`, starting on its current answer. */
export function viewFor(question: Question, answers: SetupAnswers): AnswerView {
	const value = currentAnswer(answers, question.id);
	const ticked = Array.isArray(value) ? value : [];
	const index = question.options.findIndex(option => option.value === value);
	const typedRow = question.kind === 'text' && index === -1;
	return {
		question,
		row: typedRow ? question.options.length : Math.max(0, index),
		ticked,
		typed: typedRow && typeof value === 'string' ? value : '',
		error: null,
	};
}

/**
 * Text that wraps between words. Ink's own wrap starts a wrapped line with the
 * space it broke at; here each line starts flush.
 */
function Words({
	text,
	bold,
	dimColor,
	color,
}: {
	text: string;
	bold?: boolean;
	dimColor?: boolean;
	color?: string;
}) {
	return (
		<Box flexWrap="wrap">
			{text.split(' ').map((word, index) => (
				<Text key={index} bold={bold} dimColor={dimColor} color={color}>
					{word}{' '}
				</Text>
			))}
		</Box>
	);
}

function QuestionHead({question}: {question: Question}) {
	return (
		<>
			<Words bold text={clean(question.title)} />
			<Words dimColor text={clean(question.found)} />
		</>
	);
}

/** The first screen: what setup found, the replay and the questions that need an answer. */
export function Summary({
	frameworks,
	width,
	level,
	text,
	replayed,
	asked,
	answers,
}: {
	frameworks: FrameworkRow[];
	width: number;
	level: 0 | 1 | 2 | 3;
	text: string;
	replayed: Loaded<ReplayLine[]>;
	asked: Question[];
	answers: SetupAnswers;
}) {
	return (
		<Box flexDirection="column" marginTop={1}>
			{frameworks.length > 0 && (
				<Box marginBottom={1}>
					<FrameworkSummary
						frameworks={frameworks}
						width={width}
						level={level}
					/>
				</Box>
			)}
			<Words text={text} />
			<Box flexDirection="column" marginTop={1}>
				<Text bold>Past releases under these answers</Text>
				{replayed.running ? (
					<Text dimColor>…</Text>
				) : 'error' in replayed ? (
					<Text color="yellow">The replay failed: {clean(replayed.error)}</Text>
				) : replayed.value.length === 0 ? (
					<Text dimColor>No past releases of your own yet</Text>
				) : (
					replayed.value.map((line, index) => (
						<Text key={index}>{clean(replayText(line))}</Text>
					))
				)}
			</Box>
			{asked.map(question => (
				<Box key={question.id} flexDirection="column" marginTop={1}>
					<QuestionHead question={question} />
					<Text color="cyan">
						›{' '}
						{clean(answerLabel(question, currentAnswer(answers, question.id)))}
					</Text>
				</Box>
			))}
		</Box>
	);
}

/** "Change something": every question, with what chamoji found under its title. */
export function Picker({all, cursor}: {all: Question[]; cursor: number}) {
	const first = Math.max(
		0,
		Math.min(cursor - Math.floor(PICKER_SIZE / 2), all.length - PICKER_SIZE),
	);
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>Change something</Text>
			{all.slice(first, first + PICKER_SIZE).map((question, index) => {
				const active = first + index === cursor;
				return (
					<Box key={question.id} flexDirection="column" marginTop={1}>
						<Text color={active ? 'cyan' : undefined} bold={active}>
							{active ? '❯ ' : '  '}
							{clean(question.title)}
						</Text>
						<Box paddingLeft={2}>
							<Words dimColor text={clean(question.found)} />
						</Box>
					</Box>
				);
			})}
		</Box>
	);
}

/** One question's answers: pick one, tick several, or for text type another. */
export function Answer({
	view,
	marks,
}: {
	view: AnswerView;
	/** A ● before an option, in this colour (or the default); keyed by option value. */
	marks?: Record<string, string | undefined>;
}) {
	const {question, row, ticked, typed, error} = view;
	return (
		<Box flexDirection="column" marginTop={1}>
			<QuestionHead question={question} />
			<Box flexDirection="column" marginTop={1}>
				{question.options.map((option, index) => {
					const active = index === row;
					const box =
						question.kind === 'ticks'
							? ticked.includes(option.value)
								? '[x] '
								: '[ ] '
							: '';
					return (
						<Text key={option.value} color={active ? 'cyan' : undefined}>
							{active ? '❯ ' : '  '}
							{box}
							{marks && option.value in marks && (
								<Text color={marks[option.value]}>● </Text>
							)}
							{clean(option.label)}
							{option.recommended && <Text dimColor> (recommended)</Text>}
						</Text>
					);
				})}
				{question.kind === 'text' && (
					<Text color={row === question.options.length ? 'cyan' : undefined}>
						{row === question.options.length ? '❯ ' : '  '}
						Other: {clean(typed)}
						<Text inverse> </Text>
					</Text>
				)}
			</Box>
			{error && <Words color="red" text={clean(error)} />}
		</Box>
	);
}
