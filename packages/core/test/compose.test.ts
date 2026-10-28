import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {loadComposeConfig} from '../src/compose/config.js';
import {shouldPrompt} from '../src/compose/hook.js';
import {formatCommitMessage, type CommitDraft} from '../src/compose/message.js';
import {searchGitmojis} from '../src/compose/search.js';
import {parseCommit} from '../src/parse.js';

const asRaw = (message: string) => {
	const [subject = '', ...rest] = message.split('\n');
	return {
		hash: 'a'.repeat(40),
		shortHash: 'aaaaaaa',
		authorName: 'Dev',
		authorEmail: 'dev@example.com',
		date: '2026-01-01T00:00:00Z',
		subject,
		body: rest.join('\n').trim(),
		trailers: '',
	};
};

describe('formatCommitMessage', () => {
	test('gitmoji, scope and title, capitalised', () => {
		expect(
			formatCommitMessage(
				{gitmoji: 'sparkles', scope: 'auth', title: 'add login'},
				{capitalizeTitle: true},
			),
		).toBe('✨ (auth): Add login');
	});

	test('the code format writes :sparkles:', () => {
		expect(
			formatCommitMessage(
				{gitmoji: 'sparkles', scope: 'auth', title: 'Add login'},
				{emojiFormat: 'code'},
			),
		).toBe(':sparkles: (auth): Add login');
	});

	test('body, then BREAKING CHANGE and Why trailers', () => {
		expect(
			formatCommitMessage({
				gitmoji: 'boom',
				title: 'Require Node 22',
				body: 'Node 20 is out of support.',
				breaking: 'drops Node 20',
				why: 'we use node:util parseEnv',
			}),
		).toBe(
			'💥 Require Node 22\n\nNode 20 is out of support.\n\nBREAKING CHANGE: drops Node 20\nWhy: we use node:util parseEnv',
		);
	});

	test('breaking without text describes it with the title', () => {
		expect(
			formatCommitMessage({
				gitmoji: 'boom',
				title: 'Drop the v1 API',
				breaking: true,
			}),
		).toBe('💥 Drop the v1 API\n\nBREAKING CHANGE: Drop the v1 API');
	});

	test('a title that already starts with the gitmoji is not doubled', () => {
		expect(formatCommitMessage({gitmoji: 'bug', title: '🐛 Fix crash'})).toBe(
			'🐛 Fix crash',
		);
	});

	test.each<CommitDraft>([
		{gitmoji: 'sparkles', scope: 'auth', title: 'Add login'},
		{gitmoji: 'bug', title: 'Fix: Ajax crash on empty body'},
		{gitmoji: 'boom', title: 'Drop the v1 API', breaking: 'v1 is gone'},
		{gitmoji: 'memo', scope: 'readme', title: 'Explain --since', body: 'More.'},
	])('chamoji reads back what it writes: %o', draft => {
		const parsed = parseCommit(asRaw(formatCommitMessage(draft)));
		expect(parsed).toMatchObject({
			gitmoji: draft.gitmoji,
			scope: draft.scope ?? null,
			description: draft.title,
			breaking: Boolean(draft.breaking),
		});
	});
});

describe('searchGitmojis', () => {
	test('an exact code comes first', () => {
		expect(searchGitmojis('bug')[0]?.code).toBe('bug');
	});

	test('description words match', () => {
		const codes = searchGitmojis('fix', 20).map(gitmoji => gitmoji.code);
		expect(codes).toEqual(
			expect.arrayContaining(['bug', 'ambulance', 'adhesive_bandage']),
		);
	});

	test('a few letters of the code find it', () => {
		expect(searchGitmojis('spk').map(gitmoji => gitmoji.code)).toContain(
			'sparkles',
		);
	});

	test('an empty query lists them in the official order', () => {
		expect(searchGitmojis('', 3).map(gitmoji => gitmoji.code)).toEqual([
			'art',
			'zap',
			'fire',
		]);
	});

	test('colons and case are ignored', () => {
		expect(searchGitmojis(':Sparkles:')[0]?.code).toBe('sparkles');
	});
});

describe('loadComposeConfig', () => {
	let dir: string | undefined;
	afterEach(async () => {
		if (dir) await rm(dir, {recursive: true, force: true});
		dir = undefined;
	});

	const repo = async (files: Record<string, string>) => {
		dir = await mkdtemp(path.join(tmpdir(), 'chamoji-compose-'));
		for (const [file, text] of Object.entries(files)) {
			await writeFile(path.join(dir, file), text);
		}

		return dir;
	};

	test('defaults with no config files', async () => {
		expect(await loadComposeConfig(await repo({}))).toEqual({
			emojiFormat: 'emoji',
			scopePrompt: true,
			messagePrompt: true,
			capitalizeTitle: true,
			autoAdd: false,
		});
	});

	test('reads .gitmojirc.json', async () => {
		const cwd = await repo({'.gitmojirc.json': '{"emojiFormat": "code"}'});
		expect((await loadComposeConfig(cwd)).emojiFormat).toBe('code');
	});

	test('reads the gitmoji key in package.json', async () => {
		const cwd = await repo({
			'package.json': '{"name": "x", "gitmoji": {"scopePrompt": false}}',
		});
		expect((await loadComposeConfig(cwd)).scopePrompt).toBe(false);
	});

	test('.gitmojirc.json wins over package.json', async () => {
		const cwd = await repo({
			'.gitmojirc.json': '{"emojiFormat": "emoji"}',
			'package.json': '{"gitmoji": {"emojiFormat": "code", "autoAdd": true}}',
		});
		expect(await loadComposeConfig(cwd)).toMatchObject({
			emojiFormat: 'emoji',
			autoAdd: true,
		});
	});

	test('a malformed .gitmojirc.json names the file', async () => {
		const cwd = await repo({'.gitmojirc.json': '{nope'});
		await expect(loadComposeConfig(cwd)).rejects.toThrow('.gitmojirc.json');
	});

	test('unknown keys and wrong types are ignored', async () => {
		const cwd = await repo({
			'.gitmojirc.json':
				'{"gitmojisUrl": "https://x", "emojiFormat": "neither", "autoAdd": "yes"}',
		});
		expect(await loadComposeConfig(cwd)).toMatchObject({
			emojiFormat: 'emoji',
			autoAdd: false,
		});
	});
});

describe('shouldPrompt', () => {
	const base = {
		message: '\n# Please enter the commit message for your changes.\n',
		isTTY: true,
		env: {},
		rebasing: false,
	};

	test.each(['message', 'merge', 'squash', 'commit'])(
		'source=%s never prompts',
		source => {
			expect(shouldPrompt({...base, source})).toMatchObject({prompt: false});
		},
	);

	test('a rebase in progress never prompts', () => {
		expect(shouldPrompt({...base, rebasing: true})).toMatchObject({
			prompt: false,
		});
	});

	test('no terminal, or CI, never prompts', () => {
		expect(shouldPrompt({...base, isTTY: false})).toMatchObject({
			prompt: false,
		});
		expect(shouldPrompt({...base, env: {CI: '1'}})).toMatchObject({
			prompt: false,
		});
	});

	test('a message that already has a gitmoji never prompts', () => {
		for (const message of ['✨ Add login\n', ':sparkles: Add login\n']) {
			expect(shouldPrompt({...base, message})).toMatchObject({prompt: false});
		}
	});

	test('a plain git commit on a terminal prompts', () => {
		expect(shouldPrompt(base)).toEqual({prompt: true});
		expect(shouldPrompt({...base, source: 'template'})).toEqual({prompt: true});
	});
});
