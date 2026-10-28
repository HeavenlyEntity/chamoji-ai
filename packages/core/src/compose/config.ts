import {readFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * The composer's settings. The keys are gitmoji-cli's, so its users' config
 * keeps working: `.gitmojirc.json`, then the `gitmoji` key in package.json.
 */
export type ComposeConfig = {
	emojiFormat: 'emoji' | 'code';
	scopePrompt: boolean;
	messagePrompt: boolean;
	capitalizeTitle: boolean;
	autoAdd: boolean;
};

export const DEFAULT_COMPOSE_CONFIG: ComposeConfig = {
	emojiFormat: 'emoji',
	scopePrompt: true,
	messagePrompt: true,
	capitalizeTitle: true,
	autoAdd: false,
};

const BOOLEAN_KEYS = [
	'scopePrompt',
	'messagePrompt',
	'capitalizeTitle',
	'autoAdd',
] as const;

export async function loadComposeConfig(cwd: string): Promise<ComposeConfig> {
	const rc = await readJson(path.join(cwd, '.gitmojirc.json'));
	const pkg = await readJson(path.join(cwd, 'package.json'));
	const fromPackage =
		pkg && typeof pkg.gitmoji === 'object' && pkg.gitmoji !== null
			? (pkg.gitmoji as Record<string, unknown>)
			: {};
	return {
		...DEFAULT_COMPOSE_CONFIG,
		...pick(fromPackage),
		...pick(rc ?? {}),
	};
}

/** The known keys with the right types; anything else is ignored. */
function pick(source: Record<string, unknown>): Partial<ComposeConfig> {
	const picked: Partial<ComposeConfig> = {};
	if (source.emojiFormat === 'emoji' || source.emojiFormat === 'code') {
		picked.emojiFormat = source.emojiFormat;
	}

	for (const key of BOOLEAN_KEYS) {
		if (typeof source[key] === 'boolean') {
			picked[key] = source[key];
		}
	}

	return picked;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch {
		return null;
	}

	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null
			? (value as Record<string, unknown>)
			: {};
	} catch (error) {
		throw new Error(
			`${path.basename(file)} isn't valid JSON: ${(error as Error).message}`,
		);
	}
}
