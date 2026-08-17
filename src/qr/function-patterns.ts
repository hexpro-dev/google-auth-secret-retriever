import { BitMatrix } from './bit-matrix.js';
import { ALIGNMENT_CENTRES, dimensionForVersion, versionInfoPositions } from './tables.js';

/**
 * Where a symbol's function patterns are, and what they look like.
 *
 * Shared by the encoder and the decoder on purpose. Both need to know exactly
 * which modules carry data, and if their two answers ever differed by a single
 * module the encoder would write a payload the decoder reads off by one bit
 * from that point on. That failure looks like corruption rather than like a
 * geometry bug, so it is worth removing the possibility rather than testing
 * for it.
 */

/**
 * Draw the function patterns and mark the modules they occupy.
 *
 * Pass `matrix` to draw them (encoding) or `null` to only mark the reserved map
 * (decoding, where the modules are already in the image).
 */
export function drawFunctionPatterns(
	matrix: BitMatrix | null,
	reserved: BitMatrix,
	version: number,
): void {
	const dimension = reserved.width;

	// Finder patterns and their separators, at three corners.
	for (const [ox, oy] of [
		[0, 0],
		[dimension - 7, 0],
		[0, dimension - 7],
	] as const) {
		for (let dy = -1; dy <= 7; dy += 1) {
			for (let dx = -1; dx <= 7; dx += 1) {
				const x = ox + dx;
				const y = oy + dy;
				if (x < 0 || y < 0 || x >= dimension || y >= dimension) {
					continue;
				}
				// A filled 3x3 core inside a ring; the rest of the 9x9 footprint
				// is the light separator.
				const inRing =
					(dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
					(dy >= 0 && dy <= 6 && (dx === 0 || dx === 6));
				const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
				matrix?.set(x, y, inRing || inCore);
				reserved.set(x, y, true);
			}
		}
	}

	// Timing patterns, running between the finders along row and column 6.
	for (let i = 8; i < dimension - 8; i += 1) {
		const dark = i % 2 === 0;
		matrix?.set(i, 6, dark);
		reserved.set(i, 6, true);
		matrix?.set(6, i, dark);
		reserved.set(6, i, true);
	}

	// Alignment patterns, skipping the three corners the finders occupy.
	const centres = ALIGNMENT_CENTRES[version - 1] as readonly number[];
	for (const cy of centres) {
		for (const cx of centres) {
			const nearFinder =
				(cx <= 8 && cy <= 8) ||
				(cx <= 8 && cy >= dimension - 9) ||
				(cx >= dimension - 9 && cy <= 8);
			if (nearFinder) {
				continue;
			}
			for (let dy = -2; dy <= 2; dy += 1) {
				for (let dx = -2; dx <= 2; dx += 1) {
					matrix?.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					reserved.set(cx + dx, cy + dy, true);
				}
			}
		}
	}

	// The format information arms, including the timing module each steps over
	// and the dark module below the top-left one.
	for (let i = 0; i < 9; i += 1) {
		reserved.set(i, 8, true);
		reserved.set(8, i, true);
	}
	for (let i = 0; i < 8; i += 1) {
		reserved.set(dimension - 1 - i, 8, true);
		reserved.set(8, dimension - 1 - i, true);
	}

	if (version >= 7) {
		const { first, second } = versionInfoPositions(dimension);
		for (const [x, y] of [...first, ...second]) {
			reserved.set(x, y, true);
		}
	}
}

/** The map of modules that do not carry data, for a given version. */
export function functionPatternMap(version: number): BitMatrix {
	const reserved = new BitMatrix(dimensionForVersion(version));
	drawFunctionPatterns(null, reserved, version);
	return reserved;
}

/**
 * Walk the data region in the order codewords are laid out: two columns at a
 * time, right to left, zigzagging up then down.
 *
 * Column 6 is skipped because it carries the vertical timing pattern, and that
 * single exception is the detail most implementations get wrong.
 *
 * The callback returns nothing when writing and the bit when reading, which is
 * what lets one traversal serve both directions.
 */
export function walkDataModules(
	dimension: number,
	reserved: BitMatrix,
	visit: (x: number, y: number, index: number) => void,
): void {
	let index = 0;
	let upward = true;

	for (let right = dimension - 1; right >= 1; right -= 2) {
		if (right === 6) {
			right = 5;
		}

		for (let step = 0; step < dimension; step += 1) {
			const y = upward ? dimension - 1 - step : step;

			for (let column = 0; column < 2; column += 1) {
				const x = right - column;
				if (reserved.get(x, y)) {
					continue;
				}
				visit(x, y, index);
				index += 1;
			}
		}

		upward = !upward;
	}
}
