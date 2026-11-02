import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {
	MEMORY_REF,
	readTree,
	runGitWithInput,
	setActive,
	snapshotWorkstream,
	writeTree,
	type MemoryHit,
} from '@chamoji/core';
import {afterEach, expect, test, vi} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {MISSING_KEY} from '../src/env.js';
import {redact} from '../src/jev-classifier.js';
import {createTools, handleMessage, runMcp, type McpTools} from '../src/mcp.js';

// The real redact, wrapped so a test can see how much text it was given.
vi.mock('../src/jev-classifier.js', async importOriginal => {
	const original =
		await importOriginal<typeof import('../src/jev-classifier.js')>();
	return {...original, redact: vi.fn(original.redact)};
});

const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let repo: FixtureRepo | undefined;
let loose: string | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
	if (loose) await rm(loose, {recursive: true, force: true});
	loose = undefined;
});

const WORKSTREAMS = {
	'.chamoji/workstreams.yml': [
		'workstreams:',
		'  auth:',
		'    title: Auth revamp',
		'    emoji: 🔐',
		'    status: shipped',
		'  billing:',
		'    title: Billing',
		'    status: active',
		'',
	].join('\n'),
};

/** One commit with a card, one without, and `auth` remembered. */
async function project(): Promise<string> {
	repo = await createRepo([
		{commit: '🎉 Init', files: WORKSTREAMS},
		{
			commit: '✨ Add login',
			body: 'Why: the old form leaked sessions\nGotcha: order matters\nWorkstream: auth',
			files: {'src/a.ts': 'one\ntwo\nthree\n'},
		},
		{
			commit: '🐛 Fix footer',
			body: 'The footer overlapped the cookie banner on small screens.',
			files: {'src/b.ts': 'alpha\nbeta\n'},
		},
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	return repo.dir;
}

const request = (method: string, params?: unknown, id: unknown = 1) =>
	JSON.stringify({jsonrpc: '2.0', id, method, params});

/** Sends one message through the same entry point the server uses. */
async function send(
	tools: McpTools,
	method: string,
	params?: unknown,
): Promise<any> {
	const reply = await handleMessage(request(method, params), tools);
	expect(reply).toBeDefined();
	return JSON.parse(reply!);
}

async function callTool(
	tools: McpTools,
	name: string,
	args?: unknown,
): Promise<{
	text: string;
	isError: boolean;
	data: any;
}> {
	const {result} = await send(tools, 'tools/call', {name, arguments: args});
	expect(result.content).toHaveLength(1);
	expect(result.content[0].type).toBe('text');
	const text: string = result.content[0].text;
	return {
		text,
		isError: result.isError === true,
		data: result.isError ? undefined : JSON.parse(text),
	};
}

const noTools: McpTools = {
	async searchMemory() {
		throw new Error('unused');
	},
	async why() {
		throw new Error('unused');
	},
	async workstream() {
		throw new Error('unused');
	},
};

test('initialize echoes a known protocol version', async () => {
	for (const protocolVersion of [
		'2025-11-25',
		'2025-06-18',
		'2025-03-26',
		'2024-11-05',
	]) {
		const {id, result} = await send(noTools, 'initialize', {
			protocolVersion,
			capabilities: {},
			clientInfo: {name: 'test', version: '1'},
		});
		expect(id).toBe(1);
		expect(result.protocolVersion).toBe(protocolVersion);
		expect(result.capabilities).toEqual({tools: {}});
		expect(result.serverInfo.name).toBe('chamoji');
	}
});

test('initialize answers the latest for an unknown one', async () => {
	for (const params of [
		{protocolVersion: '1999-01-01'},
		{protocolVersion: 7},
		{},
		undefined,
	]) {
		const {result} = await send(noTools, 'initialize', params);
		expect(result.protocolVersion).toBe('2025-11-25');
	}
});

test('tools/list names exactly three tools', async () => {
	const {result} = await send(noTools, 'tools/list');
	expect(result.tools.map((tool: {name: string}) => tool.name)).toEqual([
		'search_memory',
		'why',
		'workstream',
	]);
	for (const tool of result.tools) {
		expect(tool.description).toEqual(expect.any(String));
		expect(tool.inputSchema.type).toBe('object');
		expect(tool.annotations.readOnlyHint).toBe(true);
	}
});

test('ping answers with an empty result', async () => {
	expect(await send(noTools, 'ping')).toEqual({
		jsonrpc: '2.0',
		id: 1,
		result: {},
	});
});

test('each tool returns its data as text content', async () => {
	const dir = await project();
	const tools = createTools(dir);

	const found = await callTool(tools, 'search_memory', {query: 'sessions'});
	expect(found.isError).toBe(false);
	const [top] = found.data.hits as MemoryHit[];
	expect(top?.title).toBe('✨ Add login');
	expect(top?.card?.why).toEqual(['the old form leaked sessions']);

	const limited = await callTool(tools, 'search_memory', {
		query: 'login footer',
		limit: 1,
	});
	expect(limited.data.hits).toHaveLength(1);

	const why = await callTool(tools, 'why', {file: 'src/a.ts', line: 2});
	expect(why.isError).toBe(false);
	expect(why.data).toMatchObject({
		kind: 'commit',
		subject: '✨ Add login',
		card: {why: ['the old form leaked sessions'], gotcha: ['order matters']},
		workstream: {slug: 'auth', title: 'Auth revamp', status: 'shipped'},
	});
	expect(why.data.hash).toMatch(/^[0-9a-f]{40}$/);
	expect(why.text).not.toContain('@');

	const byName = await callTool(tools, 'workstream', {slug: 'auth'});
	expect(byName.data.workstream).toMatchObject({
		slug: 'auth',
		title: 'Auth revamp',
		status: 'shipped',
		memory: {commitCount: 1},
	});
	expect(byName.data.workstream.memory.commits[0].card.why).toEqual([
		'the old form leaked sessions',
	]);

	// No slug and none active: the list.
	const list = await callTool(tools, 'workstream', {});
	expect(
		list.data.workstreams.map((item: {slug: string}) => item.slug),
	).toEqual(['auth', 'billing']);

	await setActive(dir, 'billing');
	const active = await callTool(tools, 'workstream');
	expect(active.data.workstream).toMatchObject({
		slug: 'billing',
		title: 'Billing',
		active: true,
	});
});

test('a commit with no card still returns its subject and body', async () => {
	const dir = await project();
	const {data} = await callTool(createTools(dir), 'why', {
		file: 'src/b.ts',
		line: 1,
	});
	expect(data.subject).toBe('🐛 Fix footer');
	expect(data.body).toContain('overlapped the cookie banner');
	expect(data.card).toBeUndefined();
});

test('a line that is not committed yet says so', async () => {
	const dir = await project();
	await writeFile(path.join(dir, 'src/b.ts'), 'alpha\nbeta\ngamma\n');
	const {data} = await callTool(createTools(dir), 'why', {
		file: 'src/b.ts',
		line: 3,
	});
	expect(data).toEqual({kind: 'uncommitted', file: 'src/b.ts', line: 3});
});

test('an unknown method returns -32601', async () => {
	const reply = await send(noTools, 'resources/list');
	expect(reply).toEqual({
		jsonrpc: '2.0',
		id: 1,
		error: {code: -32601, message: expect.stringContaining('resources/list')},
	});
});

test('names on the object prototype are unknown, not looked up', async () => {
	for (const name of [
		'constructor',
		'__proto__',
		'toString',
		'hasOwnProperty',
	]) {
		const method = await send(noTools, name);
		expect(method.error.code).toBe(-32601);
		const tool = await send(noTools, 'tools/call', {name});
		expect(tool.error.code).toBe(-32602);
		expect(tool.error.message).toContain('Unknown tool');
	}
});

test('bad JSON returns -32700', async () => {
	for (const line of ['{nope', '{"jsonrpc":"2.0","id":1,', 'undefined']) {
		expect(JSON.parse((await handleMessage(line, noTools))!)).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: {code: -32700, message: expect.any(String)},
		});
	}
});

