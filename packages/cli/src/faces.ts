export type FaceName =
	| 'rest'
	| 'left'
	| 'right'
	| 'blink'
	| 'wink'
	| 'done'
	| 'warn'
	| 'fail';

/** The one-line faces. Every frame is 7 columns wide. */
export const FACES: Record<FaceName, string> = {
	rest: '( •‿• )',
	left: '(•‿•  )',
	right: '(  •‿•)',
	blink: '( -‿- )',
	wink: '( •‿- )',
	done: '( ■‿■ )',
	warn: '( •_• )',
	fail: '( ;_; )',
};

/** The same faces in plain ASCII, for terminals that cannot draw the set above. */
export const ASCII_FACES: Record<FaceName, string> = {
	rest: '( o_o )',
	left: '(o_o  )',
	right: '(  o_o)',
	blink: '( -_- )',
	wink: '( o_- )',
	done: '( ^_^ )',
	warn: '( o_O )',
	fail: '( ;_; )',
};

/** The idle expression, in order. The face helper repeats it. */
export const IDLE_LOOP: readonly FaceName[] = [
	'rest',
	'rest',
	'left',
	'rest',
	'right',
	'rest',
	'blink',
	'rest',
	'wink',
];

/**
 * Whether to draw the ASCII faces: when CHAMOJI_ASCII=1, or on win32 without
 * WT_SESSION, since only Windows Terminal is trusted to draw the Unicode set.
 */
export function useAscii(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): boolean {
	if (env['CHAMOJI_ASCII'] === '1') {
		return true;
	}

	return platform === 'win32' && !env['WT_SESSION'];
}
