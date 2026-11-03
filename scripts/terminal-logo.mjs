#!/usr/bin/env node
// Generates packages/cli/src/logo-frames.ts: the terminal wordmark as
// quadrant-block text, one frame per face. The letters are Marow Block, so
// the font file is read from docs/brand/fonts (it isn't in git). Only the
// generated strings are committed.
//
//   pnpm logo:generate
//
// Geometry is in pixels at 2x2 per terminal cell. Everything is drawn at 12x
// and box-averaged down; a pixel is on above 85% coverage.
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {createCanvas, GlobalFonts} from '@napi-rs/canvas';

const root = fileURLToPath(new URL('..', import.meta.url));
const fontPath = path.join(root, 'docs/brand/fonts/MarowBlock-Regular.ttf');
const outPath = path.join(root, 'packages/cli/src/logo-frames.ts');

if (!existsSync(fontPath)) {
	console.error(
		"Marow Block isn't in docs/brand/fonts; see docs/brand/fonts/README.md",
	);
	process.exit(1);
}

if (!GlobalFonts.registerFromPath(fontPath, 'Marow Block')) {
	console.error(`Couldn't load ${path.relative(root, fontPath)}`);
	process.exit(1);
}

const WORD = 'chamoji';
const O_INDEX = 4;
const ROWS = 8;
const GAP = 4;
const O_WIDEN = 3; // added to each side of the O's slot
const SCALE = 12; // supersampling
const THRESHOLD = 0.85;
const QUADRANTS = ' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█'; // indexed by bits TL, TR, BL, BR

// The faces and their options. The drops are the shades sliding down.
const FACES = {
	rest: {},
	left: {},
	right: {},
	blink: {},
	wink: {},
	drop1: {shades: -0.45},
	drop2: {shades: -0.3},
	drop3: {shades: -0.15},
	shades: {shades: 0},
};

// Left eye x and y, then right eye x and y, as fractions of the hole. Blink
// and wink use the default pair, like the prototype.
const EYES = {
	rest: [0.26, 0.38, 0.64, 0.22],
	left: [0.2, 0.36, 0.56, 0.24],
	right: [0.4, 0.36, 0.76, 0.24],
	default: [0.3, 0.36, 0.66, 0.24],
};

// Pixel edits applied after rendering, so a rerun reproduces them. Each is
// [face, x, y, on] in wordmark pixels (2 per column, 2 per row; the O's cells
// start at pixel 84). Quantising can make the two eyes differ by a pixel, so
// these give each pair the same bounding box:
// - rest: the left eye is 4 wide and the right is 3, so trim the left eye's
//   extra column. Both eyes are then 3, 3, 3, 1.
// - right: the right eye is 5 rows tall and the left is 4, so drop the right
//   eye's stray bottom pixel. The mouth's tip beside it stays.
// Left already has two 4 by 4 eyes.
const TOUCH_UPS = [
	['rest', 94, 6, false],
	['rest', 94, 7, false],
	['right', 101, 7, false],
];

function roundHalfEven(value) {
	const floor = Math.floor(value);
	const diff = value - floor;
	if (diff < 0.5) return floor;
	if (diff > 0.5) return floor + 1;
	return floor % 2 === 0 ? floor : floor + 1;
}

// Renders one glyph at 600px and returns its alpha plane with ink bounds.
function glyph(char) {
	const size = 1400;
	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.font = '600px "Marow Block"';
	ctx.textBaseline = 'alphabetic';
	ctx.fillText(char, 100, 1000);
	const {data} = ctx.getImageData(0, 0, size, size);
	const alpha = new Uint8Array(size * size);
	let x0 = size;
	let y0 = size;
	let x1 = 0;
	let y1 = 0;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const a = data[(y * size + x) * 4 + 3];
			alpha[y * size + x] = a;
			// Horizontally any ink counts; vertically only half coverage does.
			// That's what reproduces the ink bounds PIL measured when the
			// wordmark was approved: the glyph edges here carry a faint extra
			// row of antialiasing that PIL's rasteriser doesn't.
			if (a > 0) {
				if (x < x0) x0 = x;
				if (x + 1 > x1) x1 = x + 1;
			}

			if (a >= 128) {
				if (y < y0) y0 = y;
				if (y + 1 > y1) y1 = y + 1;
			}
		}
	}

	return {alpha, size, box: [x0, y0, x1, y1]};
}