test('JSON that is not a request returns -32600', async () => {
	for (const line of [
		'null',
		'7',
		'"hi"',
		'[]',
		'[{"jsonrpc":"2.0","id":1,"method":"ping"}]',
		'{"jsonrpc":"1.0","id":1,"method":"ping"}',
		'{"jsonrpc":"2.0","id":1}',
		'{"jsonrpc":"2.0","id":1,"method":7}',
		'{"jsonrpc":"2.0","id":{},"method":"ping"}',
		'{"jsonrpc":"2.0","id":null,"method":"ping"}',
	]) {
		const reply = JSON.parse((await handleMessage(line, noTools))!);
		expect(reply.error.code, line).toBe(-32600);
		// The id comes back when there is a usable one.
		const {id} = JSON.parse(line) ?? {};
		expect(reply.id, line).toBe(
			typeof id === 'string' || typeof id === 'number' ? id : null,
		);
	}
});

test('a request id of any valid type is echoed', async () => {
	for (const id of ['abc', 0, 12.5]) {
		const reply = JSON.parse(
			(await handleMessage(request('ping', undefined, id), noTools))!,
		);
		expect(reply.id).toBe(id);
	}
});

test('a notification gets no reply', async () => {
	for (const message of [
		{jsonrpc: '2.0', method: 'notifications/initialized'},
		{jsonrpc: '2.0', method: 'notifications/cancelled', params: {}},
		{jsonrpc: '2.0', method: 'no/such/thing'},
		{jsonrpc: '2.0', method: 'tools/call', params: {name: 'nope'}},
		{jsonrpc: '2.0', id: 3, result: {}},
		{jsonrpc: '2.0', id: 3, error: {code: 1, message: 'x'}},
	]) {
		expect(await handleMessage(JSON.stringify(message), noTools)).toBe(
			undefined,
		);
	}
});

