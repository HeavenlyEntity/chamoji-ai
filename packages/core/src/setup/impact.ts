import type {ChamojiConfig} from '../types.js';
import {ownerOf, readWorkspace, resolveUnits} from '../units/workspace.js';

/**
 * Which units a staged change releases (`own`) and which ride along because
 * they use a shared package it touches (`rides`). Under
 * `sharedChanges: "release-dependents"` the shared change releases those
 * users itself, so they're `own`. Excluded and root files count for neither.
 * Both are in unit order and empty without release units.
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

	const users = units
		.filter(
			unit => !own.has(unit.name) && unit.uses.some(path => shared.has(path)),
		)
		.map(unit => unit.name);
	if (settings.sharedChanges === 'release-dependents') {
		for (const name of users) own.add(name);
	}

	return {
		own: units.filter(unit => own.has(unit.name)).map(unit => unit.name),
		rides: settings.sharedChanges === 'release-dependents' ? [] : users,
	};
}
