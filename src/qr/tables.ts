import type { EcLevel, QrMode } from '../types.js';

/**
 * The QR specification's lookup tables, in one place, as data.
 *
 * Kept separate from the code that uses them so they can be reviewed as a table
 * and tested as invariants. `tests/qr/tables.test.ts` checks every row against
 * the arithmetic the specification guarantees (block sizes summing to the total
 * codeword count, group 2 always holding one more data codeword than group 1,
 * alignment pattern counts following from the version), which catches a
 * transcription slip without anyone having to proofread 160 rows.
 */

/* ── Error-correction levels ──────────────────────────────────────────────── */

/**
 * Two different orderings of the same four levels, and they are not
 * interchangeable.
 *
 * `EC_INDEX` is the order the block tables are written in: L, M, Q, H, weakest
 * to strongest. `EC_FORMAT_BITS` is the two-bit value written into the symbol's
 * format information, and the specification assigns those in a different order:
 * M, L, H, Q.
 *
 * Conflating the two is the most common QR implementation bug there is. The two
 * orderings are a permutation with no fixed point, so there is no level at
 * which the confusion happens to cancel out: code that reaches for the wrong
 * one is wrong for every symbol it touches. Both names are spelled out here so
 * a reader has to pick one deliberately.
 */
export const EC_INDEX: Readonly<Record<EcLevel, number>> = { L: 0, M: 1, Q: 2, H: 3 };
export const EC_FORMAT_BITS: Readonly<Record<EcLevel, number>> = {
	M: 0b00,
	L: 0b01,
	H: 0b10,
	Q: 0b11,
};
export const EC_LEVELS: readonly EcLevel[] = ['L', 'M', 'Q', 'H'];

/** Reverse of `EC_FORMAT_BITS`, for reading format information back. */
export const EC_FROM_FORMAT_BITS: readonly EcLevel[] = ['M', 'L', 'H', 'Q'];

/* ── Block structure ──────────────────────────────────────────────────────── */

export interface EcBlockSpec {
	readonly ecCodewordsPerBlock: number;
	readonly group1Blocks: number;
	readonly group1DataCodewords: number;
	readonly group2Blocks: number;
	readonly group2DataCodewords: number;
}

/**
 * Indexed `(version - 1) * 4 + EC_INDEX[level]`, so the rows below read
 * version by version in L, M, Q, H order.
 *
 * Each row is [ec codewords per block, group 1 blocks, group 1 data codewords,
 * group 2 blocks, group 2 data codewords].
 */
