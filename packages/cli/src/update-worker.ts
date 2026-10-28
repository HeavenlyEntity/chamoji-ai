// Detached helper started by update-check.ts: asks npm for the latest
// @chamoji/cli version and caches it. It sends nothing but the request, and
// any failure is silent; the cache still records the attempt so an offline
// machine doesn't retry on every run.
import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {LATEST_URL, readCache} from './update-check.js';

const [file] = process.argv.slice(2);

if (file) {
	let latest: string | undefined;
	try {
		const response = await fetch(LATEST_URL, {
			headers: {accept: 'application/json'},
			signal: AbortSignal.timeout(5000),
		});
		if (response.ok) {
			const data = (await response.json()) as {version?: unknown};
			latest = typeof data.version === 'string' ? data.version : undefined;
		}
	} catch {
		// Offline, slow or blocked: keep what we had.
	}

	try {
		const cache = {
			checkedAt: Date.now(),
			latest: latest ?? readCache(file)?.latest ?? '',
		};
		await mkdir(path.dirname(file), {recursive: true});
		const temporary = `${file}.${process.pid}.tmp`;
		await writeFile(temporary, JSON.stringify(cache));
		await rename(temporary, file);
	} catch {
		// An unwritable config directory just means no notices.
	}
}
