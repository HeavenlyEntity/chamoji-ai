#!/usr/bin/env node
// Generates packages/cli/src/framework-icons.ts: each framework's brand mark
// as an 8x4 block of quadrant characters, plus its brand colour. The marks
// come from the simple-icons (CC0) and @phosphor-icons/core (MIT) dev
// dependencies, so the SVGs are never committed and the CLI never reads one.
// Only the generated strings ship.
//
//   pnpm icons:generate
//
// Geometry is in pixels at 2x2 per terminal cell, so an icon is 16x8 pixels.
// A terminal cell is about twice as tall as it is wide, so those pixels come
// out square and the 24x24 mark is stretched to fill the whole grid. It's
// drawn at 12x and box-averaged down. A pixel is on above 45% coverage, but
// thin strokes (React's orbits, Electron's rings) would vanish at that, so the
// cut-off drops in steps, down to 10%, until the pixels on cover at least 90%
// of the area the mark really fills.
import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {createCanvas, Path2D} from '@napi-rs/canvas';

const root = fileURLToPath(new URL('..', import.meta.url));
const outPath = path.join(root, 'packages/cli/src/framework-icons.ts');
const require = createRequire(path.join(root, 'package.json'));
const simpleIcons = require('simple-icons');
const phosphorRoot = path.join(root, 'node_modules/@phosphor-icons/core');

const ICON_COLUMNS = 8;
const ICON_ROWS = 4;
const SCALE = 12; // supersampling
const THRESHOLDS = [0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1];
const AREA_SHARE = 0.9;
const MIN_FILLED_CELLS = 16; // fewer and the brand mark is switched for a Phosphor icon
const PHOSPHOR_HEX = '#8a8a8a';
const QUADRANTS = ' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█'; // indexed by bits TL, TR, BL, BR

// Framework id -> 'si:<simple-icons slug>' or 'ph:<phosphor name>'. A slug
// that simple-icons doesn't have stops the run, so a fallback is always a
// choice made here. The Vite variants and meta-frameworks show the brand they
// are built on. Where there is no mark, a plain Phosphor shape stands in:
// simple-icons has no React Native, Salesforce or NetSuite/Oracle mark, and
// none is drawn by hand.
const ICON_SOURCES = {
	vite: 'si:vite',
	'vite-react': 'si:react',
	'vite-vue': 'si:vuedotjs',
	'vite-svelte': 'si:svelte',
	'vite-solid': 'si:solid',
	'vite-preact': 'si:preact',
	'vite-lit': 'si:lit',
	react: 'si:react',
	'create-react-app': 'si:createreactapp',
	next: 'si:nextdotjs',
	nuxt: 'si:nuxt',
	sveltekit: 'si:svelte',
	astro: 'si:astro',
	remix: 'si:remix',
	'react-router': 'si:reactrouter',
	hydrogen: 'si:shopify',
	qwik: 'si:qwik',
	'solid-start': 'si:solid',
	'tanstack-start': 'si:tanstack',
	gatsby: 'si:gatsby',
	docusaurus: 'si:docusaurus',
	angular: 'si:angular',
	expo: 'si:expo',
	'react-native': 'ph:device-mobile',
	capacitor: 'si:capacitor',
	tauri: 'si:tauri',
	electron: 'si:electron',
	ember: 'si:emberdotjs',
	ionic: 'si:ionic',
	nestjs: 'si:nestjs',
	express: 'si:express',
	fastify: 'si:fastify',
	hono: 'si:hono',
	koa: 'si:koa',
	'salesforce-dx': 'ph:cloud',
	'shopify-app': 'si:shopify',
	forge: 'si:atlassian',
	'netsuite-suiteapp': 'ph:cube',
	'netsuite-acp': 'ph:package',
};

// Phosphor stand-ins for the marks that are too thin to read at 8x4: used when
// a simple-icons mark fills fewer than MIN_FILLED_CELLS cells.
const ICON_FALLBACKS = {
	koa: 'ph:leaf',
	'react-router': 'ph:signpost',
	electron: 'ph:atom',
	express: 'ph:truck',
	'vite-lit': 'ph:flame',
	fastify: 'ph:rocket-launch',
	hono: 'ph:campfire',
};

const bySlug = new Map(
	Object.values(simpleIcons)
		.filter(icon => icon && typeof icon === 'object' && 'slug' in icon)
		.map(icon => [icon.slug, icon]),
);

// Reads { hex, paths, viewBox } for one source.
function load(id, source) {
	const [kind, name] = source.split(':');
	if (kind === 'si') {
		const icon = bySlug.get(name);
		if (!icon) {
			console.error(`simple-icons has no "${name}" (framework ${id})`);
			process.exit(1);
		}

		return {hex: `#${icon.hex.toLowerCase()}`, paths: [icon.path], size: 24};
	}

	if (kind === 'ph') {
		const file = path.join(phosphorRoot, 'assets/regular', `${name}.svg`);
		let svg;
		try {
			svg = readFileSync(file, 'utf8');
		} catch {
			console.error(`@phosphor-icons/core has no "${name}" (framework ${id})`);
			process.exit(1);
		}

		const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1] ?? 256);
		const paths = [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map(m => m[1]);
		return {hex: PHOSPHOR_HEX, paths, size};
	}

	console.error(`Unknown icon source "${source}" (framework ${id})`);
	process.exit(1);
}