const EC_BLOCK_ROWS: ReadonlyArray<readonly [number, number, number, number, number]> = [
	// v1
	[7, 1, 19, 0, 0],
	[10, 1, 16, 0, 0],
	[13, 1, 13, 0, 0],
	[17, 1, 9, 0, 0],
	// v2
	[10, 1, 34, 0, 0],
	[16, 1, 28, 0, 0],
	[22, 1, 22, 0, 0],
	[28, 1, 16, 0, 0],
	// v3
	[15, 1, 55, 0, 0],
	[26, 1, 44, 0, 0],
	[18, 2, 17, 0, 0],
	[22, 2, 13, 0, 0],
	// v4
	[20, 1, 80, 0, 0],
	[18, 2, 32, 0, 0],
	[26, 2, 24, 0, 0],
	[16, 4, 9, 0, 0],
	// v5
	[26, 1, 108, 0, 0],
	[24, 2, 43, 0, 0],
	[18, 2, 15, 2, 16],
	[22, 2, 11, 2, 12],
	// v6
	[18, 2, 68, 0, 0],
	[16, 4, 27, 0, 0],
	[24, 4, 19, 0, 0],
	[28, 4, 15, 0, 0],
	// v7
	[20, 2, 78, 0, 0],
	[18, 4, 31, 0, 0],
	[18, 2, 14, 4, 15],
	[26, 4, 13, 1, 14],
	// v8
	[24, 2, 97, 0, 0],
	[22, 2, 38, 2, 39],
	[22, 4, 18, 2, 19],
	[26, 4, 14, 2, 15],
	// v9
	[30, 2, 116, 0, 0],
	[22, 3, 36, 2, 37],
	[20, 4, 16, 4, 17],
	[24, 4, 12, 4, 13],
	// v10
	[18, 2, 68, 2, 69],
	[26, 4, 43, 1, 44],
	[24, 6, 19, 2, 20],
	[28, 6, 15, 2, 16],
	// v11
	[20, 4, 81, 0, 0],
	[30, 1, 50, 4, 51],
	[28, 4, 22, 4, 23],
	[24, 3, 12, 8, 13],
	// v12
	[24, 2, 92, 2, 93],
	[22, 6, 36, 2, 37],
	[26, 4, 20, 6, 21],
	[28, 7, 14, 4, 15],
	// v13
	[26, 4, 107, 0, 0],
	[22, 8, 37, 1, 38],
	[24, 8, 20, 4, 21],
	[22, 12, 11, 4, 12],
	// v14
	[30, 3, 115, 1, 116],
	[24, 4, 40, 5, 41],
	[20, 11, 16, 5, 17],
	[24, 11, 12, 5, 13],
	// v15
	[22, 5, 87, 1, 88],
	[24, 5, 41, 5, 42],
	[30, 5, 24, 7, 25],
	[24, 11, 12, 7, 13],
	// v16
	[24, 5, 98, 1, 99],
	[28, 7, 45, 3, 46],
	[24, 15, 19, 2, 20],
	[30, 3, 15, 13, 16],
	// v17
	[28, 1, 107, 5, 108],
	[28, 10, 46, 1, 47],
	[28, 1, 22, 15, 23],
	[28, 2, 14, 17, 15],
	// v18
	[30, 5, 120, 1, 121],
	[26, 9, 43, 4, 44],
	[28, 17, 22, 1, 23],
	[28, 2, 14, 19, 15],
	// v19
	[28, 3, 113, 4, 114],
	[26, 3, 44, 11, 45],
	[26, 17, 21, 4, 22],
	[26, 9, 13, 16, 14],
	// v20
	[28, 3, 107, 5, 108],
	[26, 3, 41, 13, 42],
	[30, 15, 24, 5, 25],
	[28, 15, 15, 10, 16],
	// v21
	[28, 4, 116, 4, 117],
	[26, 17, 42, 0, 0],
	[28, 17, 22, 6, 23],
	[30, 19, 16, 6, 17],
	// v22
	[28, 2, 111, 7, 112],
	[28, 17, 46, 0, 0],
	[30, 7, 24, 16, 25],
	[24, 34, 13, 0, 0],
	// v23
	[30, 4, 121, 5, 122],
	[28, 4, 47, 14, 48],
	[30, 11, 24, 14, 25],
	[30, 16, 15, 14, 16],
	// v24
	[30, 6, 117, 4, 118],
	[28, 6, 45, 14, 46],
	[30, 11, 24, 16, 25],
	[30, 30, 16, 2, 17],
	// v25
	[26, 8, 106, 4, 107],
	[28, 8, 47, 13, 48],
	[30, 7, 24, 22, 25],
	[30, 22, 15, 13, 16],
	// v26
	[28, 10, 114, 2, 115],
	[28, 19, 46, 4, 47],
	[28, 28, 22, 6, 23],
	[30, 33, 16, 4, 17],
	// v27
	[30, 8, 122, 4, 123],
	[28, 22, 45, 3, 46],
	[30, 8, 23, 26, 24],
	[30, 12, 15, 28, 16],
	// v28
	[30, 3, 117, 10, 118],
	[28, 3, 45, 23, 46],
	[30, 4, 24, 31, 25],
	[30, 11, 15, 31, 16],
	// v29
	[30, 7, 116, 7, 117],
	[28, 21, 45, 7, 46],
	[30, 1, 23, 37, 24],
	[30, 19, 15, 26, 16],
	// v30
	[30, 5, 115, 10, 116],
	[28, 19, 47, 10, 48],
	[30, 15, 24, 25, 25],
	[30, 23, 15, 25, 16],
	// v31
	[30, 13, 115, 3, 116],
	[28, 2, 46, 29, 47],
	[30, 42, 24, 1, 25],
	[30, 23, 15, 28, 16],
	// v32
	[30, 17, 115, 0, 0],
	[28, 10, 46, 23, 47],
	[30, 10, 24, 35, 25],
	[30, 19, 15, 35, 16],
	// v33
	[30, 17, 115, 1, 116],
	[28, 14, 46, 21, 47],
	[30, 29, 24, 19, 25],
	[30, 11, 15, 46, 16],
	// v34
	[30, 13, 115, 6, 116],
	[28, 14, 46, 23, 47],
	[30, 44, 24, 7, 25],
	[30, 59, 16, 1, 17],
	// v35
	[30, 12, 121, 7, 122],
	[28, 12, 47, 26, 48],
	[30, 39, 24, 14, 25],
	[30, 22, 15, 41, 16],
	// v36
	[30, 6, 121, 14, 122],
	[28, 6, 47, 34, 48],
	[30, 46, 24, 10, 25],
	[30, 2, 15, 64, 16],
	// v37
	[30, 17, 122, 4, 123],
	[28, 29, 46, 14, 47],
	[30, 49, 24, 10, 25],
	[30, 24, 15, 46, 16],
	// v38
	[30, 4, 122, 18, 123],
	[28, 13, 46, 32, 47],
	[30, 48, 24, 14, 25],
	[30, 42, 15, 32, 16],
	// v39
	[30, 20, 117, 4, 118],
	[28, 40, 47, 7, 48],
	[30, 43, 24, 22, 25],
	[30, 10, 15, 67, 16],
	// v40
	[30, 19, 118, 6, 119],
	[28, 18, 47, 31, 48],
	[30, 34, 24, 34, 25],
	[30, 20, 15, 61, 16],
];

