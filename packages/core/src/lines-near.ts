import {clean} from './brief.js';
import {lineOrder, type CardLine, type CardState} from './card-state.js';

/** How much of a line's text the nudge quotes. */
const MAX_NUDGE_TEXT = 120;

/**
 * Open and in-doubt lines whose files overlap `files`, newest first, at most
 * `limit`. Paths are compared whole, as `readCardState` and
 * `readCommitFiles` list them from the top of the work tree.
 */
export function linesNear(
	state: CardState,
	files: string[],
	limit = 5,
): CardLine[] {
	if (limit < 1) return [];
	const changed = new Set(files);
	return state.lines
		.filter(
			line =>
				(line.state === 'open' || line.state === 'in-doubt') &&
				line.files.some(file => changed.has(file)),
		)
		.sort(lineOrder)
		.slice(0, limit);
}

/**
 * What an agent is told after a commit near `lines`: one paragraph per line,
 * joined by a blank line. The id and text are card text, so they are cleaned
 * to one line, and the text is cut.
 */
export function nudgeText(lines: CardLine[]): string {
	return lines
		.map(line => {
			const id = clean(line.id);
			return `This commit touched code under ${id} "${clean(line.text, MAX_NUDGE_TEXT)}". If it ended that, run chamoji memory resolve ${id} --because "<reason>".`;
		})
		.join('\n\n');
}
