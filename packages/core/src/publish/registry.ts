import path from 'node:path';
import type {WorkspacePackage} from '../units/workspace.js';
import {readTextOrNull} from '../fs-read.js';
import {DEFAULT_REGISTRY} from './npm.js';

const withSlash = (url: string): string =>
	url.endsWith('/') ? url : `${url}/`;

/** `@scope:registry=...` lines of an .npmrc, by scope. */
function scopedRegistries(npmrc: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const raw of npmrc.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const match = /^(@[^:=\s]+):registry\s*=\s*(\S+)$/.exec(line);
		if (match) found.set(match[1]!, match[2]!);
	}

	return found;
}

/**
 * Where a package publishes: its `publishConfig.registry`, else the registry
 * its scope has in the root `.npmrc`, else npmjs. Always ends with `/`.
 */
export async function registryFor(
	root: string,
	pkg: WorkspacePackage,
): Promise<string> {
	const manifest = await readTextOrNull(
		path.join(root, pkg.path, 'package.json'),
	);
	if (manifest) {
		try {
			const parsed = JSON.parse(manifest) as {
				publishConfig?: {registry?: unknown};
			};
			const configured = parsed.publishConfig?.registry;
			if (typeof configured === 'string' && configured) {
				return withSlash(configured);
			}
		} catch {
			// An unreadable manifest has no publishConfig to honour.
		}
	}

	if (pkg.name.startsWith('@')) {
		const npmrc = await readTextOrNull(path.join(root, '.npmrc'));
		const scope = pkg.name.slice(0, pkg.name.indexOf('/'));
		const scoped = npmrc ? scopedRegistries(npmrc).get(scope) : undefined;
		if (scoped) return withSlash(scoped);
	}

	return DEFAULT_REGISTRY;
}