export const EC_BLOCKS: readonly EcBlockSpec[] = EC_BLOCK_ROWS.map(
	([
		ecCodewordsPerBlock,
		group1Blocks,
		group1DataCodewords,
		group2Blocks,
		group2DataCodewords,
	]) => ({
		ecCodewordsPerBlock,
		group1Blocks,
		group1DataCodewords,
		group2Blocks,
		group2DataCodewords,
	}),
);

export function ecBlocksFor(version: number, level: EcLevel): EcBlockSpec {
	const spec = EC_BLOCKS[(version - 1) * 4 + EC_INDEX[level]];
	if (spec === undefined) {
		throw new Error(`no block specification for version ${version} at level ${level}`);
	}
	return spec;
}

/** Total codewords in a symbol, indexed by version - 1. */
export const TOTAL_CODEWORDS: readonly number[] = [
	26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
	1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034,
	3196, 3362, 3532, 3706,
];

/**
 * Bits left over after the codewords, indexed by version - 1.
 *
 * The data region is not always a whole number of codewords, so a few zero bits
 * are written at the end. They carry nothing but they occupy module positions,
 * so a decoder that forgets them reads the last codeword from the wrong place.
 */
export const REMAINDER_BITS: readonly number[] = [
	0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3,
	3, 0, 0, 0, 0, 0, 0,
];

/** Row and column coordinates of alignment pattern centres, indexed by version - 1. */
export const ALIGNMENT_CENTRES: ReadonlyArray<readonly number[]> = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
	[6, 30, 54],
	[6, 32, 58],
	[6, 34, 62],
	[6, 26, 46, 66],
	[6, 26, 48, 70],
	[6, 26, 50, 74],
	[6, 30, 54, 78],
	[6, 30, 56, 82],
	[6, 30, 58, 86],
	[6, 34, 62, 90],
	[6, 28, 50, 72, 94],
	[6, 26, 50, 74, 98],
	[6, 30, 54, 78, 102],
	[6, 28, 54, 80, 106],
	[6, 32, 58, 84, 110],
	[6, 30, 58, 86, 114],
	[6, 34, 62, 90, 118],
	[6, 26, 50, 74, 98, 122],
	[6, 30, 54, 78, 102, 126],
	[6, 26, 52, 78, 104, 130],
	[6, 30, 56, 82, 108, 134],
	[6, 34, 60, 86, 112, 138],
	[6, 30, 58, 86, 114, 142],
	[6, 34, 62, 90, 118, 146],
	[6, 30, 54, 78, 102, 126, 150],
	[6, 24, 50, 76, 102, 128, 154],
	[6, 28, 54, 80, 106, 132, 158],
	[6, 32, 58, 84, 110, 136, 162],
	[6, 26, 54, 82, 110, 138, 166],
	[6, 30, 58, 86, 114, 142, 170],
];

