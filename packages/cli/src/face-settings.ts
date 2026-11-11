/**
 * Whether the loading face may animate at all. It doesn't when stderr isn't a
 * terminal, in CI, on a dumb terminal, with `--json` anywhere in argv, or with
 * CHAMOJI_NO_ANIMATION=1. Output is then exactly what it was before faces.
 * NO_COLOR only takes the colour away; the face still moves.
 */
export function shouldAnimate(options: Parameters<typeof shouldDrawIcons>[0]) {
	return (
		shouldDrawIcons(options) && options.env['CHAMOJI_NO_ANIMATION'] !== '1'
	);
}

/**
 * Whether a command can wait on git, GitHub or Jev, and so shows a face.
 * `input` is the command and its arguments, as meow parsed them.
 *
 * Never a face: `mcp` and `agent-hook`, whose stdout is a protocol; `hook`
 * and `commit`, which open the composer; and `card`, which only computes.
 */
export function hasFace(
	input: readonly string[],
	flags: {ai?: boolean; help?: boolean; version?: boolean},
): boolean {
	if (flags.help || flags.version) return false;
	const [command, subcommand] = input;
	switch (command) {
		case 'release':
		case 'init':
		case 'why': {
			return true;
		}

		case 'changelog':
		case 'next-version': {
			return flags.ai ?? false;
		}

		case 'memory': {
			return (
				subcommand === 'sync' ||
				subcommand === 'reindex' ||
				(subcommand === 'search' && (flags.ai ?? false))
			);
		}

		case 'ws': {
			return subcommand === 'ship' || subcommand === 'drop';
		}

		default: {
			return false;
		}
	}
}

/**
 * Whether setup may draw framework icons: the same rules as `shouldAnimate`
 * without CHAMOJI_NO_ANIMATION, since an icon doesn't move. NO_COLOR still
 * draws them, in the default colour. Otherwise setup prints the frameworks as
 * plain text.
 */
export function shouldDrawIcons({
	env,
	stderrIsTTY,
	argv,
}: {
	env: Record<string, string | undefined>;
	stderrIsTTY: boolean;
	argv: readonly string[];
}): boolean {
	if (!stderrIsTTY) return false;
	if (env['CI']) return false;
	if (env['TERM'] === 'dumb') return false;
	return !argv.some(arg => arg === '--json' || arg.startsWith('--json='));
}
