#!/usr/bin/env node
// Builds and serves the brand preview: the Iridescence foil, the logo plate
// and the Marow Block display type. It also prints each framework icon in
// its brand colour, large and as a dot, so the generated icons can be
// checked. TSX is transpiled with the TypeScript we already depend on; React
// comes from esm.sh via an import map.
//
//   pnpm brand:preview [--port 4173]
import {copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const brand = path.join(root, 'docs/brand');
const out = path.join(brand, '.preview');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

const {values} = parseArgs({
	options: {port: {type: 'string', default: '4173'}},
});
const port = Number(values.port);

async function build() {
	for (const dir of ['components', 'preview']) {
		await mkdir(path.join(out, dir), {recursive: true});
		for (const file of await readdir(path.join(brand, dir))) {
			const source = path.join(brand, dir, file);
			if (file.endsWith('.tsx')) {
				const {outputText} = ts.transpileModule(
					await readFile(source, 'utf8'),
					{
						compilerOptions: {
							jsx: ts.JsxEmit.ReactJSX,
							module: ts.ModuleKind.ESNext,
							target: ts.ScriptTarget.ES2022,
						},
						fileName: file,
					},
				);
				await writeFile(
					path.join(out, dir, file.replace(/\.tsx$/, '.js')),
					outputText,
				);
			} else if (file.endsWith('.html')) {
				await copyFile(source, path.join(out, dir, file));
			}
		}
	}
}

// The generated icon strings, as the CLI will draw them. The file is
// TypeScript, so it's transpiled and imported from a data URL.
async function printIcons() {
	const file = path.join(root, 'packages/cli/src/framework-icons.ts');
	const {outputText} = ts.transpileModule(await readFile(file, 'utf8'), {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const {FRAMEWORK_ICONS} = await import(
		`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
	);
	for (const [id, {hex, large}] of Object.entries(FRAMEWORK_ICONS)) {
		const [r, g, b] = [1, 3, 5].map(i =>
			Number.parseInt(hex.slice(i, i + 2), 16),
		);
		const color = text => `\u001B[38;2;${r};${g};${b}m${text}\u001B[39m`;
		console.log(`${id} ${hex}  ${color('●')}`);
		for (const row of large) console.log(`  ${color(row)}`);
	}
}

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.png': 'image/png',
};

await build();
await printIcons();
createServer(async (request, response) => {
	const {pathname} = new URL(request.url ?? '/', 'http://localhost');
	if (pathname === '/') {
		response.writeHead(302, {location: '/.preview/preview/index.html'});
		response.end();
		return;
	}

	// Only serve files inside docs/brand.
	const file = path.normalize(path.join(brand, decodeURIComponent(pathname)));
	if (!file.startsWith(brand + path.sep)) {
		response.writeHead(403).end();
		return;
	}

	try {
		const body = await readFile(file);
		response.writeHead(200, {
			'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
			'cache-control': 'no-store',
		});
		response.end(body);
	} catch {
		response.writeHead(404).end('Not found');
	}
}).listen(port, '127.0.0.1', () => {
	console.log(`Brand preview: http://localhost:${port}/`);
});