test('tools/call needs a tool name', async () => {
	for (const params of [undefined, null, [], 'why', {}, {name: 7}]) {
		const reply = await send(noTools, 'tools/call', params);
		expect(reply.error.code).toBe(-32602);
	}
});

test('bad arguments give isError true, never a crash', async () => {
	const dir = await project();
	const tools = createTools(dir);
	const bad: Array<[string, unknown]> = [
		['search_memory', undefined],
		['search_memory', null],
		['search_memory', []],
		['search_memory', 'login'],
		['search_memory', {}],
		['search_memory', {query: 7}],
		['search_memory', {query: ''}],
		['search_memory', {query: '   '}],
		['search_memory', {query: 'login', limit: '5'}],
		['search_memory', {query: 'login', limit: 1.5}],
		['search_memory', {query: 'login', limit: 0}],
		['search_memory', {query: 'login', limit: -1}],
		['search_memory', {query: 'login', limit: 51}],
		['search_memory', {query: 'login', limit: 1e9}],
		['search_memory', {query: 'login', limit: null}],
		['why', undefined],
		['why', {}],
		['why', {line: 1}],
		['why', {file: 'src/a.ts'}],
		['why', {file: '', line: 1}],
		['why', {file: 7, line: 1}],
		['why', {file: ['src/a.ts'], line: 1}],
		['why', {file: 'src/a.ts\u0000', line: 1}],
		['why', {file: 'src/a.ts', line: '1'}],
		['why', {file: 'src/a.ts', line: 1.5}],
		['why', {file: 'src/a.ts', line: 0}],
		['why', {file: 'src/a.ts', line: -3}],
		['why', {file: 'src/a.ts', line: 1e300}],
		['why', {file: 'src/a.ts', line: null}],
		['workstream', []],
		['workstream', 'auth'],
		['workstream', {slug: 7}],
		['workstream', {slug: ''}],
		['workstream', {slug: 'Not A Slug'}],
		['workstream', {slug: '../auth'}],
		['workstream', {slug: 'nope'}],
	];
	for (const [name, args] of bad) {
		const {isError, text} = await callTool(tools, name, args);
		expect(isError, `${name} ${JSON.stringify(args)}`).toBe(true);
		expect(text.length).toBeGreaterThan(0);
	}
});

test('a path outside the repo gives isError true', async () => {
	const dir = await project();
	const tools = createTools(dir);
	const outside = path.join(path.dirname(dir), 'elsewhere.txt');
	for (const file of ['../elsewhere.txt', outside, '/etc/passwd']) {
		const {isError, text} = await callTool(tools, 'why', {file, line: 1});
		expect(isError, file).toBe(true);
		expect(text, file).toMatch(/outside repository|No such file/i);
	}
});

test('a file named like an option is a file, not an option', async () => {
	const dir = await project();
	const {isError, text} = await callTool(createTools(dir), 'why', {
		file: '--contents=src/a.ts',
		line: 1,
	});
	expect(isError).toBe(true);
	expect(text).toMatch(/No such file/);
});

test('a missing file or a line past the end gives isError true', async () => {
	const dir = await project();
	const tools = createTools(dir);
	expect((await callTool(tools, 'why', {file: 'nope.ts', line: 1})).text).toBe(
		'No such file in HEAD: nope.ts',
	);
	expect(
		(await callTool(tools, 'why', {file: 'src/b.ts', line: 99})).text,
	).toBe('src/b.ts has 2 lines');
});

