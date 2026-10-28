import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';

const KEY = 'TYPESAFE_API_KEY';

/** Checked in order; the first file that sets the key wins. */
const ENV_FILES = ['.env.local', '.env'];

/**
 * The TypeSafe API key: from the environment, else from `.env.local` or
 * `.env` in `cwd`. Only this one variable is read from the files; nothing
 * is loaded into `env` or `process.env`.
 */
export async function readTypesafeKey(
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	const fromEnv = env[KEY]?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	for (const file of ENV_FILES) {
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