const lanczos = x => {
	if (x === 0) return 1;
	if (x <= -3 || x >= 3) return 0;
	const px = Math.PI * x;
	return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

// Separable Lanczos resample, the same way PIL's LANCZOS resize does it.
function resizeAxis(source, sw, sh, dw, dh, horizontal) {
	const from = horizontal ? sw : sh;
	const to = horizontal ? dw : dh;
	const scale = from / to;
	const filterScale = Math.max(scale, 1);
	const support = 3 * filterScale;
	const out = new Float64Array(dw * dh);
	for (let i = 0; i < to; i++) {
		const center = (i + 0.5) * scale;
		const lo = Math.max(0, Math.trunc(center - support + 0.5));
		const hi = Math.min(from, Math.trunc(center + support + 0.5));
		const weights = [];
		let total = 0;
		for (let j = lo; j < hi; j++) {
			const w = lanczos((j - center + 0.5) / filterScale);
			weights.push(w);
			total += w;
		}

		for (let k = 0; k < weights.length; k++) weights[k] /= total;
		if (horizontal) {
			for (let y = 0; y < dh; y++) {
				let sum = 0;
				for (let k = 0; k < weights.length; k++) {
					sum += source[y * sw + lo + k] * weights[k];
				}

				out[y * dw + i] = sum;
			}
		} else {
			for (let x = 0; x < dw; x++) {
				let sum = 0;
				for (let k = 0; k < weights.length; k++) {
					sum += source[(lo + k) * sw + x] * weights[k];
				}

				out[i * dw + x] = sum;
			}
		}
	}

	return out;
}

function resize(source, sw, sh, dw, dh) {
	const wide = resizeAxis(source, sw, sh, dw, sh, true);
	const resized = resizeAxis(wide, dw, sh, dw, dh, false);
	// PIL stores 8-bit results, so clamp and round the same way.
	for (let i = 0; i < resized.length; i++) {
		resized[i] = Math.min(255, Math.max(0, Math.round(resized[i])));
	}

	return resized;
}

const glyphs = [...WORD].map(glyph);
const top = Math.min(...glyphs.map(g => g.box[1]));
const bottom = Math.max(...glyphs.map(g => g.box[3]));
const height = ROWS * 2;
const scale = height / (bottom - top);
const widths = glyphs.map(g =>
	Math.max(1, roundHalfEven((g.box[2] - g.box[0]) * scale)),
);
widths[O_INDEX] += O_WIDEN * 2;
let width = widths.reduce((sum, w) => sum + w, 0) + GAP * (WORD.length - 1);
width += width % 2;

const slots = [];
let cursor = 0;
for (const w of widths) {
	slots.push([cursor, w]);
	cursor += w + GAP;
}

// The letters other than the O, as a 12x alpha plane. They're the same in
// every frame, so they're resampled once.
const bigWidth = width * SCALE;
const bigHeight = height * SCALE;
const letters = new Float64Array(bigWidth * bigHeight);
for (const [index, g] of glyphs.entries()) {
	if (index === O_INDEX) continue;
	const [x0, w] = slots[index];
	const [gx0, , gx1] = g.box;
	const crop = new Float64Array((gx1 - gx0) * (bottom - top));
	for (let y = 0; y < bottom - top; y++) {
		for (let x = 0; x < gx1 - gx0; x++) {
			crop[y * (gx1 - gx0) + x] = g.alpha[(top + y) * g.size + gx0 + x];
		}
	}

	const resized = resize(crop, gx1 - gx0, bottom - top, w * SCALE, bigHeight);
	for (let y = 0; y < bigHeight; y++) {
		for (let x = 0; x < w * SCALE; x++) {
			letters[y * bigWidth + x0 * SCALE + x] = resized[y * w * SCALE + x];
		}
	}
}

// The O and its face are drawn with hard edges, so the result doesn't depend
// on a canvas library's path antialiasing. The shapes follow PIL's drawing
// calls, which the approved prototype used: integer boxes whose far edge is
// included, and ellipses traced with PIL's Bresenham walk.

// Row extents of a filled ellipse in a box a+1 by b+1 pixels. Coordinates are
// doubled so the centre can fall between pixels. Returns, for each row, the
// pixel offset of the left edge and of the right edge.
function ellipseRows(a, b) {
	const delta = (x, y) =>
		Math.abs(a * a * y * y + b * b * x * x - a * a * b * b);
	const widest = new Map();
	let cx = a;
	let cy = b % 2;
	const ex = a % 2;
	const ey = b;
	for (;;) {
		if (!widest.has(cy)) widest.set(cy, cx);
		if (cx === ex && cy === ey) break;
		const moveX = delta(cx - 2, cy);
		const moveY = delta(cx, cy + 2);
		const moveXY = delta(cx - 2, cy + 2);
		if (moveX <= moveY && moveX <= moveXY) {
			cx -= 2;
		} else if (moveY <= moveXY) {
			cy += 2;
		} else {
			cx -= 2;
			cy += 2;
		}
	}

	const rows = Array.from({length: b + 1});
	for (const [y, x] of widest) {
		const extent = [(a - x) / 2, (a + x) / 2];
		rows[(b + y) / 2] = extent;
		rows[(b - y) / 2] = extent;
	}

	return rows;
}

class Plane {
	constructor(w, h) {
		this.w = w;
		this.h = h;
		this.data = new Uint8Array(w * h);
	}

	set(x, y, value) {
		if (x >= 0 && y >= 0 && x < this.w && y < this.h) {
			this.data[y * this.w + x] = value;
		}
	}

	hline(x0, x1, y, value) {
		for (let x = x0; x <= x1; x++) this.set(x, y, value);
	}

	rect(x0, y0, x1, y1, value) {
		[x0, y0, x1, y1] = [x0, y0, x1, y1].map(Math.floor);
		for (let y = y0; y <= y1; y++) this.hline(x0, x1, y, value);
	}

	// Rounded corners are quarter pie slices of diameter 2 * radius, joined by
	// rectangles, the way PIL builds them. PIL rounds the box first. This only
	// covers the shapes the logo uses: corners that don't meet.
	roundRect(x0, y0, x1, y1, radius, value) {
		[x0, y0, x1, y1] = [x0, y0, x1, y1].map(roundHalfEven);
		const d = radius * 2;
		if (d >= x1 - x0 - 1 || d >= y1 - y0 - 1) {
			throw new Error('Rounded corners that meet are not supported');
		}

		this.pie(x0, y0, x0 + d, y0 + d, value, 180, 270);
		this.pie(x1 - d, y0, x1, y0 + d, value, 270, 360);
		this.pie(x1 - d, y1 - d, x1, y1, value, 0, 90);
		this.pie(x0, y1 - d, x0 + d, y1, value, 90, 180);
		if (x1 - radius - 1 > x0 + radius + 1) {
			this.rect(x0 + radius + 1, y0, x1 - radius - 1, y1, value);
		}

		this.rect(x0, y0 + radius + 1, x0 + radius, y1 - radius - 1, value);
		this.rect(x1 - radius, y0 + radius + 1, x1, y1 - radius - 1, value);
	}

	// A pie slice of the ellipse in the box, angles in degrees clockwise from
	// three o'clock. The whole ellipse when no angles are given. PIL also
	// draws the two straight edges as lines, so pixels they touch are in.
	pie(x0, y0, x1, y1, value, from = 0, to = 360) {
		[x0, y0, x1, y1] = [x0, y0, x1, y1].map(Math.floor);
		const rows = ellipseRows(x1 - x0, y1 - y0);
		const cx = (x0 + x1 + 1) / 2;
		const cy = (y0 + y1 + 1) / 2;
		const edges = [from, to].map(angle => {
			const radians = (angle * Math.PI) / 180;
			return [Math.cos(radians), Math.sin(radians)];
		});
		const touches = (dx, dy) =>
			edges.some(([ux, uy]) => {
				if (dx * ux + dy * uy < 0) return false;
				// Distance along the minor axis, as a Bresenham line steps.
				return Math.abs(ux) >= Math.abs(uy)
					? Math.abs(dy - (dx * uy) / ux) <= 0.5
					: Math.abs(dx - (dy * ux) / uy) <= 0.5;
			});
		for (const [j, [left, right]] of rows.entries()) {
			for (let x = x0 + left; x <= x0 + right; x++) {
				const y = y0 + j;
				if (to - from < 360) {
					const dx = x + 0.5 - cx;
					const dy = y + 0.5 - cy;
					const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
					const inside = (((angle - from) % 360) + 360) % 360 <= to - from;
					if (!inside && !touches(dx, dy) && !(dx === 0 && dy === 0)) {
						continue;
					}
				}

				this.set(x, y, value);
			}
		}
	}
}

// Draws the O and its face into a 12x alpha plane the size of the O's slot.
function drawO(face, options) {
	const [slotX, slotW] = slots[O_INDEX];
	const w = slotW * SCALE;
	const h = bigHeight;
	const plane = new Plane(w, h);
	plane.roundRect(0, 0, w, h, Math.trunc(Math.min(w, h) * 0.48), 255);

	const tx = Math.trunc(w * 0.13);
	const ty = Math.trunc(h * 0.13);
	const ix0 = tx;
	const iy0 = ty;
	const ix1 = w - tx;
	const iy1 = h - ty;
	const iw = ix1 - ix0;
	const ih = iy1 - iy0;
	plane.roundRect(ix0, iy0, ix1, iy1, Math.trunc(Math.min(iw, ih) * 0.45), 0);

	const point = (fx, fy) => [ix0 + fx * iw, iy0 + fy * ih];
	const r = iw * 0.13;
	const eye = (fx, fy, shape) => {
		const [cx, cy] = point(fx, fy);
		if (shape === 'open') {
			plane.pie(cx - r, cy - r, cx + r, cy + r, 255);
		} else {
			plane.rect(cx - r * 1.2, cy - r * 0.35, cx + r * 1.2, cy + r * 0.35, 255);
		}
	};

	if (options.shades === undefined) {
		const [lx, ly, rx, ry] = EYES[face] ?? EYES.default;
		eye(lx, ly, face === 'blink' || face === 'wink' ? 'shut' : 'open');
		eye(rx, ry, face === 'blink' ? 'shut' : 'open');
	} else {
		const [ax] = point(0.27, 0);
		const [bx] = point(0.73, 0);
		const y = iy0 + ih * (0.3 + options.shades);
		const lw = iw * 0.2;
		const lh = ih * 0.22;
		plane.rect(ax - lw, y - lh * 0.5, bx + lw, y + lh * 0.1, 255);
		for (const cx of [ax, bx]) {
			plane.roundRect(
				cx - lw,
				y - lh * 0.5,
				cx + lw,
				y + lh,
				Math.trunc(lh * 0.6),
				255,
			);
		}
	}

	// The wedge mouth: a half disc tilted like the icon.
	const [mx, my] = point(0.55, 0.58);
	const mr = iw * 0.33;
	plane.pie(mx - mr, my - mr, mx + mr, my + mr, 255, -25, 155);

	return {plane: plane.data, slotX, w, h};
}

function render(face, options) {
	const big = Float64Array.from(letters);
	const o = drawO(face, options);
	for (let y = 0; y < o.h; y++) {
		for (let x = 0; x < o.w; x++) {
			big[y * bigWidth + o.slotX * SCALE + x] = o.plane[y * o.w + x];
		}
	}

	// Box-average each 12x12 block to one pixel of coverage.
	const pixels = [];
	for (let y = 0; y < height; y++) {
		const row = [];
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let dy = 0; dy < SCALE; dy++) {
				for (let dx = 0; dx < SCALE; dx++) {
					sum += big[(y * SCALE + dy) * bigWidth + x * SCALE + dx];
				}
			}

			row.push(sum / (SCALE * SCALE) / 255 > THRESHOLD);
		}

		pixels.push(row);
	}

	for (const [name, x, y, on] of TOUCH_UPS) {
		if (name === face) pixels[y][x] = on;
	}

	const lines = [];
	for (let y = 0; y < ROWS; y++) {
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

const frames = Object.fromEntries(
	Object.entries(FACES).map(([face, options]) => [face, render(face, options)]),
);

const columns = width / 2;
const oStart = Math.floor(slots[O_INDEX][0] / 2);
const oEnd = Math.ceil((slots[O_INDEX][0] + slots[O_INDEX][1]) / 2);

const body = Object.entries(frames)
	.map(
		([face, lines]) =>
			`\t${face}: [\n${lines.map(line => `\t\t'${line}',`).join('\n')}\n\t],`,
	)
	.join('\n');

const source = `// Generated by scripts/terminal-logo.mjs. Don't edit by hand.
// Regenerate with: pnpm logo:generate (needs docs/brand/fonts/MarowBlock-Regular.ttf)

export type LogoFace =
	| 'rest'
	| 'left'
	| 'right'
	| 'blink'
	| 'wink'
	| 'drop1'
	| 'drop2'
	| 'drop3'
	| 'shades';

export const LOGO_WIDTH = ${columns};
export const LOGO_HEIGHT = ${ROWS};

// The columns that hold the O: start inclusive, end exclusive.
export const O_COLUMNS: readonly [start: number, end: number] = [${oStart}, ${oEnd}];

export const LOGO_FRAMES: Record<LogoFace, readonly string[]> = {
${body}
};
`;

await writeFile(outPath, source);
console.log(`Wrote ${path.relative(root, outPath)}`);
