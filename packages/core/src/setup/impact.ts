import type {ChamojiConfig} from '../types.js';
import {ownerOf, readWorkspace, resolveUnits} from '../units/workspace.js';

/**
 * Which units a staged change releases (`own`) and which ride along because
 * they use a shared package it touches (`rides`). Excluded and root files
 * count for neither. Both are in unit order and empty without release units.
 */
export async function stagedImpact(
	root: string,
	config: ChamojiConfig,
	files: string[],
): Promise<{own: string[]; rides: string[]}> {
	const settings = config.release;
	if (!settings || settings.shape === 'single' || settings.units.length === 0) {
		return {own: [], rides: []};
	}

	const packages = await readWorkspace(root);
	const units = resolveUnits(settings, packages);
	const own = new Set<string>();
	const shared = new Set<string>();
	for (const file of files) {
		const owner = ownerOf(file, units, packages, settings.exclude);
		if (owner.kind === 'unit') own.add(owner.unit);
		else if (owner.kind === 'internal') shared.add(owner.path);
	}

	return {
		own: units.filter(unit => own.has(unit.name)).map(unit => unit.name),
		rides: units
			.filter(
				unit => !own.has(unit.name) && unit.uses.some(path => shared.has(path)),
			)
			.map(unit => unit.name),
	};
}
