import {Box, Text} from 'ink';
import {FRAMEWORK_ICONS, ICON_COLUMNS} from '../framework-icons.js';
import {stripControlLines} from '../text.js';
import {colorsFor, nameOf, type FrameworkRow} from './frameworks.js';

/** Below this width the summary draws a ● and the name, not the large icon. */
export const MIN_ICON_WIDTH = 60;
/** The text column beside an icon, and the gap before it and between icons. */
const TEXT_COLUMNS = 26;
const GAP = 2;

/** Repo text (unit names) never reaches the terminal raw. */
const clean = stripControlLines;

/**
 * Each framework's icon in its brand colour beside its name, version and
 * units, side by side and wrapping to the width. Below MIN_ICON_WIDTH, a ●
 * and the name. `level` 0 (NO_COLOR) draws the icons in the default colour.
 */
export function FrameworkSummary({
	frameworks,
	width,
	level,
}: {
	frameworks: FrameworkRow[];
	width: number;
	level: 0 | 1 | 2 | 3;
}) {
	if (frameworks.length === 0) return <Text />;
	const paint = (color?: string) => (level === 0 ? undefined : color);
	const small = width < MIN_ICON_WIDTH;
	return (
		<Box
			flexDirection={small ? 'column' : 'row'}
			flexWrap="wrap"
			columnGap={GAP}
			rowGap={1}
			width={width}
		>
			{frameworks.map(({framework, units}) => {
				const icon = FRAMEWORK_ICONS[framework.id];
				const colors = colorsFor(framework.id);
				const label = clean(nameOf(framework));
				const where = clean(units.join(', '));
				if (small || !icon) {
					return (
						<Text key={`${framework.id}${framework.version}`}>
							<Text color={paint(colors.icon)}>●</Text>{' '}
							<Text bold color={paint(colors.name)}>
								{label}
							</Text>{' '}
							<Text dimColor>{where}</Text>
						</Text>
					);
				}

				return (
					<Box key={`${framework.id}${framework.version}`} columnGap={GAP}>
						<Box flexDirection="column" width={ICON_COLUMNS}>
							{icon.large.map((row, index) => (
								<Text key={index} color={paint(colors.icon)}>
									{row}
								</Text>
							))}
						</Box>
						<Box flexDirection="column" width={TEXT_COLUMNS}>
							<Text bold color={paint(colors.name)}>
								{label}
							</Text>
							<Text dimColor>{where}</Text>
						</Box>
					</Box>
				);
			})}
		</Box>
	);
}
