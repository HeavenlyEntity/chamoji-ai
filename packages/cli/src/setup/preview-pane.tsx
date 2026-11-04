import type {Preview, PreviewUnit} from '@chamoji/core';
import {Box, Text} from 'ink';
import {stripControlLines} from '../text.js';

/** Something the screen asked for: still running, or its value, or why it failed. */
export type Loaded<T> =
	| {running: true}
	| {running: false; value: T}
	| {running: false; error: string};

const clean = stripControlLines;

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** "waits: 3 shared changes ride along", for a unit with nothing to release. */
function waits({own, shared}: {own: number; shared: number}): string {
	const parts = [
		...(own === 0
			? []
			: [
					`${plural(own, 'change of its own needs', 'changes of its own need')} no release`,
				]),
		...(shared === 0
			? []
			: [
					`${plural(shared, 'shared change rides', 'shared changes ride')} along`,
				]),
	];
	return `waits: ${parts.length > 0 ? parts.join('; ') : 'nothing to release yet'}`;
}

function UnitLines({unit}: {unit: PreviewUnit}) {
	if (unit.status === 'waits') {
		return (
			<Box flexDirection="column" marginTop={1}>
				<Text bold>{clean(unit.unit)}</Text>
				<Text dimColor>
					{'  '}
					{waits(unit)}
				</Text>
			</Box>
		);
	}

	// `web 0.1.0 → 0.2.0 (minor) web/v0.2.0`, with none for a unit that has no
	// version yet, as release --dry-run says it.
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text>
				<Text bold>{clean(unit.unit)}</Text>{' '}
				{clean(
					`${unit.from ?? 'none'} → ${unit.version} (${unit.bump}) ${unit.tag}`,
				)}
			</Text>
			{unit.notes.map((note, index) => (
				<Text key={index} dimColor wrap="truncate-end">
					{'  '}
					{clean(note)}
				</Text>
			))}
		</Box>
	);
}

/** The next release under the current answers, or … while it's worked out. */
export function PreviewPane({loaded}: {loaded: Loaded<Preview>}) {
	if (loaded.running) return <Text dimColor>…</Text>;
	if ('error' in loaded) {
		return (
			<Text color="yellow">The preview failed: {clean(loaded.error)}</Text>
		);
	}

	const {heading, units, warnings} = loaded.value;
	return (
		<Box flexDirection="column">
			<Text bold>{clean(heading)}</Text>
			{units.length === 0 && warnings.length === 0 && (
				<Text dimColor>Nothing would release yet.</Text>
			)}
			{units.map(unit => (
				<UnitLines key={unit.unit} unit={unit} />
			))}
			{warnings.map((warning, index) => (
				<Text key={index} color="yellow">
					{clean(warning)}
				</Text>
			))}
		</Box>
	);
}
