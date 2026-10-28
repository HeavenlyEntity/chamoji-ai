import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import semver from 'semver';

/** The only network call chamoji makes by default (roadmap principle 4). */
export const LATEST_URL = 'https://registry.npmjs.org/@chamoji%2fcli/latest';

const DAY = 24 * 60 * 60 * 1000;

export type UpdateCache = {checkedAt: number; latest: string};
export type InstallKind = 'npx' | 'project' | 'global';

/** Shows a cached "newer version" notice and refreshes the cache when stale. */
export type UpdateCheck = {
	notice(): string | undefined;
	refreshIfStale(): void;
};

export function updateCheckEnabled(
	env: NodeJS.ProcessEnv,
	stderrIsTTY: boolean,
	flag: boolean,
): boolean {
	return (
		flag &&
		stderrIsTTY &&
		!env['CI'] &&
		!env['NO_UPDATE_NOTIFIER'] &&
		env['CHAMOJI_NO_UPDATE_CHECK'] !== '1'
	);
}

export function cacheFile(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	home: string = os.homedir(),
): string {
	const base =
		env['XDG_CONFIG_HOME'] ||
		(platform === 'win32' && env['APPDATA']) ||
		path.join(home, '.config');
	return path.join(base, 'chamoji', 'update-check.json');
}

export function readCache(file: string): UpdateCache | undefined {
	try {
		const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateCache>;
		return typeof data.checkedAt === 'number' && typeof data.latest === 'string'
			? {checkedAt: data.checkedAt, latest: data.latest}
			: undefined;
	} catch {
		return undefined;
	}
}

export function isStale(cache: UpdateCache | undefined, now: number): boolean {
	return !cache || now - cache.checkedAt > DAY;
}

/** How chamoji was started, so the notice can name the right update command. */
export function installKind(scriptPath: string, cwd: string): InstallKind {
	const script = scriptPath.replaceAll('\\', '/');
	if (script.includes('/_npx/')) {
		return 'npx';
	}

	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const modules = `${path.join(dir, 'node_modules').replaceAll('\\', '/')}/`;
		if (script.startsWith(modules)) {
			return 'project';
		}

		if (path.dirname(dir) === dir) {
			return 'global';
		}
	}
}

const HOW: Record<InstallKind, string> = {
	global: 'npm i -g @chamoji/cli@latest',
	npx: 'run npx @chamoji/cli@latest',
	project: 'update @chamoji/cli in package.json',
};

export function updateNotice(
	current: string,
	latest: string,
	kind: InstallKind,
): string | undefined {
	const valid = semver.valid(latest);
	if (!valid || semver.prerelease(valid) || !semver.valid(current)) {
		return undefined;
	}

	return semver.gt(valid, current)
		? `chamoji ${valid} is available (you have ${current}): ${HOW[kind]}`
		: undefined;
}

export type UpdateCheckOptions = {
	current: string;
	env: NodeJS.ProcessEnv;
	stderrIsTTY: boolean;
	scriptPath: string;
	cwd: string;
	now?: () => number;
};

/**
 * The real check. It never waits on the network: the notice comes from the
 * cache, and a stale cache is refreshed by a detached worker whose result
 * shows on a later run.
 */
export function createUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
	const {current, env, stderrIsTTY, scriptPath, cwd, now = Date.now} = options;
	if (!updateCheckEnabled(env, stderrIsTTY, true)) {
		return {notice: () => undefined, refreshIfStale() {}};
	}

	const file = cacheFile(env);
	return {
		notice() {
			const cache = readCache(file);
			return cache
				? updateNotice(current, cache.latest, installKind(scriptPath, cwd))
				: undefined;
		},
		refreshIfStale() {
			if (!isStale(readCache(file), now())) {
				return;
			}

			try {
				const worker = fileURLToPath(
					new URL('update-worker.js', import.meta.url),
				);
				spawn(process.execPath, [worker, file], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true,
				}).unref();
			} catch {
				// A failed refresh just means no notice this time.
			}
		},
	};
}
