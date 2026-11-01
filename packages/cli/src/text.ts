/** Text from a file or commit a clone can write must not carry control characters to a terminal. */
export function stripControl(text: string): string {
	return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}
