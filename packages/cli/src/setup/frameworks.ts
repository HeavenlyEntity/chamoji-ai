import type {DetectedFramework, LayoutDetection} from '@chamoji/core';
import {FALLBACK_HEX, FRAMEWORK_ICONS} from '../framework-icons.js';
import {relativeLuminance} from '../foil.js';

export type FrameworkRow = {framework: DetectedFramework; units: string[]};

/**
 * The colour to draw a brand mark in. Undefined means the terminal's default
 * foreground: the colour would be unreadable on a black background (contrast
 * under 2.5) or on a white one (under 1.3).
 */
export function iconColor(hex: string): string | undefined {
	if (!/^#[\da-f]{6}$/i.test(hex)) return undefined;
	const light =
		relativeLuminance({
			r: Number.parseInt(hex.slice(1, 3), 16),
			g: Number.parseInt(hex.slice(3, 5), 16),
			b: Number.parseInt(hex.slice(5, 7), 16),
		}) + 0.05;
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

export const nameOf = ({name, version}: DetectedFramework) =>
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
