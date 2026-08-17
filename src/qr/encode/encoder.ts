import { QrCapacityError, QrUnsupportedFeatureError } from '../../errors.js';
import type { EcLevel, QrMode } from '../../types.js';
import { encodeFormatInfo, encodeVersionInfo } from '../bch.js';
import { BitWriter } from '../bit-buffer.js';
import { BitMatrix } from '../bit-matrix.js';
import { drawFunctionPatterns, walkDataModules } from '../function-patterns.js';
import { MASK_PATTERNS, penaltyScore } from '../mask.js';
import { rsEncode } from '../reed-solomon.js';
import {
	ALPHANUMERIC_CHARS,
	MODE_BITS,
	REMAINDER_BITS,
	charCountBits,
	dimensionForVersion,
	ecBlocksFor,
	formatInfoPositions,
	versionInfoPositions,
} from '../tables.js';

/**
 * QR symbol encoding.
 *
 * Built before the decoder on purpose. A decoder tested only against its own
 * encoder proves that the two agree, not that either is right, so this half is
 * pinned to the specification first (the ISO/IEC 18004 Annex I worked example,
 * module for module) and then used as a generator of ground truth for the other
 * half. Getting that order backwards is how a QR implementation ends up
 * self-consistently wrong.
 */

export interface QrEncodeOptions {
	readonly ecLevel?: EcLevel;
	readonly minVersion?: number;
	readonly maxVersion?: number;
	/** Force a mask, rather than choosing by penalty score. For tests. */
	readonly mask?: number;
	/** Force a mode. Defaults to the narrowest one that can hold the input. */
	readonly mode?: QrMode;
}

export interface QrSymbol {
	readonly matrix: BitMatrix;
	readonly version: number;
	readonly ecLevel: EcLevel;
	readonly mask: number;
	readonly moduleCount: number;
}

/* ── Segment encoding ─────────────────────────────────────────────────────── */

function canBeNumeric(text: string): boolean {
	return /^[0-9]*$/.test(text);
}

function canBeAlphanumeric(text: string): boolean {
	for (const character of text) {
		if (!ALPHANUMERIC_CHARS.includes(character)) {
			return false;
		}
	}
	return true;
}

function chooseMode(text: string): QrMode {
	if (canBeNumeric(text)) {
		return 'numeric';
	}
	if (canBeAlphanumeric(text)) {
		return 'alphanumeric';
	}
	return 'byte';
}

/** Character count for the header, which is not always the string length. */
function characterCount(text: string, mode: QrMode): number {
	// Byte mode counts UTF-8 bytes, and an emoji is four of them.
	return mode === 'byte' ? new TextEncoder().encode(text).length : text.length;
}

function writeSegment(writer: BitWriter, text: string, mode: QrMode): void {
	switch (mode) {
		case 'numeric': {
			// Three digits per 10 bits, with 7 and 4 bits for a short tail.
			let i = 0;
			for (; i + 3 <= text.length; i += 3) {
				writer.put(Number.parseInt(text.slice(i, i + 3), 10), 10);
			}
			const rest = text.length - i;
			if (rest === 2) {
				writer.put(Number.parseInt(text.slice(i), 10), 7);
			} else if (rest === 1) {
				writer.put(Number.parseInt(text.slice(i), 10), 4);
			}
			return;
		}
		case 'alphanumeric': {
			// Two characters per 11 bits, base 45.
			let i = 0;
			for (; i + 2 <= text.length; i += 2) {
				const high = ALPHANUMERIC_CHARS.indexOf(text[i] as string);
				const low = ALPHANUMERIC_CHARS.indexOf(text[i + 1] as string);
				writer.put(high * 45 + low, 11);
			}
			if (i < text.length) {
				writer.put(ALPHANUMERIC_CHARS.indexOf(text[i] as string), 6);
			}
			return;
		}
		case 'byte':
			writer.putBytes(new TextEncoder().encode(text));
			return;
		case 'kanji':
			// Reading kanji mode is supported; writing it is not. Nothing this
			// package produces needs it, and an untested encoder for it would
			// be worse than an honest refusal.
			throw new QrUnsupportedFeatureError('mode', 'writing kanji mode');
	}
}