/* ── Segment encoding ─────────────────────────────────────────────────────── */

export const MODE_BITS: Readonly<Record<QrMode, number>> = {
	numeric: 0b0001,
	alphanumeric: 0b0010,
	byte: 0b0100,
	kanji: 0b1000,
};

/**
 * Width of the character count field, by mode and version band.
 *
 * The three entries are versions 1 to 9, 10 to 26, and 27 to 40. A decoder that
 * uses the wrong band reads the count from the wrong number of bits and then
 * misreads everything after it, which looks like corruption rather than like a
 * version bug.
 */
export const CHAR_COUNT_BITS: Readonly<Record<QrMode, readonly [number, number, number]>> = {
	numeric: [10, 12, 14],
	alphanumeric: [9, 11, 13],
	byte: [8, 16, 16],
	kanji: [8, 10, 12],
};

export function charCountBits(mode: QrMode, version: number): number {
	const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
	return CHAR_COUNT_BITS[mode][band];
}

/** The alphanumeric mode's 45-character alphabet, in its specified order. */
export const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/* ── Where the information regions live ──────────────────────────────────── */

/**
 * The 15 format-information positions, in specification bit order.
 *
 * Index 0 is the *most* significant bit of the 15-bit codeword, which is the
 * opposite of how a `>>>` loop naturally walks a number. Writing them
 * least-significant-first produces a symbol that differs from a correct one in
 * only a handful of modules, and every one of those modules is in the format
 * region, so the data still decodes right up until a real reader rejects the
 * symbol. Both lists are here, once, so the encoder and the decoder cannot
 * drift apart.
 *
 * Returned as [x, y] pairs, so [column, row].
 */
export function formatInfoPositions(dimension: number): {
	readonly first: ReadonlyArray<readonly [number, number]>;
	readonly second: ReadonlyArray<readonly [number, number]>;
} {
	const first: Array<readonly [number, number]> = [
		// Along row 8, left to right, skipping the timing column at 6.
		[0, 8],
		[1, 8],
		[2, 8],
		[3, 8],
		[4, 8],
		[5, 8],
		[7, 8],
		[8, 8],
		// Then up column 8, again skipping the timing row at 6.
		[8, 7],
		[8, 5],
		[8, 4],
		[8, 3],
		[8, 2],
		[8, 1],
		[8, 0],
	];

	const second: Array<readonly [number, number]> = [];
	// The first seven bits run up column 8 from the bottom edge.
	for (let i = 0; i < 7; i += 1) {
		second.push([8, dimension - 1 - i]);
	}
	// The remaining eight run along row 8 to the right edge.
	for (let i = 0; i < 8; i += 1) {
		second.push([dimension - 8 + i, 8]);
	}

	return { first, second };
}

/**
 * The 18 version-information positions, for versions 7 and up.
 *
 * Index 0 is the least significant bit here, which is genuinely different from
 * the format information above and is not a mistake.
 */
export function versionInfoPositions(dimension: number): {
	readonly first: ReadonlyArray<readonly [number, number]>;
	readonly second: ReadonlyArray<readonly [number, number]>;
} {
	const first: Array<readonly [number, number]> = [];
	const second: Array<readonly [number, number]> = [];

	for (let i = 0; i < 18; i += 1) {
		// The two blocks are transposes of each other, and getting that the
		// wrong way round is subtle: both are 18 modules and both sit in the
		// right corner, so the symbol looks correct. What actually breaks is
		// the *reservation*, which then shifts every data module placed after
		// it, so the entire payload decodes as noise from version 7 upward
		// while versions 1 to 6 stay perfect.
		//
		// Bottom-left is 6 columns wide and 3 rows tall; top-right is its
		// transpose.
		first.push([Math.floor(i / 3), dimension - 11 + (i % 3)]);
		second.push([dimension - 11 + (i % 3), Math.floor(i / 3)]);
	}

	return { first, second };
}

/** Module count along one edge of a symbol. */
export function dimensionForVersion(version: number): number {
	return version * 4 + 17;
}

/** The inverse, or null when the dimension is not a legal QR size. */
export function versionForDimension(dimension: number): number | null {
	if (dimension < 21 || dimension > 177 || (dimension - 17) % 4 !== 0) {
		return null;
	}
	return (dimension - 17) / 4;
}
