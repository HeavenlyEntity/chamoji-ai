import {afterEach, expect, test, vi} from 'vitest';
import {detect} from '../../src/index.js';
import type {FixtureRepo} from '../helpers/fixture-repo.js';
import {gearzLayout, suiteAppMonorepo} from '../helpers/setup-fixtures.js';

/** Every `git ls-files` run that lists untracked files too, which is the costly one. */
const listings = vi.hoisted(() => ({count: 0}));

vi.mock('../../src/git.js', async importOriginal => {
	const real = await importOriginal<typeof import('../../src/git.js')>();
	return {
		...real,
		async runGit(args: string[], cwd: string) {
			if (args[0] === 'ls-files' && args.includes('--others')) {
				listings.count++;
			}

			return real.runGit(args, cwd);
		},
	};
});

let repo: FixtureRepo | undefined;
afterEach(async () => {
	listings.count = 0;
	await repo?.cleanup();
	repo = undefined;
});

test('setup lists the repo twice however many packages it holds', async () => {
	repo = await gearzLayout();
	const found = await detect(repo.dir);
	expect(found.layout.packages.length).toBeGreaterThan(4);
	// One listing finds the workspace, one finds the SDF projects; before
	// each package re-listed the repo, that was 2 + packages + candidates.
	expect(listings.count).toBe(2);
});

test('an SDF monorepo is listed the same twice', async () => {
	repo = await suiteAppMonorepo();
	const found = await detect(repo.dir);
	expect(found.layout.sdf).toHaveLength(1);
	expect(listings.count).toBe(2);
});
