import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {checkCommand, defaultBranch} from '../../src/index.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../helpers/fixture-repo.js';

const made: Array<{cleanup(): Promise<void>}> = [];
afterEach(async () => {
	for (const each of made.splice(0)) await each.cleanup();
});

async function withScripts(scripts: Record<string, string>) {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-workflow-'));
	made.push({cleanup: async () => rm(dir, {recursive: true, force: true})});
	await writeFile(path.join(dir, 'package.json'), JSON.stringify({scripts}));
	return dir;
}

const repo = async (steps: Parameters<typeof createRepo>[0]) => {
	const fixture: FixtureRepo = await createRepo(steps);
	made.push(fixture);
	return fixture.dir;
};

test('checkCommand per package manager', async () => {
	const both = await withScripts({check: 'tsc', test: 'vitest', build: 'tsup'});
	expect(await checkCommand(both, 'npm')).toBe('npm run check && npm test');
	expect(await checkCommand(both, 'pnpm')).toBe('pnpm check && pnpm test');
	// A bare `yarn check` or `bun test` is the tool's own command, so they say run.
	expect(await checkCommand(both, 'yarn')).toBe(
		'yarn run check && yarn run test',
	);
	expect(await checkCommand(both, 'bun')).toBe('bun run check && bun run test');
	const testOnly = await withScripts({test: 'vitest', build: 'tsup'});
	expect(await checkCommand(testOnly, 'pnpm')).toBe('pnpm test');
	expect(await checkCommand(testOnly, 'npm')).toBe('npm test');
	const checkOnly = await withScripts({check: 'tsc'});
	expect(await checkCommand(checkOnly, 'npm')).toBe('npm run check');
});

test('checkCommand falls back to build, then to nothing', async () => {
	const build = await withScripts({build: 'tsup', lint: 'eslint'});
	expect(await checkCommand(build, 'pnpm')).toBe('pnpm build');
	expect(await checkCommand(build, 'npm')).toBe('npm run build');
	const none = await withScripts({lint: 'eslint'});
	expect(await checkCommand(none, 'pnpm')).toBeNull();
	const empty = await mkdtemp(path.join(tmpdir(), 'chamoji-workflow-'));
	made.push({cleanup: async () => rm(empty, {recursive: true, force: true})});
	expect(await checkCommand(empty, 'npm')).toBeNull();
});

test('defaultBranch from origin/HEAD, else current, else main', async () => {
	// No origin: the current branch.
	const dir = await repo([{commit: '🎉 Start'}]);
	expect(await defaultBranch(dir)).toBe('main');
	await gitOutput(dir, ['switch', '-q', '-c', 'trunk']);
	expect(await defaultBranch(dir)).toBe('trunk');

	// origin/HEAD wins over where the clone is now.
	await gitOutput(dir, ['switch', '-q', 'main']);
	const clone = await createRepo([], {clone: dir});
	made.push(clone);
	await gitOutput(clone.dir, ['switch', '-q', '-c', 'feature']);
	expect(await defaultBranch(clone.dir)).toBe('main');

	// A detached HEAD with no origin: main.
	const detached = await repo([{commit: '🎉 Start'}]);
	await gitOutput(detached, ['checkout', '-q', '--detach']);
	expect(await defaultBranch(detached)).toBe('main');
});