/** Bits the segment body occupies, excluding the mode and count header. */
function segmentBodyBits(text: string, mode: QrMode): number {
	switch (mode) {
		case 'numeric': {
			const groups = Math.floor(text.length / 3);
			const rest = text.length % 3;
			return groups * 10 + (rest === 2 ? 7 : rest === 1 ? 4 : 0);
		}
		case 'alphanumeric':
			return Math.floor(text.length / 2) * 11 + (text.length % 2) * 6;
		case 'byte':
			return new TextEncoder().encode(text).length * 8;
		case 'kanji':
			throw new QrUnsupportedFeatureError('mode', 'writing kanji mode');
	}
}

function dataCapacityCodewords(version: number, level: EcLevel): number {
	const spec = ecBlocksFor(version, level);
	return (
		spec.group1Blocks * spec.group1DataCodewords + spec.group2Blocks * spec.group2DataCodewords
	);
}

/* ── Codeword assembly ────────────────────────────────────────────────────── */

function buildDataCodewords(
	text: string,
	mode: QrMode,
	version: number,
	level: EcLevel,
): Uint8Array {
	const capacityBits = dataCapacityCodewords(version, level) * 8;

	const writer = new BitWriter();
	writer.put(MODE_BITS[mode], 4);
	writer.put(characterCount(text, mode), charCountBits(mode, version));
	writeSegment(writer, text, mode);

	// Terminator: up to four zero bits, fewer if the symbol is nearly full.
	const terminator = Math.min(4, capacityBits - writer.bitLength);
	writer.put(0, terminator);
	writer.padToByte();

	const codewords = new Uint8Array(dataCapacityCodewords(version, level));
	const written = writer.toBytes();
	codewords.set(written);

	// Alternating pad codewords, specified by value, filling the remainder.
	for (let i = written.length; i < codewords.length; i += 1) {
		codewords[i] = (i - written.length) % 2 === 0 ? 0xec : 0x11;
	}

	return codewords;
}

/**
 * Split into blocks, add error correction, and interleave.
 *
 * The interleaving is what makes a QR code survive a smudge: consecutive
 * modules in the symbol belong to different blocks, so damage that would
 * overwhelm one block is spread across all of them.
 */
function interleave(dataCodewords: Uint8Array, version: number, level: EcLevel): Uint8Array {
	const spec = ecBlocksFor(version, level);
	const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];

	let offset = 0;
	for (let i = 0; i < spec.group1Blocks; i += 1) {
		const data = dataCodewords.subarray(offset, offset + spec.group1DataCodewords);
		offset += spec.group1DataCodewords;
		blocks.push({ data, ec: rsEncode(data, spec.ecCodewordsPerBlock).subarray(data.length) });
	}
	for (let i = 0; i < spec.group2Blocks; i += 1) {
		const data = dataCodewords.subarray(offset, offset + spec.group2DataCodewords);
		offset += spec.group2DataCodewords;
		blocks.push({ data, ec: rsEncode(data, spec.ecCodewordsPerBlock).subarray(data.length) });
	}

	const out: number[] = [];
	const maxData = Math.max(spec.group1DataCodewords, spec.group2DataCodewords);
	for (let i = 0; i < maxData; i += 1) {
		for (const block of blocks) {
			if (i < block.data.length) {
				out.push(block.data[i] as number);
			}
		}
	}
	for (let i = 0; i < spec.ecCodewordsPerBlock; i += 1) {
		for (const block of blocks) {
			out.push(block.ec[i] as number);
		}
	}

	return new Uint8Array(out);
}

/* ── Module placement ─────────────────────────────────────────────────────── */

function placeFormatInfo(matrix: BitMatrix, level: EcLevel, mask: number): void {
	const dimension = matrix.width;
	const bits = encodeFormatInfo(level, mask);
	const { first, second } = formatInfoPositions(dimension);

	// Most significant bit first: position 0 of each list takes bit 14. The
	// natural `bits >>> i` loop walks the other way, which is the trap.
	for (let i = 0; i < 15; i += 1) {
		const bit = ((bits >>> (14 - i)) & 1) === 1;
		const [fx, fy] = first[i] as readonly [number, number];
		const [sx, sy] = second[i] as readonly [number, number];
		matrix.set(fx, fy, bit);
		matrix.set(sx, sy, bit);
	}

	// The dark module. Always set, always here, carries no information. It sits
	// inside the second copy's column run, so it is written after it.
	matrix.set(8, dimension - 8, true);
}