test('outside a git repository every tool gives isError true', async () => {
	loose = await mkdtemp(path.join(tmpdir(), 'chamoji-mcp-'));
	const tools = createTools(loose);
	for (const [name, args] of [
		['search_memory', {query: 'x'}],
		['why', {file: 'a', line: 1}],
		['workstream', {}],
	] as const) {
		const {isError, text} = await callTool(tools, name, args);
		expect(isError, name).toBe(true);
		expect(text).toContain('Not a git repository');
	}
});

/** Adds `file` to the memory ref's tree as a new commit, keeping everything already there. */
async function plantFile(
	dir: string,
	file: string,
	text: string,
): Promise<void> {
	const head = (
		await gitOutput(dir, ['rev-parse', '--verify', '-q', MEMORY_REF]).catch(
			() => '',
		)
	).trim();
	const tree =
		head === '' ? new Map<string, string>() : await readTree(dir, head);
	tree.set(
		file,
		(await runGitWithInput(['hash-object', '-w', '--stdin'], dir, text)).trim(),
	);
	const commit = await writeTree(
		dir,
		tree,
		head === '' ? [] : [head],
		'Planted',
	);
	await gitOutput(dir, ['update-ref', MEMORY_REF, commit]);
}

/** Points the memory ref at an entry that is not JSON. */
async function plantDamagedEntry(dir: string): Promise<void> {
	await plantFile(dir, 'workstreams/broken.json', '{not json');
}

/** Runs the server on a fake stdin and returns what it wrote. */
async function serve(
	chunks: string[],
	options: {
		cwd?: string;
		ai?: boolean;
		reranker?: Parameters<typeof runMcp>[2];
	} = {},
) {
	const stdin = new PassThrough();
	let stdout = '';
	let stderr = '';
	const done = runMcp(
		{ai: options.ai},
		{
			cwd: options.cwd ?? process.cwd(),
			stdout: text => (stdout += text),
			stderr: text => (stderr += text),
			stdin,
		},
		options.reranker,
	);
	for (const chunk of chunks) stdin.write(chunk);
	stdin.end();
	const code = await done;
	return {
		code,
		stdout,
		stderr,
		replies: stdout
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line)),
	};
}

test('a corrupt memory entry gives isError true and the server keeps answering', async () => {
	const dir = await project();
	await plantDamagedEntry(dir);
	const {code, replies, stderr} = await serve(
		[
			`${request('tools/call', {name: 'workstream', arguments: {slug: 'broken'}}, 1)}\n`,
			`${request('tools/call', {name: 'search_memory', arguments: {query: 'login'}}, 2)}\n`,
			`${request('ping', undefined, 3)}\n`,
		],
		{cwd: dir},
	);
	expect(code).toBe(0);
	expect(stderr).toBe('');
	expect(replies.map(reply => reply.id)).toEqual([1, 2, 3]);
	expect(replies[0].result.isError).toBe(true);
	expect(replies[0].result.content[0].text).toContain('damaged');
	expect(replies[1].result.isError).not.toBe(true);
	expect(replies[2].result).toEqual({});
});

test('requests are answered one at a time, in order', async () => {
	const dir = await project();
	const lines = [
		request('initialize', {protocolVersion: '2025-06-18'}, 'a'),
		JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
		request(
			'tools/call',
			{name: 'why', arguments: {file: 'src/a.ts', line: 1}},
			'b',
		),
		request('tools/list', undefined, 'c'),
		request('ping', undefined, 'd'),
	];
	// All in one chunk, and again split mid-line.
	const joined = `${lines.join('\n')}\n`;
	for (const chunks of [[joined], [joined.slice(0, 77), joined.slice(77)]]) {
		const {replies} = await serve(chunks, {cwd: dir});
		expect(replies.map(reply => reply.id)).toEqual(['a', 'b', 'c', 'd']);
	}
});

test('the last line is answered even with no newline, and a close resolves', async () => {
	const {code, replies} = await serve([request('ping')]);
	expect(code).toBe(0);
	expect(replies).toEqual([{jsonrpc: '2.0', id: 1, result: {}}]);
	expect((await serve([])).replies).toEqual([]);
});

test('blank lines and CRLF are tolerated', async () => {
	const {replies} = await serve([
		`\n  \n${request('ping', undefined, 1)}\r\n\r\n`,
	]);
	expect(replies.map(reply => reply.id)).toEqual([1]);
});

