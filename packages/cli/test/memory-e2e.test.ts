import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, expect, test} from 'vitest';
import {createRepo, gitOutput} from '../../core/test/helpers/fixture-repo.js';

const execFileAsync = promisify(execFile);
const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async cleanup => cleanup()));
});

/** The built CLI, as a user runs it. */
async function chamoji(argv: string[], cwd: string): Promise<string> {
	const {stdout} = await execFileAsync(
		process.execPath,
		[cliJs, ...argv, '--no-update-check'],
		{cwd},
	);
	return stdout;
}

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    status: active',
		'',
	].join('\n'),
};

const WHY = 'the old form leaked sessions';

test('memory survives deleting a branch and a fresh clone', async () => {
	const remote = await mkdtemp(path.join(tmpdir(), 'chamoji-e2e-remote-'));
	const clones = await mkdtemp(path.join(tmpdir(), 'chamoji-e2e-clones-'));
	cleanups.push(
		async () => rm(remote, {recursive: true, force: true}),
		async () => rm(clones, {recursive: true, force: true}),
	);
	await gitOutput(remote, ['init', '-q', '--bare', '-b', 'main']);
	const repo = await createRepo([{commit: '🎉 Init', files: WORKSTREAMS}]);
	cleanups.push(async () => repo.cleanup());
	const {dir} = repo;
	await gitOutput(dir, ['remote', 'add', 'origin', remote]);
	await gitOutput(dir, ['push', '-q', 'origin', 'main']);

	await gitOutput(dir, ['switch', '-q', '-c', 'feature']);
	await gitOutput(dir, [
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		`✨ Add login\n\nWhy: ${WHY}\nWorkstream: auth`,
	]);
	const written = (await gitOutput(dir, ['rev-parse', 'HEAD'])).trim();
	await chamoji(['ws', 'ship', 'auth'], dir);
	expect(await chamoji(['memory', 'sync'], dir)).toContain('Synced memory');

	// Unmerged, so nothing but memory holds the commit once it's collected.
	await gitOutput(dir, ['reset', '-q', '--hard']);
	await gitOutput(dir, ['switch', '-q', 'main']);
	await gitOutput(dir, ['branch', '-q', '-D', 'feature']);
	await gitOutput(dir, ['reflog', 'expire', '--expire=now', '--all']);
	await gitOutput(dir, ['gc', '-q', '--prune=now']);
	await expect(gitOutput(dir, ['cat-file', '-e', written])).rejects.toThrow();

	expect(await chamoji(['memory', 'show', 'auth'], dir)).toContain(WHY);

	const clone = path.join(clones, 'fresh');
	await gitOutput(clones, ['clone', '-q', remote, clone]);
	await chamoji(['init'], clone);
	expect(await chamoji(['memory', 'show', 'auth'], clone)).toContain(WHY);
});
