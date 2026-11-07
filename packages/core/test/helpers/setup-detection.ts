import {afterEach} from 'vitest';
import {detect, parseReleaseSettings, type Detection} from '../../src/index.js';
import type {FixtureRepo} from './fixture-repo.js';

/**
 * `detected(fixture)` makes the fixture and runs setup's detection on it; the
 * fixture is cleaned up after each test. `repo()` is the current fixture.
 */
export function useDetection(): {
	detected(made: Promise<FixtureRepo>): Promise<Detection>;
	repo(): FixtureRepo;
} {
	let current: FixtureRepo | undefined;
	afterEach(async () => {
		await current?.cleanup();
		current = undefined;
	});
	return {
		async detected(made) {
			await current?.cleanup();
			current = await made;
			return detect(current.dir);
		},
		repo() {
			if (!current) throw new Error('No fixture yet');
			return current;
		},
	};
}

/** A section as the engine reads it; throws when the engine would refuse it. */
export const valid = (section: unknown) =>
	parseReleaseSettings(section, 'chamoji.config.json');
