import type {DetectedFramework, LayoutDetection} from '@chamoji/core';
import {Box, Text} from 'ink';
import {FRAMEWORK_ICONS, ICON_COLUMNS} from '../framework-icons.js';
import {stripControlLines} from '../text.js';

/** Below this width the summary draws a ● and the name, not the large icon. */
export const MIN_ICON_WIDTH = 60;
/** The brand colour a Phosphor stand-in carries; the name stays uncoloured. */
const FALLBACK_HEX = '#8a8a8a';
/** The text column beside an icon, and the gap before it and between icons. */
const TEXT_COLUMNS = 26;
const GAP = 2;

export type FrameworkRow = {framework: DetectedFramework; units: string[]};

/** Repo text (unit names) never reaches the terminal raw. */
const clean = stripControlLines;

/** Relative luminance of `#rrggbb`, per WCAG. */
function luminance(hex: string): number {
	const [red, green, blue] = [1, 3, 5].map(start => {
		const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return channel <= 0.039_28
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * The colour to draw a brand mark in. Undefined means the terminal's default
 * foreground: the colour would be unreadable on a black background (contrast
 * under 2.5) or on a white one (under 1.3).
 */
export function iconColor(hex: string): string | undefined {
	if (!/^#[\da-f]{6}$/i.test(hex)) return undefined;
	const light = luminance(hex) + 0.05;
	if (light / 0.05 < 2.5 || 1.05 / light < 1.3) return undefined;
	return hex;
}

/**
 * Each detected framework with the units that use it, in first-seen order.
 * Units on different versions of one framework get a row each.
 */
export function frameworksOf(layout: LayoutDetection): FrameworkRow[] {
	const rows = new Map<string, FrameworkRow>();
	for (const unit of layout.units) {
		if (!unit.framework) continue;
		const key = `${unit.framework.id}\u0000${unit.framework.version ?? ''}`;
		const row = rows.get(key);
		if (row) row.units.push(unit.name);
		else rows.set(key, {framework: unit.framework, units: [unit.name]});
	}

	return [...rows.values()];
}

const nameOf = ({name, version}: DetectedFramework) =>
	version ? `${name} ${version}` : name;

/** 'Next.js 15.2: web', one line per framework; what setup says without icons. */
export function frameworkText(rows: FrameworkRow[]): string {
	return rows
		.map(({framework, units}) => `${nameOf(framework)}: ${units.join(', ')}`)
		.join('\n');
}

/** The icon colour for a framework id, and the name's: none for a stand-in. */
export function colorsFor(id: string): {icon?: string; name?: string} {
	const hex = FRAMEWORK_ICONS[id]?.hex;
	if (!hex) return {};
	const icon = iconColor(hex);
	return {
		icon,
		name: hex.toLowerCase() === FALLBACK_HEX ? undefined : icon,
	};
}

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
