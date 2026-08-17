import { QrDecodeError, QrUnsupportedFeatureError } from '../../errors.js';
import type { EcLevel } from '../../types.js';
import { decodeFormatInfo, decodeVersionInfo } from '../bch.js';
import type { BitMatrix } from '../bit-matrix.js';
import { BitMatrix as Matrix } from '../bit-matrix.js';
import { drawFunctionPatterns, walkDataModules } from '../function-patterns.js';
import { MASK_PATTERNS } from '../mask.js';
import {
	REMAINDER_BITS,
	formatInfoPositions,
	versionInfoPositions,
	versionForDimension,
} from '../tables.js';

/**
 * Reading a sampled symbol back into codewords.
 *
 * This is the mirror of the placement half of the encoder, and it shares the
 * geometry with it (`function-patterns.ts`) rather than restating it.
 */

export interface SymbolInfo {
	readonly version: number;
	readonly ecLevel: EcLevel;
	readonly mask: number;
	/** Bits corrected while reading the format information, as a quality hint. */
	readonly formatErrors: number;
}

function readBits(matrix: BitMatrix, positions: ReadonlyArray<readonly [number, number]>): number {
	let bits = 0;
	for (const [x, y] of positions) {
		bits = (bits << 1) | (matrix.get(x, y) ? 1 : 0);
	}
	return bits;
}

/**
 * Read the format information, trying both copies.
 *
 * The two copies exist so a symbol survives losing one corner. Taking whichever
 * decodes with fewer corrections is what turns that redundancy into an actual
 * benefit, rather than always trusting the first and failing when it is the
 * damaged one.
 */
export function readFormatInfo(matrix: BitMatrix): {
	ecLevel: EcLevel;
	mask: number;
	errors: number;
} {
	const { first, second } = formatInfoPositions(matrix.width);

	const candidates = [
		decodeFormatInfo(readBits(matrix, first)),
		decodeFormatInfo(readBits(matrix, second)),
	];
	let best: { ecLevel: EcLevel; mask: number; errors: number } | null = null;

	for (const candidate of candidates) {
		if (candidate === null) {
			continue;
		}
		if (best === null || candidate.errorsCorrected < best.errors) {
			best = {
				ecLevel: candidate.ecLevel,
				mask: candidate.mask,
				errors: candidate.errorsCorrected,
			};
		}
	}

	if (best === null) {
		// Without the mask and the level there is nothing sensible to do with
		// the data region, so this is a hard stop rather than a guess.
		throw new QrDecodeError('format', 0, 'the format information is unreadable');
	}

	return best;
}

/**
 * Work out the version.
 *
 * Below version 7 the dimension is the only source, and it is exact. From
 * version 7 the symbol also carries an explicit, error-corrected version block,
 * which is checked against the dimension: if they disagree the symbol was
 * sampled on the wrong grid, and continuing would produce confident nonsense.
 */
export function readVersion(matrix: BitMatrix): number {
	const fromDimension = versionForDimension(matrix.width);
	if (fromDimension === null) {
		throw new QrDecodeError('version', 0, `${matrix.width} modules is not a valid symbol size`);
	}

	if (fromDimension < 7) {
		return fromDimension;
	}

	const { first, second } = versionInfoPositions(matrix.width);
	// Version information is written least significant bit first, so the read
	// has to walk the positions in reverse to build the number.
	const readReversed = (positions: ReadonlyArray<readonly [number, number]>): number => {
		let bits = 0;
		for (let i = positions.length - 1; i >= 0; i -= 1) {
			const [x, y] = positions[i] as readonly [number, number];
			bits = (bits << 1) | (matrix.get(x, y) ? 1 : 0);
		}
		return bits;
	};

	for (const positions of [first, second]) {
		const decoded = decodeVersionInfo(readReversed(positions));
		if (decoded !== null) {
			if (decoded !== fromDimension) {
				throw new QrDecodeError(
					'version',
					0,
					'the symbol states a version that disagrees with its size',
				);
			}
			return decoded;
		}
	}

	// Both blocks unreadable. The dimension is still trustworthy, because a
	// symbol sampled at the wrong size almost never lands on a legal one.
	return fromDimension;
}

/** Undo the mask and read the data region into codewords. */
export function extractCodewords(matrix: BitMatrix, version: number, mask: number): Uint8Array {
	const dimension = matrix.width;
	const reserved = new Matrix(dimension);
	drawFunctionPatterns(null, reserved, version);

	const predicate = MASK_PATTERNS[mask];
	if (predicate === undefined) {
		throw new QrUnsupportedFeatureError('mode', `mask pattern ${mask}`);
	}

	// The remainder bits at the end are padding, not codewords.
	const totalBits = dimension * dimension;
	const bits = new Uint8Array(totalBits);
	let count = 0;

	walkDataModules(dimension, reserved, (x, y, index) => {
		bits[index] = (matrix.get(x, y) ? 1 : 0) ^ (predicate(y, x) ? 1 : 0);
		count = index + 1;
	});

	const remainder = REMAINDER_BITS[version - 1] as number;
	const codewordCount = Math.floor((count - remainder) / 8);
	const codewords = new Uint8Array(codewordCount);

	for (let i = 0; i < codewordCount; i += 1) {
		let byte = 0;
		for (let bit = 0; bit < 8; bit += 1) {
			byte = (byte << 1) | (bits[i * 8 + bit] as number);
		}
		codewords[i] = byte;
	}

	return codewords;
}

export function readSymbolInfo(matrix: BitMatrix): SymbolInfo {
	const version = readVersion(matrix);
	const format = readFormatInfo(matrix);

	return {
		version,
		ecLevel: format.ecLevel,
		mask: format.mask,
		formatErrors: format.errors,
	};
}
