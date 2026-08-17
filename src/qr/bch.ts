import type { EcLevel } from '../types.js';
import { EC_FORMAT_BITS, EC_FROM_FORMAT_BITS, EC_LEVELS } from './tables.js';

/**
 * The BCH codes protecting a symbol's format and version information.
 *
 * These are not the Reed-Solomon code that protects the data. They are much
 * smaller and much stronger relative to their size, because if the format
 * information is unreadable the decoder does not know the mask or the
 * error-correction level and cannot even begin on the data.
 *
 * Decoding is a nearest-codeword search rather than syndrome decoding. There
 * are only 32 valid format codewords and 34 valid version codewords, so
 * comparing against all of them is both simpler and more robust than the
 * algebra, and it is what the established readers do.
 */

/** BCH(15, 5), generator x^10 + x^8 + x^5 + x^4 + x^2 + x + 1. */
const FORMAT_GENERATOR = 0x537;

/**
 * Applied to every format codeword after encoding.
 *
 * Without it, the all-zero data (level M, mask 0) would produce an all-zero
 * codeword, and a blank region of a damaged symbol would read as a valid
 * format. The mask makes that impossible.
 */
const FORMAT_MASK = 0x5412;

/** BCH(18, 6), generator x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1. */
const VERSION_GENERATOR = 0x1f25;

function bchRemainder(
	value: number,
	generator: number,
	dataBits: number,
	totalBits: number,
): number {
	const checkBits = totalBits - dataBits;
	let remainder = value << checkBits;

	for (let bit = totalBits - 1; bit >= checkBits; bit -= 1) {
		if ((remainder & (1 << bit)) !== 0) {
			remainder ^= generator << (bit - checkBits);
		}
	}

	return remainder;
}

export function encodeFormatInfo(level: EcLevel, mask: number): number {
	// Five data bits: two for the level, three for the mask pattern. The level
	// bits come from EC_FORMAT_BITS, not EC_INDEX. See the note in tables.ts.
	const data = (EC_FORMAT_BITS[level] << 3) | (mask & 0b111);
	const remainder = bchRemainder(data, FORMAT_GENERATOR, 5, 15);
	return ((data << 10) | remainder) ^ FORMAT_MASK;
}

export function encodeVersionInfo(version: number): number {
	if (version < 7 || version > 40) {
		throw new Error(`versions below 7 carry no version information (got ${version})`);
	}
	const remainder = bchRemainder(version, VERSION_GENERATOR, 6, 18);
	return (version << 12) | remainder;
}

/** All 32 valid format codewords, with the data they encode. */
const FORMAT_CODEWORDS: ReadonlyArray<{ bits: number; level: EcLevel; mask: number }> = (() => {
	const out: { bits: number; level: EcLevel; mask: number }[] = [];
	for (const level of EC_LEVELS) {
		for (let mask = 0; mask < 8; mask += 1) {
			out.push({ bits: encodeFormatInfo(level, mask), level, mask });
		}
	}
	return out;
})();

/** All 34 valid version codewords, for versions 7 to 40. */
const VERSION_CODEWORDS: ReadonlyArray<{ bits: number; version: number }> = (() => {
	const out: { bits: number; version: number }[] = [];
	for (let version = 7; version <= 40; version += 1) {
		out.push({ bits: encodeVersionInfo(version), version });
	}
	return out;
})();

function hammingDistance(a: number, b: number): number {
	let difference = a ^ b;
	let count = 0;
	while (difference !== 0) {
		difference &= difference - 1;
		count += 1;
	}
	return count;
}

export interface FormatInfo {
	readonly ecLevel: EcLevel;
	readonly mask: number;
	readonly errorsCorrected: number;
}

/**
 * Read 15 bits of format information, tolerating up to 3 flipped bits.
 *
 * BCH(15, 5) has minimum distance 7, so it can correct 3 errors unambiguously.
 * Anything further away is rejected rather than guessed at, because guessing
 * the mask wrong turns the entire data region into noise.
 */
export function decodeFormatInfo(bits: number): FormatInfo | null {
	let best: { level: EcLevel; mask: number; distance: number } | null = null;

	for (const candidate of FORMAT_CODEWORDS) {
		const distance = hammingDistance(bits & 0x7fff, candidate.bits);
		if (best === null || distance < best.distance) {
			best = { level: candidate.level, mask: candidate.mask, distance };
		}
	}

	if (best === null || best.distance > 3) {
		return null;
	}

	return { ecLevel: best.level, mask: best.mask, errorsCorrected: best.distance };
}

/** Read 18 bits of version information, tolerating up to 3 flipped bits. */
export function decodeVersionInfo(bits: number): number | null {
	let best: { version: number; distance: number } | null = null;

	for (const candidate of VERSION_CODEWORDS) {
		const distance = hammingDistance(bits & 0x3ffff, candidate.bits);
		if (best === null || distance < best.distance) {
			best = { version: candidate.version, distance };
		}
	}

	if (best === null || best.distance > 3) {
		return null;
	}

	return best.version;
}

/** Exposed for the minimum-distance tests, which are a theorem worth checking. */
export const ALL_FORMAT_CODEWORDS: readonly number[] = FORMAT_CODEWORDS.map((c) => c.bits);
export const ALL_VERSION_CODEWORDS: readonly number[] = VERSION_CODEWORDS.map((c) => c.bits);
export { EC_FROM_FORMAT_BITS };
