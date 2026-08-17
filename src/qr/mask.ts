import type { BitMatrix } from './bit-matrix.js';

/**
 * The eight data mask patterns, and the penalty score used to choose between
 * them.
 *
 * Masking exists so a symbol never contains large blank areas or accidental
 * copies of the finder pattern, either of which would defeat the scanner
 * looking at it. The encoder tries all eight and keeps the one with the lowest
 * penalty; the decoder is simply told which was used, in the format
 * information.
 *
 * The predicates take (row, column) in that order. The specification writes
 * them as (i, j) with i as the row, and swapping them silently produces four
 * masks that are each other's transpose, which round trips within one
 * implementation and fails against every other reader.
 */
export type MaskPredicate = (row: number, column: number) => boolean;

export const MASK_PATTERNS: readonly MaskPredicate[] = [
	(row, column) => (row + column) % 2 === 0,
	(row) => row % 2 === 0,
	(_row, column) => column % 3 === 0,
	(row, column) => (row + column) % 3 === 0,
	(row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
	(row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
	(row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
	(row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/** Penalty weights from the specification. */
const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

/** Rule 1: runs of five or more same-coloured modules in a row or column. */
function penaltyRule1(matrix: BitMatrix): number {
	let penalty = 0;

	const scanLine = (length: number, read: (i: number) => boolean): void => {
		let runColour = read(0);
		let runLength = 1;
		for (let i = 1; i < length; i += 1) {
			const value = read(i);
			if (value === runColour) {
				runLength += 1;
			} else {
				if (runLength >= 5) {
					penalty += N1 + (runLength - 5);
				}
				runColour = value;
				runLength = 1;
			}
		}
		if (runLength >= 5) {
			penalty += N1 + (runLength - 5);
		}
	};

	for (let y = 0; y < matrix.height; y += 1) {
		scanLine(matrix.width, (x) => matrix.get(x, y));
	}
	for (let x = 0; x < matrix.width; x += 1) {
		scanLine(matrix.height, (y) => matrix.get(x, y));
	}

	return penalty;
}

/** Rule 2: every 2 by 2 block of one colour. */
function penaltyRule2(matrix: BitMatrix): number {
	let penalty = 0;
	for (let y = 0; y < matrix.height - 1; y += 1) {
		for (let x = 0; x < matrix.width - 1; x += 1) {
			const value = matrix.get(x, y);
			if (
				value === matrix.get(x + 1, y) &&
				value === matrix.get(x, y + 1) &&
				value === matrix.get(x + 1, y + 1)
			) {
				penalty += N2;
			}
		}
	}
	return penalty;
}

/**
 * Rule 3: the finder-like 1:1:3:1:1 pattern with four modules of quiet space on
 * either side.
 *
 * This is the rule that actually matters for scanning: an accidental copy of
 * the finder pattern inside the data region sends the locator hunting in the
 * wrong place.
 */
function penaltyRule3(matrix: BitMatrix): number {
	const PATTERN = [true, false, true, true, true, false, true];
	let penalty = 0;

	const matchesAt = (read: (i: number) => boolean, start: number, length: number): boolean => {
		for (let i = 0; i < 7; i += 1) {
			if (read(start + i) !== PATTERN[i]) {
				return false;
			}
		}

		// The four light modules must be inside the symbol.
		//
		// The tempting alternative is to count the quiet zone, since it is light
		// and it is four modules wide, which would make a pattern at the very
		// edge qualify. Measured against an independent implementation across
		// three payloads and four error-correction levels, that reading picks a
		// different mask most of the time and this one agrees almost always.
		// It is also the narrower reading of "preceded or followed by", since
		// the quiet zone is not part of the symbol being scored.
		const beforeClear = (() => {
			if (start - 4 < 0) {
				return false;
			}
			for (let i = start - 4; i < start; i += 1) {
				if (read(i)) {
					return false;
				}
			}
			return true;
		})();
		const afterClear = (() => {
			if (start + 11 > length) {
				return false;
			}
			for (let i = start + 7; i < start + 11; i += 1) {
				if (read(i)) {
					return false;
				}
			}
			return true;
		})();

		return beforeClear || afterClear;
	};

	for (let y = 0; y < matrix.height; y += 1) {
		for (let x = 0; x <= matrix.width - 7; x += 1) {
			if (matchesAt((i) => matrix.getSafe(i, y), x, matrix.width)) {
				penalty += N3;
			}
		}
	}
	for (let x = 0; x < matrix.width; x += 1) {
		for (let y = 0; y <= matrix.height - 7; y += 1) {
			if (matchesAt((i) => matrix.getSafe(x, i), y, matrix.height)) {
				penalty += N3;
			}
		}
	}

	return penalty;
}

/** Rule 4: deviation from an even balance of dark and light. */
function penaltyRule4(matrix: BitMatrix): number {
	const total = matrix.width * matrix.height;
	const dark = matrix.countDark();
	const percent = (dark * 100) / total;
	const deviation = Math.floor(Math.abs(percent - 50) / 5);
	return deviation * N4;
}

export function penaltyScore(matrix: BitMatrix): number {
	return penaltyRule1(matrix) + penaltyRule2(matrix) + penaltyRule3(matrix) + penaltyRule4(matrix);
}

export const PENALTY_RULES = {
	rule1: penaltyRule1,
	rule2: penaltyRule2,
	rule3: penaltyRule3,
	rule4: penaltyRule4,
};
