import {spawn} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import semver from 'semver';

/** The only network call chamoji makes by default (roadmap principle 4). */
export const LATEST_URL = 'https://registry.npmjs.org/@chamoji%2fcli/latest';

const DAY = 24 * 60 * 60 * 1000;

export type UpdateCache = {checkedAt: number; latest: string};
export type InstallKind =
	'npx' | 'dlx' | 'pnpm-global' | 'yarn-global' | 'project' | 'global';

/** Shows a cached "newer version" notice and refreshes the cache when stale. */
export type UpdateCheck = {
	notice(): string | undefined;
	refreshIfStale(): void;
};

const DISABLED: UpdateCheck = {notice: () => undefined, refreshIfStale() {}};

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

/** Relative values are ignored, as the XDG spec says. */
export function cacheFile(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	home?: string,
): string {
	const xdg = env['XDG_CONFIG_HOME'];
	const base =
		(xdg && path.isAbsolute(xdg) && xdg) ||
		(platform === 'win32' && env['APPDATA']) ||
		path.join(home ?? os.homedir(), '.config');
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

/** Writes through a temporary file so readers never see a partial cache. */
export function writeCache(file: string, cache: UpdateCache): void {
	mkdirSync(path.dirname(file), {recursive: true});
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(cache));
	renameSync(temporary, file);
}

/** Stale after a day, or when dated in the future (the clock was wrong). */
export function isStale(cache: UpdateCache | undefined, now: number): boolean {
	return !cache || cache.checkedAt > now || now - cache.checkedAt > DAY;
}

/** Path markers, checked in order against the lowercased script path. */
const KINDS: Array<[RegExp, InstallKind]> = [
	[/\/_npx\//, 'npx'],
	[/\/pnpm\/dlx\/|\/dlx-[^/]*\/|\/\.bun\/install\/cache\/|\/bunx-/, 'dlx'],
	[/\/pnpm\/global\//, 'pnpm-global'],
	[/\/yarn\/global\//, 'yarn-global'],
	[/\/lib\/node_modules\/|\/roaming\/npm\/node_modules\//, 'global'],
	[/\/node_modules\//, 'project'],
];

/** How chamoji was started, so the notice can name the right update command. */
export function installKind(scriptPath: string): InstallKind {
	const script = scriptPath.replaceAll('\\', '/').toLowerCase();
	return KINDS.find(([pattern]) => pattern.test(script))?.[1] ?? 'global';
}

const HOW: Record<InstallKind, string> = {
	global: 'npm i -g @chamoji/cli@latest',
	npx: 'run npx @chamoji/cli@latest',
	dlx: 'run it with @chamoji/cli@latest',
	'pnpm-global': 'pnpm add -g @chamoji/cli@latest',
	'yarn-global': 'yarn global add @chamoji/cli@latest',
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
	now?: () => number;
	/** Starts the refresh worker; tests replace it. */
	startWorker?: (cacheFile: string) => void;
};

const WORKER = fileURLToPath(new URL('update-worker.js', import.meta.url));

function startDetachedWorker(file: string): void {
	if (!existsSync(WORKER)) {
		return;
	}

	const child = spawn(process.execPath, [WORKER, file], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	});
	// Spawn failures arrive as an event; ignore them rather than crash later.
	child.on('error', () => {});
	child.unref();
}

/**
 * The real check. It never waits on the network: the notice comes from the
 * cache, and a stale cache is refreshed by a detached worker whose result
 * shows on a later run.
 */
export function createUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
	const {
		current,
		env,
		stderrIsTTY,
		scriptPath,
		now = Date.now,
		startWorker = startDetachedWorker,
	} = options;

	let file: string;
	try {
		if (!updateCheckEnabled(env, stderrIsTTY, true)) {
			return DISABLED;
		}

		file = cacheFile(env);
	} catch {
		// No home directory or similar: no notices, but chamoji still runs.
		return DISABLED;
	}

	return {
		notice() {
			const cache = readCache(file);
			return cache
				? updateNotice(current, cache.latest, installKind(scriptPath))
				: undefined;
		},
		refreshIfStale() {
			const cache = readCache(file);
			if (!isStale(cache, now())) {
				return;
			}

			// Record the attempt before starting the worker. Runs in the next 24
			// hours then skip the refresh, even when offline or when the worker
			// can't run; and if this write fails, the worker couldn't write either.
			try {
				writeCache(file, {checkedAt: now(), latest: cache?.latest ?? ''});
				startWorker(file);
			} catch {
				// No notice this time.
			}
		},
	};
}
