import type { EcLevel } from '../../types.js';
import { rsDecode } from '../reed-solomon.js';
import { ecBlocksFor } from '../tables.js';

/**
 * Undo the interleaving and run error correction.
 *
 * Interleaving is what makes a QR code survive a smudge: consecutive modules in
 * the symbol belong to different blocks, so localised damage is spread thinly
 * across all of them rather than destroying one. Reading it back means walking
 * the same round-robin the encoder used.
 */

export interface BlockDecodeResult {
	readonly data: Uint8Array;
	readonly errorsCorrected: number;
	readonly blocks: number;
}

export function decodeBlocks(
	codewords: Uint8Array,
	version: number,
	level: EcLevel,
): BlockDecodeResult {
	const spec = ecBlocksFor(version, level);
	const blockCount = spec.group1Blocks + spec.group2Blocks;

	const dataLengths: number[] = [];
	for (let i = 0; i < spec.group1Blocks; i += 1) {
		dataLengths.push(spec.group1DataCodewords);
	}
	for (let i = 0; i < spec.group2Blocks; i += 1) {
		dataLengths.push(spec.group2DataCodewords);
	}

	const totalData = dataLengths.reduce((sum, length) => sum + length, 0);
	const expected = totalData + blockCount * spec.ecCodewordsPerBlock;
	if (codewords.length < expected) {
		throw new Error(
			`expected ${expected} codewords for version ${version}${level}, got ${codewords.length}`,
		);
	}

	const blocks = dataLengths.map((length) => ({
		data: new Uint8Array(length),
		ec: new Uint8Array(spec.ecCodewordsPerBlock),
	}));

	// Data codewords, round robin, skipping blocks that have already run out.
	let source = 0;
	const maxData = Math.max(spec.group1DataCodewords, spec.group2DataCodewords);
	for (let i = 0; i < maxData; i += 1) {
		for (let b = 0; b < blockCount; b += 1) {
			const block = blocks[b]!;
			if (i < block.data.length) {
				block.data[i] = codewords[source] as number;
				source += 1;
			}
		}
	}

	// Error-correction codewords, round robin, all blocks the same length.
	for (let i = 0; i < spec.ecCodewordsPerBlock; i += 1) {
		for (let b = 0; b < blockCount; b += 1) {
			blocks[b]!.ec[i] = codewords[source] as number;
			source += 1;
		}
	}

	const out = new Uint8Array(totalData);
	let offset = 0;
	let errorsCorrected = 0;

	for (const block of blocks) {
		const received = new Uint8Array(block.data.length + block.ec.length);
		received.set(block.data, 0);
		received.set(block.ec, block.data.length);

		const result = rsDecode(received, spec.ecCodewordsPerBlock);
		out.set(result.data, offset);
		offset += result.data.length;
		errorsCorrected += result.errorsCorrected;
	}

	return { data: out, errorsCorrected, blocks: blockCount };
}
