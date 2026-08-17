import type { EcLevel } from '../../types.js';
import type { BitMatrix } from '../bit-matrix.js';
import { decodeBlocks } from './blocks.js';
import { extractCodewords, readSymbolInfo } from './extract.js';
import { decodeSegments } from './segments.js';

/**
 * Decode a sampled symbol: modules in, text out.
 *
 * Separate from the image pipeline on purpose. Everything from here down is
 * exact and deterministic, and everything above it (finding the symbol in a
 * photograph, deciding which pixels are dark) is estimation. Keeping the seam
 * visible means the estimating half can be retried in a ladder without the
 * exact half being involved.
 */

export interface MatrixDecodeResult {
	readonly text: string;
	readonly version: number;
	readonly ecLevel: EcLevel;
	readonly mask: number;
	/**
	 * Reed-Solomon symbol errors repaired while reading.
	 *
	 * A quality signal worth surfacing: zero means the symbol was read
	 * perfectly, and a number close to the block capacity means the next
	 * slightly worse photograph will fail.
	 */
	readonly errorsCorrected: number;
	readonly formatErrors: number;
}

export function decodeMatrix(matrix: BitMatrix): MatrixDecodeResult {
	const info = readSymbolInfo(matrix);
	const codewords = extractCodewords(matrix, info.version, info.mask);
	const { data, errorsCorrected } = decodeBlocks(codewords, info.version, info.ecLevel);
	const text = decodeSegments(data, info.version);

	return {
		text,
		version: info.version,
		ecLevel: info.ecLevel,
		mask: info.mask,
		errorsCorrected,
		formatErrors: info.formatErrors,
	};
}
