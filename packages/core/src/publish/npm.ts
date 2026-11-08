import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import semver from 'semver';
import {ReleaseError} from '../release.js';
import {spawnSpec} from './pack.js';

const execFileAsync = promisify(execFile);

export const MIN_NPM = '11.5.1';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export type NpmResult = {ok: boolean; stdout: string; stderr: string};

/** Runs npm. Tests pass a fake, so nothing reaches a real registry. */
export type NpmRunner = (
	args: string[],
	options: {cwd: string; env: Record<string, string>; inheritStdio?: boolean},
) => Promise<NpmResult>;

/** `process.env` without its unset entries, as a complete child environment. */
export function processEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}

	return env;
}

/**
 * Runs npm without a shell string. `options.env` is the child's whole
 * environment, with no merge with `process.env`, so a variable the caller left
 * out never reaches npm; callers build it (PATH included). With `inheritStdio` npm owns the terminal,
 * so its OTP prompt reaches the user; stdout and stderr are then empty.
 */
export const runNpm: NpmRunner = async (args, options) => {
	const run = spawnSpec('npm', args);
	const env = options.env;
	if (options.inheritStdio) {
		return new Promise(resolve => {
			const child = spawn(run.file, run.args, {
				cwd: options.cwd,
				env,
				stdio: 'inherit',
			});
			child.on('error', error =>
				resolve({ok: false, stdout: '', stderr: error.message}),
			);
			child.on('close', code =>
				resolve({ok: code === 0, stdout: '', stderr: ''}),
			);
		});
	}

	try {
		const {stdout, stderr} = await execFileAsync(run.file, run.args, {
			cwd: options.cwd,
			env,
			maxBuffer: 64 * 1024 * 1024,
		});
		return {ok: true, stdout, stderr};
	} catch (error) {
		const failed = error as {stdout?: string; stderr?: string; message: string};
		return {
			ok: false,
			stdout: failed.stdout ?? '',
			stderr: failed.stderr ?? failed.message,
		};
	}
};

export async function npmVersion(npm: NpmRunner, cwd: string): Promise<string> {
	const result = await npm(['--version'], {cwd, env: processEnv()});
	if (!result.ok) {
		throw new Error(
			`npm --version failed: ${result.stderr.trim() || 'is npm installed?'}`,
		);
	}

	return result.stdout.trim();
}

export async function requireNpm(npm: NpmRunner, cwd: string): Promise<void> {
	const version = await npmVersion(npm, cwd);
	if (!semver.valid(version) || semver.lt(version, MIN_NPM)) {
		throw new ReleaseError(
			'publish-check',
			`chamoji publish needs npm ${MIN_NPM} or newer (you have ${version})`,
		);
	}
}

function npmError(result: NpmResult): {code: string; message: string} {
	for (const text of [result.stdout, result.stderr]) {
		const start = text.indexOf('{');
		if (start === -1) continue;
		try {
			const parsed = JSON.parse(text.slice(start)) as {
				error?: {code?: string; summary?: string; detail?: string};
			};
			if (parsed.error) {
				return {
					code: parsed.error.code ?? '',
					message: parsed.error.summary ?? parsed.error.detail ?? '',
				};
			}
		} catch {
			// Not JSON; fall through to the plain text.
		}
	}

	const text = result.stderr.trim() || result.stdout.trim();
	return {code: /\bE404\b/.test(text) ? 'E404' : '', message: text};
}

/** What the registry has for `name`, or null when it has never been published. */
export async function publishedVersions(
	npm: NpmRunner,
	name: string,
	registry: string,
	cwd: string,
): Promise<{versions: string[]; latest: string | null} | null> {
	const result = await npm(
		['view', name, 'versions', 'dist-tags', '--json', '--registry', registry],
		{cwd, env: processEnv()},
	);
	if (!result.ok) {
		const {code, message} = npmError(result);
		if (code === 'E404') return null;
		throw new Error(message || `npm view ${name} failed`);
	}

	const data = JSON.parse(result.stdout) as {
		versions?: string | string[];
		'dist-tags'?: Record<string, string>;
	};
	const versions =
		typeof data.versions === 'string' ? [data.versions] : (data.versions ?? []);
	return {versions, latest: data['dist-tags']?.latest ?? null};
}
