import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;

afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

test('createRepo creates commits and tags', async () => {
	repo = await createRepo([
		{commit: '🎉 Initial commit'},
		{commit: '✨ Add feature'},
		{tag: 'v1.0.0'},
	]);

	const log = await gitOutput(repo.dir, ['log', '--oneline']);
	expect(log.trim().split('\n')).toHaveLength(2);
	expect((await gitOutput(repo.dir, ['tag'])).trim()).toBe('v1.0.0');
});
