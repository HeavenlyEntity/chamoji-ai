import {DEFAULT_REGISTRY} from '../publish/npm.js';
import type {Mention} from '../units/settings.js';
import type {Detection, SetupAnswers} from './answers.js';

/** What a release does now: a section with no trigger runs manually until it's answered. */
export const effectiveTrigger = (
	answers: Pick<SetupAnswers, 'trigger' | 'triggerUnset'>,
): 'merge' | 'manual' => (answers.triggerUnset ? 'manual' : answers.trigger);

/** The first public package that doesn't publish to npmjs, which needs an npm token. */
export const tokenRegistry = (
	detection: Detection,
): Detection['publishable'][number] | undefined =>
	detection.publishable.find(pkg => pkg.registry !== DEFAULT_REGISTRY);

/**
 * `mention` as these answers can hold it: with no unit in a single repo, else
 * with the unit it names or, for a pin of the repo, the only unit there is.
 * Null when no unit can own it.
 */
export function mentionFor(
	answers: SetupAnswers,
	mention: Mention,
): Mention | null {
	const {pattern, files} = mention;
	if (answers.shape === 'single') return {pattern, files};
	const names = answers.units.map(unit => unit.name);
	const unit = mention.unit ?? (names.length === 1 ? names[0] : undefined);
	return unit && names.includes(unit) ? {pattern, files, unit} : null;
}
