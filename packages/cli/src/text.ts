const char = (code: number) => String.fromCharCode(code);
const span = (from: number, to: number) => `${char(from)}-${char(to)}`;

/**
 * Controls, and the characters that change how text is laid out: the line and
 * paragraph separators, and the bidirectional overrides and isolates, which
 * reorder what follows so that a name or path reads as another. Built from
 * code points so that no invisible character sits in this source.
 */
const HIDDEN = new RegExp(
	`[\\u0000-\\u001F\\u007F-\\u009F${span(0x20_28, 0x20_29)}${span(0x20_2a, 0x20_2e)}${span(0x20_66, 0x20_69)}]`,
	'g',
);

/**
 * Text from a file or commit a clone can write must not carry control
 * characters to a terminal. Newlines go as well, as they always did;
 * `stripControlLines` splits on them first.
 */
export function stripControl(text: string): string {
	return text.replace(HIDDEN, '');
}

/** `stripControl` for text of several lines, such as what a remote says through git. */
export function stripControlLines(text: string): string {
	return text.split('\n').map(stripControl).join('\n');
}
