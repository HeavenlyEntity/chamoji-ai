import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {
	MEMORY_REF,
	runGitWithInput,
	setActive,
	snapshotWorkstream,
	writeTree,
	type MemoryHit,
} from '@chamoji/core';
import {afterEach, expect, test} from 'vitest';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from '../../core/test/helpers/fixture-repo.js';
import {MISSING_KEY} from '../src/env.js';
import {createTools, handleMessage, runMcp, type McpTools} from '../src/mcp.js';

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

/** Points the memory ref at an entry that is not JSON, beside a good one. */
async function plantDamagedEntry(dir: string): Promise<void> {
	const tree = new Map<string, string>();
	const write = async (file: string, text: string) =>
		tree.set(
			file,
			(
				await runGitWithInput(['hash-object', '-w', '--stdin'], dir, text)
			).trim(),
		);
	await write('workstreams/broken.json', '{not json');
	const commit = await writeTree(dir, tree, [], 'Planted');
	await gitOutput(dir, ['update-ref', MEMORY_REF, commit]);
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