function placeVersionInfo(matrix: BitMatrix, version: number): void {
	if (version < 7) {
		return;
	}
	const bits = encodeVersionInfo(version);
	const { first, second } = versionInfoPositions(matrix.width);

	// Least significant bit first here, unlike the format information.
	for (let i = 0; i < 18; i += 1) {
		const bit = ((bits >>> i) & 1) === 1;
		const [fx, fy] = first[i] as readonly [number, number];
		const [sx, sy] = second[i] as readonly [number, number];
		matrix.set(fx, fy, bit);
		matrix.set(sx, sy, bit);
	}
}

/* ── The pipeline ─────────────────────────────────────────────────────────── */

function buildMatrix(
	codewords: Uint8Array,
	version: number,
	level: EcLevel,
	mask: number,
): BitMatrix {
	const dimension = dimensionForVersion(version);
	const matrix = new BitMatrix(dimension);
	const reserved = new BitMatrix(dimension);

	drawFunctionPatterns(matrix, reserved, version);

	// Data, in the zigzag order the specification lays out. The remainder bits
	// at the end are zero and carry nothing, but they occupy module positions,
	// so the traversal has to step over them rather than stop early.
	const totalBits = codewords.length * 8 + (REMAINDER_BITS[version - 1] as number);
	walkDataModules(dimension, reserved, (x, y, index) => {
		if (index >= totalBits) {
			return;
		}
		const byte = codewords[index >>> 3];
		const bit = byte === undefined ? false : ((byte >>> (7 - (index & 7))) & 1) === 1;
		matrix.set(x, y, bit);
	});

	// Masking applies to the data region only; function patterns are untouched.
	const predicate = MASK_PATTERNS[mask] as (row: number, column: number) => boolean;
	for (let y = 0; y < dimension; y += 1) {
		for (let x = 0; x < dimension; x += 1) {
			if (!reserved.get(x, y)) {
				matrix.xor(x, y, predicate(y, x));
			}
		}
	}

	placeFormatInfo(matrix, level, mask);
	placeVersionInfo(matrix, version);

	return matrix;
}

export function encodeQr(text: string, options: QrEncodeOptions = {}): QrSymbol {
	const ecLevel = options.ecLevel ?? 'M';
	const minVersion = Math.max(1, options.minVersion ?? 1);
	const maxVersion = Math.min(40, options.maxVersion ?? 40);
	const mode = options.mode ?? chooseMode(text);

	if (mode === 'numeric' && !canBeNumeric(text)) {
		throw new QrUnsupportedFeatureError('mode', 'numeric mode cannot hold this text');
	}
	if (mode === 'alphanumeric' && !canBeAlphanumeric(text)) {
		throw new QrUnsupportedFeatureError('mode', 'alphanumeric mode cannot hold this text');
	}

	let version = -1;
	for (let candidate = minVersion; candidate <= maxVersion; candidate += 1) {
		const needed = 4 + charCountBits(mode, candidate) + segmentBodyBits(text, mode);
		if (needed <= dataCapacityCodewords(candidate, ecLevel) * 8) {
			version = candidate;
			break;
		}
	}

	if (version === -1) {
		const bodyBytes = Math.ceil(segmentBodyBits(text, mode) / 8);
		throw new QrCapacityError(bodyBytes, dataCapacityCodewords(maxVersion, ecLevel));
	}

	const dataCodewords = buildDataCodewords(text, mode, version, ecLevel);
	const codewords = interleave(dataCodewords, version, ecLevel);

	if (options.mask !== undefined) {
		return {
			matrix: buildMatrix(codewords, version, ecLevel, options.mask),
			version,
			ecLevel,
			mask: options.mask,
			moduleCount: dimensionForVersion(version),
		};
	}

	// Try all eight and keep the least penalised, which is what the
	// specification prescribes and what keeps a symbol scannable.
	let best: { matrix: BitMatrix; mask: number; score: number } | null = null;
	for (let mask = 0; mask < 8; mask += 1) {
		const matrix = buildMatrix(codewords, version, ecLevel, mask);
		const score = penaltyScore(matrix);
		if (best === null || score < best.score) {
			best = { matrix, mask, score };
		}
	}

	return {
		matrix: best!.matrix,
		version,
		ecLevel,
		mask: best!.mask,
		moduleCount: dimensionForVersion(version),
	};
}