test('a very long line and malformed input do not stop the server', async () => {
	const huge = `{"jsonrpc":"2.0","id":9,"method":"ping","params":"${'x'.repeat(3 * 1024 * 1024)}"}`;
	const {code, replies} = await serve([
		'not json at all\n',
		'\u0000\u0001\u0002\n',
		// The long line arrives in pieces, then ends.
		huge.slice(0, 1_500_000),
		huge.slice(1_500_000),
		'\n',
		`${request('ping', undefined, 'after')}\n`,
	]);
	expect(code).toBe(0);
	expect(replies.map(reply => reply.error?.code ?? reply.id)).toEqual([
		-32700,
		-32700,
		-32600,
		'after',
	]);
});

test('a long line with no newline at the end of input does not stop it either', async () => {
	const {code, replies} = await serve(['y'.repeat(2 * 1024 * 1024)]);
	expect(code).toBe(0);
	expect(replies.map(reply => reply.error.code)).toEqual([-32600]);
});

test('multi-byte text split across chunks survives', async () => {
	const dir = await project();
	const bytes = Buffer.from(
		`${request('tools/call', {name: 'search_memory', arguments: {query: '🔐 Auth revamp'}}, 1)}\n`,
	);
	const stdin = new PassThrough();
	let stdout = '';
	const done = runMcp(
		{},
		{cwd: dir, stdout: text => (stdout += text), stderr() {}, stdin},
	);
	const cut = bytes.indexOf(Buffer.from('🔐')) + 2;
	stdin.write(bytes.subarray(0, cut));
	stdin.write(bytes.subarray(cut));
	stdin.end();
	await done;
	const hits = JSON.parse(JSON.parse(stdout).result.content[0].text).hits;
	expect(hits[0].id).toBe('auth');
});

test('--ai with no key warns on stderr and stays on BM25', async () => {
	const dir = await project();
	const {stderr, replies} = await serve(
		[
			`${request('tools/call', {name: 'search_memory', arguments: {query: 'login'}}, 1)}\n`,
		],
		{cwd: dir, ai: true, reranker: async () => undefined},
	);
	expect(stderr).toBe(
		`chamoji: ${MISSING_KEY}; search_memory stays on keyword order\n`,
	);
	const {hits} = JSON.parse(replies[0].result.content[0].text);
	expect(hits[0].title).toBe('✨ Add login');
});

test('--ai with a key that cannot be used warns and stays on BM25', async () => {
	const {stderr, replies} = await serve([`${request('ping')}\n`], {
		ai: true,
		reranker() {
			throw new Error('TYPESAFE_API_KEY contains "…", so it looks truncated');
		},
	});
	expect(stderr).toContain('looks truncated');
	expect(stderr).toContain('keyword order');
	expect(replies).toHaveLength(1);
});

test('without --ai the reranker is never asked for', async () => {
	const {stderr} = await serve([], {
		reranker() {
			throw new Error('should not be called');
		},
	});
	expect(stderr).toBe('');
});

test('--ai reranks a pool of ten, then cuts to the limit', async () => {
	const dir = await project();
	const seen: MemoryHit[][] = [];
	const {replies} = await serve(
		[
			`${request('tools/call', {name: 'search_memory', arguments: {query: 'login footer', limit: 1}}, 1)}\n`,
		],
		{
			cwd: dir,
			ai: true,
			reranker: async () => async (_query, hits) => {
				seen.push(hits);
				return [...hits].reverse();
			},
		},
	);
	// A limit of one still ranked everything that matched, once.
	expect(seen).toHaveLength(1);
	expect(seen[0]!.length).toBeGreaterThan(1);
	const {hits} = JSON.parse(replies[0].result.content[0].text);
	expect(hits).toHaveLength(1);
	expect(hits[0].id).toBe(seen[0]!.at(-1)!.id);
});

test('a reranker that fails leaves the keyword order', async () => {
	const dir = await project();
	const {replies} = await serve(
		[
			`${request('tools/call', {name: 'search_memory', arguments: {query: 'login'}}, 1)}\n`,
		],
		{
			cwd: dir,
			ai: true,
			reranker: async () => async () => {
				throw new Error('boom');
			},
		},
	);
	const {hits} = JSON.parse(replies[0].result.content[0].text);
	expect(hits[0].title).toBe('✨ Add login');
});

