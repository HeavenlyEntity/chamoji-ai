// Shared by the generators: box-average a supersampled image down to pixels,
// then pack 2x2 pixels per terminal cell into quadrant characters.

/** Indexed by bits TL, TR, BL, BR. */
export const QUADRANTS = ' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█';

/**
 * Box-averages each `scale` x `scale` block to one pixel of coverage (0 to 1,
 * row by row). `at(x, y)` reads one supersampled value, 0 to 255.
 */
export function boxAverage({width, height, scale, at}) {
	const coverage = [];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					sum += at(x * scale + dx, y * scale + dy);
				}
			}

			coverage.push(sum / (scale * scale) / 255);
		}
	}

	return coverage;
}

/** Packs rows of on/off pixels, 2x2 to a cell, into `rows` lines of text. */
export function toQuadrantLines(pixels, rows) {
	const width = pixels[0].length;
	const lines = [];
	for (let y = 0; y < rows; y++) {
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
