import {chmod, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {expect, test} from 'vitest';
import {
	publishedVersions,
	requireNpm,
	runNpm,
	npmVersion,
	type NpmRunner,
} from '../../src/index.js';

const reply =
	(stdout: string, ok = true, stderr = ''): NpmRunner =>
	async () => ({ok, stdout, stderr});

test('npmVersion trims npm output', async () => {
	expect(await npmVersion(reply('11.5.1\n'), '/')).toBe('11.5.1');
});

test('requireNpm refuses an old npm with the exact message', async () => {
	await expect(requireNpm(reply('10.9.0\n'), '/')).rejects.toMatchObject({
		code: 'publish-check',
		message: 'chamoji publish needs npm 11.5.1 or newer (you have 10.9.0)',
	});
});

test('requireNpm accepts 11.5.1 and newer', async () => {
	await expect(requireNpm(reply('11.5.1'), '/')).resolves.toBeUndefined();
	await expect(requireNpm(reply('12.0.0'), '/')).resolves.toBeUndefined();
});

test('publishedVersions asks npm view and reads versions and latest', async () => {
	const calls: string[][] = [];
	const npm: NpmRunner = async args => {
		calls.push(args);
		return {
			ok: true,
			stdout: JSON.stringify({
				versions: ['1.0.0', '1.1.0'],
				'dist-tags': {latest: '1.1.0'},
			}),
			stderr: '',
		};
	};
	expect(await publishedVersions(npm, 'x', 'https://r.dev/', '/')).toEqual({
		versions: ['1.0.0', '1.1.0'],
		latest: '1.1.0',
	});
	expect(calls[0]).toEqual([
		'view',
		'x',
		'versions',
		'dist-tags',
		'--json',
		'--registry',
		'https://r.dev/',
	]);
});

test('publishedVersions turns a single version string into an array', async () => {
	const npm = reply(
		JSON.stringify({versions: '1.0.0', 'dist-tags': {latest: '1.0.0'}}),
	);
	expect(await publishedVersions(npm, 'x', 'https://r.dev/', '/')).toEqual({
		versions: ['1.0.0'],
		latest: '1.0.0',
	});
});

test('publishedVersions gives null for a package that does not exist', async () => {
	const body = JSON.stringify({error: {code: 'E404', summary: 'Not found'}});
	expect(
		await publishedVersions(reply(body, false), 'x', 'https://r.dev/', '/'),
	).toBeNull();
	expect(
		await publishedVersions(
			reply('', false, `npm error code E404\n${body}`),
			'x',
			'https://r.dev/',
			'/',
		),
	).toBeNull();
});

test('publishedVersions throws other failures with npm message', async () => {
	const body = JSON.stringify({
		error: {code: 'ECONNREFUSED', summary: 'offline'},
	});
	await expect(
		publishedVersions(reply(body, false), 'x', 'https://r.dev/', '/'),
	).rejects.toThrow('offline');
});

test.skipIf(process.platform === 'win32')(
	'runNpm gives the child only options.env, not process.env',
	async () => {
		const bin = await mkdtemp(path.join(tmpdir(), 'chamoji-fake-npm-'));
		const script = path.join(bin, 'npm');
		await writeFile(
			script,
			'#!/bin/sh\necho "leak=${LEAK_ONLY_IN_PROCESS:-unset} kept=${KEPT:-unset}"\n',
		);
		await chmod(script, 0o755);
		process.env.LEAK_ONLY_IN_PROCESS = 'secret';
		try {
			const result = await runNpm([], {
				cwd: bin,
				env: {PATH: `${bin}:/usr/bin:/bin`, KEPT: 'yes'},
			});
			expect(result.stdout.trim()).toBe('leak=unset kept=yes');
		} finally {
			delete process.env.LEAK_ONLY_IN_PROCESS;
		}
	},
);