/** Spawns the built CLI and talks to it over its pipes. */
async function spawnServer(
	cwd: string,
	args: string[],
	input: string,
	env: NodeJS.ProcessEnv = {},
) {
	const child = spawn(process.execPath, [cliJs, 'mcp', ...args], {
		cwd,
		env: {...process.env, TYPESAFE_API_KEY: '', ...env},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', chunk => (stdout += String(chunk)));
	child.stderr.on('data', chunk => (stderr += String(chunk)));
	const exited = new Promise<number | null>(resolve => {
		child.on('close', resolve);
	});
	child.stdin.end(input);
	return {code: await exited, stdout, stderr};
}

test('stdout carries only JSON-RPC', async () => {
	const dir = await project();
	const {code, stdout, stderr} = await spawnServer(
		dir,
		[],
		[
			request('initialize', {protocolVersion: '2025-11-25'}, 1),
			JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
			request(
				'tools/call',
				{name: 'why', arguments: {file: 'src/a.ts', line: 1}},
				2,
			),
			request(
				'tools/call',
				{name: 'search_memory', arguments: {query: 'login'}},
				3,
			),
			'',
		].join('\n'),
	);
	expect(code).toBe(0);
	expect(stderr).toBe('');
	const lines = stdout.split('\n');
	expect(lines.pop()).toBe('');
	expect(lines).toHaveLength(3);
	const replies = lines.map(line => JSON.parse(line));
	expect(replies.map(reply => reply.id)).toEqual([1, 2, 3]);
	for (const reply of replies) expect(reply.jsonrpc).toBe('2.0');
	expect(JSON.parse(replies[1].result.content[0].text).subject).toBe(
		'✨ Add login',
	);
});

test('the built CLI with --ai and no key warns once and answers from BM25', async () => {
	const dir = await project();
	const {code, stdout, stderr} = await spawnServer(
		dir,
		['--ai'],
		`${request('tools/call', {name: 'search_memory', arguments: {query: 'login'}}, 1)}\n`,
	);
	expect(code).toBe(0);
	expect(stderr).toBe(
		`chamoji: ${MISSING_KEY}; search_memory stays on keyword order\n`,
	);
	const {hits} = JSON.parse(JSON.parse(stdout).result.content[0].text);
	expect(hits[0].title).toBe('✨ Add login');
});

test('chamoji mcp takes no arguments', async () => {
	const dir = await project();
	const {code, stdout, stderr} = await spawnServer(dir, ['extra'], '');
	expect(code).toBe(2);
	expect(stdout).toBe('');
	expect(stderr).toContain('mcp takes no arguments');
});

test('an oversized card and subject are cut, and the reply says so', async () => {
	// Argument size limits keep one commit message small, so the card is many lines.
	const lines = (key: string) =>
		Array.from(
			{length: 22},
			(_, index) => `${key}: line${index} ${'w'.repeat(2500)}`,
		).join('\n');
	repo = await createRepo([
		{
			commit: `✨ ${'S'.repeat(700)}`,
			body: `${lines('Why')}\n${lines('Gotcha')}`,
			files: {'src/a.ts': 'one\n'},
		},
	]);
	const tools = createTools(repo.dir);

	const why = await callTool(tools, 'why', {file: 'src/a.ts', line: 1});
	expect(why.data.truncated).toBe(true);
	expect(why.data.subject.length).toBeLessThanOrEqual(500);
	expect(why.data.card.why).toHaveLength(20);
	expect(why.data.card.gotcha).toHaveLength(20);
	for (const line of [...why.data.card.why, ...why.data.card.gotcha]) {
		expect(line.length).toBeLessThanOrEqual(500);
	}

	expect(why.data.body.length).toBeLessThanOrEqual(4000);
	expect(why.text.length).toBeLessThan(100_000);

	const found = await callTool(tools, 'search_memory', {query: 'line3'});
	const [hit] = found.data.hits;
	expect(found.data.truncated).toBe(true);
	expect(hit.title.length).toBeLessThanOrEqual(500);
	expect(hit.card.why).toHaveLength(20);
	expect(hit.card.why[0].length).toBeLessThanOrEqual(500);
	expect(found.text.length).toBeLessThan(100_000);
});

test('search_memory drops trailing hits to stay within 100 KB', async () => {
	const card = Array.from(
		{length: 20},
		(_, index) => `Why: reason${index} ${'v'.repeat(480)}`,
	).join('\n');
	repo = await createRepo(
		Array.from({length: 14}, (_, index) => ({
			commit: `✨ Add widget ${index}`,
			body: card,
		})),
	);
	const {data, text} = await callTool(createTools(repo.dir), 'search_memory', {
		query: 'widget',
		limit: 50,
	});
	expect(text.length).toBeLessThanOrEqual(100_000);
	expect(data.truncated).toBe(true);
	expect(data.hits.length).toBeGreaterThan(0);
	expect(data.hits.length).toBeLessThan(14);
});

test('a long workstream and an oversized title are cut too', async () => {
	repo = await createRepo([
		{
			commit: '🎉 Init',
			files: {
				'.chamoji/workstreams.yml': `workstreams:\n  auth:\n    title: ${'T'.repeat(700)}\n    status: shipped\n`,
			},
		},
		...Array.from({length: 55}, (_, index) => ({
			commit: `✨ Add step ${index}`,
			body: `Why: ${'r'.repeat(900)}\nWorkstream: auth`,
		})),
	]);
	await snapshotWorkstream(repo.dir, 'auth');
	const {data, text} = await callTool(createTools(repo.dir), 'workstream', {
		slug: 'auth',
	});
	expect(data.truncated).toBe(true);
	expect(data.workstream.title.length).toBeLessThanOrEqual(500);
	expect(data.workstream.memory.commitCount).toBe(55);
	expect(data.workstream.memory.commits).toHaveLength(50);
	expect(
		data.workstream.memory.commits[0].card.why[0].length,
	).toBeLessThanOrEqual(500);
	expect(text.length).toBeLessThanOrEqual(100_000);
});

test('a small reply carries no truncated flag', async () => {
	const dir = await project();
	const {data} = await callTool(createTools(dir), 'why', {
		file: 'src/a.ts',
		line: 1,
	});
	expect(data).not.toHaveProperty('truncated');
});

test('why leaves out the trailer block and any address in the body', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			body: [
				'Why: the form leaked',
				'',
				'Thanks to carol@example.com for the report.',
				'',
				'Co-Authored-By: Eve <eve@example.com>',
				'Signed-off-by: Bob <bob@example.com>',
			].join('\n'),
			files: {'src/a.ts': 'one\n'},
		},
	]);
	const {data, text} = await callTool(createTools(repo.dir), 'why', {
		file: 'src/a.ts',
		line: 1,
	});
	expect(text).not.toMatch(/example\.com|Eve|Bob|Co-Authored|Signed-off/);
	expect(data.body).toContain('Thanks to <email> for the report.');
	expect(data.card.why).toEqual(['the form leaked']);
});