function render({paths, size}) {
	const width = ICON_COLUMNS * 2;
	const height = ICON_ROWS * 2;
	const canvas = createCanvas(width * SCALE, height * SCALE);
	const ctx = canvas.getContext('2d');
	ctx.scale((width * SCALE) / size, (height * SCALE) / size);
	ctx.fillStyle = '#fff';
	for (const d of paths) ctx.fill(new Path2D(d));
	const {data} = ctx.getImageData(0, 0, width * SCALE, height * SCALE);

	// Box-average each 12x12 block to one pixel of coverage.
	const coverage = [];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let dy = 0; dy < SCALE; dy++) {
				for (let dx = 0; dx < SCALE; dx++) {
					sum +=
						data[((y * SCALE + dy) * width * SCALE + x * SCALE + dx) * 4 + 3];
				}
			}

			coverage.push(sum / (SCALE * SCALE) / 255);
		}
	}

	const area = coverage.reduce((sum, c) => sum + c, 0);
	let threshold = THRESHOLDS[0];
	for (const t of THRESHOLDS) {
		threshold = t;
		if (coverage.filter(c => c > t).length >= area * AREA_SHARE) break;
	}

	const pixels = [];
	for (let y = 0; y < height; y++) {
		pixels.push(
			coverage.slice(y * width, (y + 1) * width).map(c => c > threshold),
		);
	}

	const lines = [];
	for (let y = 0; y < ICON_ROWS; y++) {
		let line = '';
		for (let x = 0; x < width; x += 2) {
			let bits = 0;
			for (const [i, [dx, dy]] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			].entries()) {
				if (pixels[2 * y + dy][x + dx]) bits |= 1 << (3 - i);
			}

			line += QUADRANTS[bits];
		}

		lines.push(line);
	}

	return lines;
}

const countFilled = lines => [...lines.join('')].filter(c => c !== ' ').length;

const icons = {};
const switched = [];
for (const [id, source] of Object.entries(ICON_SOURCES)) {
	let icon = load(id, source);
	let large = render(icon);
	let used = source;
	if (source.startsWith('si:') && countFilled(large) < MIN_FILLED_CELLS) {
		used = ICON_FALLBACKS[id];
		if (!used) {
			console.error(
				`${id} (${source}) fills ${countFilled(large)} cells, under ${MIN_FILLED_CELLS}, and has no Phosphor fallback`,
			);
			process.exit(1);
		}

		icon = load(id, used);
		large = render(icon);
		switched.push(`${id} (${source} -> ${used})`);
	}

	if (countFilled(large) < MIN_FILLED_CELLS) {
		console.error(
			`${id} (${used}) fills ${countFilled(large)} cells, under ${MIN_FILLED_CELLS}; fix the source`,
		);
		process.exit(1);
	}

	icons[id] = {hex: icon.hex, large};
}

if (switched.length > 0) {
	console.log(`Too faint, using a Phosphor icon: ${switched.join(', ')}`);
}

// Phosphor's MIT licence asks for its copyright line to travel with the marks.
const phosphorCopyright = readFileSync(
	path.join(phosphorRoot, 'LICENSE'),
	'utf8',
)
	.split('\n')
	.find(line => line.startsWith('Copyright'))
	?.trim();
if (!phosphorCopyright)
	throw new Error('no copyright line in Phosphor LICENSE');

const key = id => (/^[a-z]+$/.test(id) ? id : `'${id}'`);
const body = Object.entries(icons)
	.map(
		([id, {hex, large}]) =>
			`\t${key(id)}: {\n\t\thex: '${hex}',\n\t\tlarge: [${large
				.map(line => `'${line}'`)
				.join(', ')}],\n\t},`,
	)
	.join('\n');

const source = `// Generated by scripts/framework-icons.mjs. Don't edit by hand.
// Regenerate with: pnpm icons:generate
// Marks are from simple-icons (CC0) and @phosphor-icons/core (MIT). The
// logos belong to their owners and only name the framework a project uses.
// @phosphor-icons/core: ${phosphorCopyright}

export const ICON_COLUMNS = ${ICON_COLUMNS};
export const ICON_ROWS = ${ICON_ROWS};

export type FrameworkIcon = {
	/** The brand colour as #rrggbb. */
	hex: string;
	/** ICON_ROWS strings of ICON_COLUMNS quadrant characters. */
	large: string[];
};

export const FRAMEWORK_ICONS: Record<string, FrameworkIcon> = {
${body}
};
`;

await writeFile(outPath, source);
console.log(`Wrote ${path.relative(root, outPath)}`);
