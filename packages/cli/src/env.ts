import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {runGit} from '@chamoji/core';

const KEY = 'TYPESAFE_API_KEY';

/** Checked in order; the first file that sets the key wins. */
const ENV_FILES = ['.env.local', '.env'];

/**
 * The TypeSafe API key: from the environment, else from `.env.local` or
 * `.env` in `cwd`. Only this one variable is read from the files; nothing
 * is loaded into `env` or `process.env`.
 *
 * With `untrackedOnly`, a file git tracks is skipped. A cloned repository
 * could commit a `.env` holding someone else's key, and work sent with it
 * would land in their account.
 */
export async function readTypesafeKey(
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: {untrackedOnly?: boolean} = {},
): Promise<string | undefined> {
	const fromEnv = env[KEY]?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	for (const file of ENV_FILES) {
		if (options.untrackedOnly && (await isTracked(cwd, file))) {
			continue;
		}

		let text: string;
		try {
			text = await readFile(path.join(cwd, file), 'utf8');
		} catch {
			continue;
		}

		const value = parseEnv(text)[KEY]?.trim();
		if (value) {
			return value;
		}
	}

	return undefined;
}

async function isTracked(cwd: string, file: string): Promise<boolean> {
	try {
		await runGit(['ls-files', '--error-unmatch', '--', file], cwd);
		return true;
	} catch {
		return false;
	}
}