test('why scans only the start of a huge body for addresses', async () => {
	repo = await createRepo([
		{
			commit: '✨ Add a',
			// 25 KB: over both caps, under the limit on one argument (128 KB on
			// Linux) and on a whole command line (32 KB on Windows).
			body: `${'word '.repeat(5000)}\nMail carol@example.com`,
			files: {'src/a.ts': 'one\n'},
		},
	]);
	vi.mocked(redact).mockClear();
	const {data} = await callTool(createTools(repo.dir), 'why', {
		file: 'src/a.ts',
		line: 1,
	});
	const seen = vi.mocked(redact).mock.calls.map(([text]) => text.length);
	expect(seen.length).toBeGreaterThan(0);
	expect(Math.max(...seen)).toBeLessThanOrEqual(8000);
	expect(data.body.length).toBeLessThanOrEqual(4000);
	expect(data.truncated).toBe(true);
});

test('U+2028 and U+2029 are escaped, so a reply stays one line', async () => {
	const tools: McpTools = {
		...noTools,
		async why() {
			return {kind: 'commit', subject: 'a\u2028b\u2029c'};
		},
	};
	const reply = (await handleMessage(
		request('tools/call', {name: 'why', arguments: {file: 'x', line: 1}}),
		tools,
	))!;
	expect(reply).not.toMatch(/[\u2028\u2029]/);
	expect(reply).toContain(String.raw`\u2028`);
	expect(JSON.parse(JSON.parse(reply).result.content[0].text).subject).toBe(
		'a\u2028b\u2029c',
	);

	const error = (await handleMessage(request('x\u2028y\u2029z'), noTools))!;
	expect(error).not.toMatch(/[\u2028\u2029]/);
	// An echoed method name is cleaned like any text printed from outside, so
	// the separators are gone from it rather than escaped.
	expect(JSON.parse(error).error.message).toBe('Method not found: xyz');
});

test('initialize and every tool say returned text is data, not instructions', async () => {
	const {result} = await send(noTools, 'initialize', {
		protocolVersion: '2025-11-25',
	});
	expect(result.instructions).toMatch(/written by other people/);
	expect(result.instructions).toMatch(/never as instructions/);
	const {result: listed} = await send(noTools, 'tools/list');
	for (const tool of listed.tools) {
		expect(tool.description, tool.name).toMatch(/written by other people/);
		expect(tool.description, tool.name).toMatch(/never as instructions/);
	}
});

const LEAK = [
	'workstreams:',
	'  leak:',
	'    title: LEAKED from outside the repo',
	'    status: active',
	'',
].join('\n');

test.skipIf(process.platform === 'win32')(
	'a workstreams file that is a symlink is not read through, and memory still answers',
	async () => {
		const dir = await project();
		const target = `${dir}.outside.yml`;
		await writeFile(target, LEAK);
		await rm(path.join(dir, '.chamoji/workstreams.yml'));
		await symlink(target, path.join(dir, '.chamoji/workstreams.yml'));
		try {
			const tools = createTools(dir);
			const known = await callTool(tools, 'workstream', {slug: 'auth'});
			expect(known.isError).toBe(false);
			expect(known.data.workstream.title).toBe('Auth revamp');
			const leak = await callTool(tools, 'workstream', {slug: 'leak'});
			expect(leak.isError).toBe(true);
			expect(leak.text).not.toContain('LEAKED');
			const list = await callTool(tools, 'workstream', {});
			expect(list.text).not.toContain('LEAKED');
			expect(
				list.data.workstreams.map((item: {slug: string}) => item.slug),
			).toEqual(['auth']);
		} finally {
			await rm(target, {force: true});
		}
	},
);

test.skipIf(process.platform === 'win32')(
	'a .chamoji folder that is a symlink is not read through either',
	async () => {
		const dir = await project();
		const outside = `${dir}.outside`;
		await mkdir(outside);
		await writeFile(path.join(outside, 'workstreams.yml'), LEAK);
		await rm(path.join(dir, '.chamoji'), {recursive: true});
		await symlink(outside, path.join(dir, '.chamoji'));
		try {
			const list = await callTool(createTools(dir), 'workstream', {});
			expect(list.text).not.toContain('LEAKED');
			expect(
				list.data.workstreams.map((item: {slug: string}) => item.slug),
			).toEqual(['auth']);
		} finally {
			await rm(outside, {recursive: true, force: true});
		}
	},
);

test('a broken workstreams file leaves memory to answer', async () => {
	const dir = await project();
	await writeFile(path.join(dir, '.chamoji/workstreams.yml'), 'a: [\n');
	const tools = createTools(dir);
	const known = await callTool(tools, 'workstream', {slug: 'auth'});
	expect(known.isError).toBe(false);
	expect(known.data.workstream).toMatchObject({
		title: 'Auth revamp',
		status: 'shipped',
		memory: {commitCount: 1},
	});
	const list = await callTool(tools, 'workstream', {});
	expect(list.isError).toBe(false);
	expect(
		list.data.workstreams.map((item: {slug: string}) => item.slug),
	).toEqual(['auth']);
});

test('a damaged memory entry stays out of the workstream list', async () => {
	const dir = await project();
	await plantDamagedEntry(dir);
	const list = await callTool(createTools(dir), 'workstream', {});
	expect(list.isError).toBe(false);
	expect(
		list.data.workstreams.map((item: {slug: string}) => item.slug),
	).toEqual(['auth', 'billing']);
});

test('a damaged entry for the active workstream leaves the working tree to answer', async () => {
	const dir = await project();
	await snapshotWorkstream(dir, 'billing');
	await plantFile(dir, 'workstreams/billing.json', '{not json');
	await setActive(dir, 'billing');
	const tools = createTools(dir);
	for (const args of [{}, {slug: 'billing'}]) {
		const {isError, data} = await callTool(tools, 'workstream', args);
		expect(isError).toBe(false);
		expect(data.workstream).toMatchObject({
			slug: 'billing',
			title: 'Billing',
			memoryDamaged: true,
		});
		expect(data.workstream.memory).toBeUndefined();
	}
});

test('a damaged search index is rebuilt and the search still answers', async () => {
	const dir = await project();
	const tools = createTools(dir);
	await callTool(tools, 'search_memory', {query: 'login'});
	const gitDir = (
		await gitOutput(dir, ['rev-parse', '--absolute-git-dir'])
	).trim();
	const file = path.join(gitDir, 'chamoji', 'memory-index.json');
	for (const damage of ['{not json', '', 'null', '[]']) {
		await writeFile(file, damage);
		const {isError, data} = await callTool(tools, 'search_memory', {
			query: 'login',
		});
		expect(isError, damage).toBe(false);
		expect(data.hits[0].title, damage).toBe('✨ Add login');
	}
});
