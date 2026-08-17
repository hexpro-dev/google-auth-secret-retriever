import { describe, expect, it } from 'vitest';
import {
	ALIGNMENT_CENTRES,
	CHAR_COUNT_BITS,
	EC_BLOCKS,
	EC_FORMAT_BITS,
	EC_FROM_FORMAT_BITS,
	EC_INDEX,
	EC_LEVELS,
	REMAINDER_BITS,
	TOTAL_CODEWORDS,
	charCountBits,
	dimensionForVersion,
	ecBlocksFor,
	versionForDimension,
} from '../../src/qr/tables.js';

/**
 * These are invariants the specification guarantees, not assertions copied from
 * the same source as the table. That is the point: they catch a transcription
 * slip in any of 160 rows without anyone proofreading it, because a mistyped
 * codeword count stops the arithmetic from closing.
 */

const VERSIONS = Array.from({ length: 40 }, (_, i) => i + 1);

describe('EC_BLOCKS arithmetic', () => {
	it.each(VERSIONS)('version %i blocks sum to the symbol capacity at every level', (version) => {
		for (const level of EC_LEVELS) {
			const spec = ecBlocksFor(version, level);
			const total =
				spec.group1Blocks * (spec.group1DataCodewords + spec.ecCodewordsPerBlock) +
				spec.group2Blocks * (spec.group2DataCodewords + spec.ecCodewordsPerBlock);

			expect(total, `version ${version} level ${level}`).toBe(TOTAL_CODEWORDS[version - 1]);
		}
	});

	it.each(VERSIONS)('version %i group 2 blocks hold exactly one more data codeword', (version) => {
		for (const level of EC_LEVELS) {
			const spec = ecBlocksFor(version, level);
			if (spec.group2Blocks > 0) {
				expect(spec.group2DataCodewords, `version ${version} level ${level}`).toBe(
					spec.group1DataCodewords + 1,
				);
			} else {
				expect(spec.group2DataCodewords).toBe(0);
			}
		}
	});

	it('has one row per version and level', () => {
		expect(EC_BLOCKS).toHaveLength(40 * 4);
		expect(TOTAL_CODEWORDS).toHaveLength(40);
		expect(REMAINDER_BITS).toHaveLength(40);
		expect(ALIGNMENT_CENTRES).toHaveLength(40);
	});

	it('always has at least one block', () => {
		for (const version of VERSIONS) {
			for (const level of EC_LEVELS) {
				const spec = ecBlocksFor(version, level);
				expect(spec.group1Blocks).toBeGreaterThan(0);
			}
		}
	});

	it('gives stronger levels less room for data', () => {
		for (const version of VERSIONS) {
			const capacities = EC_LEVELS.map((level) => {
				const spec = ecBlocksFor(version, level);
				return (
					spec.group1Blocks * spec.group1DataCodewords +
					spec.group2Blocks * spec.group2DataCodewords
				);
			});

			for (let i = 1; i < capacities.length; i += 1) {
				expect(capacities[i]!, `version ${version}`).toBeLessThan(capacities[i - 1]!);
			}
		}
	});

	it('has a sane error-correction block size everywhere', () => {
		// Deliberately not "always even". Several small versions use an odd
		// count (version 1 is 7, 10, 13, 17), and Reed-Solomon simply corrects
		// floor(ec / 2) errors per block in those cases.
		for (const spec of EC_BLOCKS) {
			expect(spec.ecCodewordsPerBlock).toBeGreaterThanOrEqual(7);
			expect(spec.ecCodewordsPerBlock).toBeLessThanOrEqual(30);
		}
	});
});

describe('the two error-correction level orderings', () => {
	it('are genuinely different mappings', () => {
		// The classic QR bug is treating these as the same table. They agree on
		// nothing except that four levels exist.
		expect(EC_INDEX).toEqual({ L: 0, M: 1, Q: 2, H: 3 });
		expect(EC_FORMAT_BITS).toEqual({ M: 0, L: 1, H: 2, Q: 3 });
		expect(EC_INDEX).not.toEqual(EC_FORMAT_BITS);
	});

	it('disagree on every single level, so confusing them is never harmless', () => {
		// Worth pinning: the two orderings are a permutation with no fixed
		// point. There is no level at which swapping them happens to work, so
		// any code path that picks the wrong one is wrong for every symbol it
		// touches rather than for some of them.
		const differing = EC_LEVELS.filter((level) => EC_INDEX[level] !== EC_FORMAT_BITS[level]);
		expect(differing).toEqual(['L', 'M', 'Q', 'H']);
	});

	it('round trips through the format-bit reverse lookup', () => {
		for (const level of EC_LEVELS) {
			expect(EC_FROM_FORMAT_BITS[EC_FORMAT_BITS[level]]).toBe(level);
		}
	});
});

describe('alignment patterns', () => {
	it.each(VERSIONS)('version %i has the count the version implies', (version) => {
		const centres = ALIGNMENT_CENTRES[version - 1]!;
		const expected = version === 1 ? 0 : Math.floor(version / 7) + 2;

		expect(centres).toHaveLength(expected);
	});

	it('starts at 6 and ends 7 modules from the far edge', () => {
		for (const version of VERSIONS.slice(1)) {
			const centres = ALIGNMENT_CENTRES[version - 1]!;

			expect(centres[0]).toBe(6);
			expect(centres[centres.length - 1]).toBe(dimensionForVersion(version) - 7);
		}
	});

	it('is strictly increasing and always inside the symbol', () => {
		for (const version of VERSIONS) {
			const centres = ALIGNMENT_CENTRES[version - 1]!;
			const dimension = dimensionForVersion(version);

			for (let i = 0; i < centres.length; i += 1) {
				expect(centres[i]).toBeGreaterThanOrEqual(6);
				expect(centres[i]).toBeLessThan(dimension - 6);
				if (i > 0) {
					expect(centres[i]!).toBeGreaterThan(centres[i - 1]!);
				}
			}
		}
	});
});

describe('dimensions', () => {
	it('runs from 21 to 177 in steps of 4', () => {
		expect(dimensionForVersion(1)).toBe(21);
		expect(dimensionForVersion(40)).toBe(177);

		for (const version of VERSIONS) {
			expect(versionForDimension(dimensionForVersion(version))).toBe(version);
		}
	});

	it('rejects a dimension that is not a legal symbol size', () => {
		expect(versionForDimension(20)).toBeNull();
		expect(versionForDimension(22)).toBeNull();
		expect(versionForDimension(181)).toBeNull();
	});
});

describe('character count widths', () => {
	it('switches band at versions 10 and 27', () => {
		expect(charCountBits('byte', 9)).toBe(CHAR_COUNT_BITS.byte[0]);
		expect(charCountBits('byte', 10)).toBe(CHAR_COUNT_BITS.byte[1]);
		expect(charCountBits('byte', 26)).toBe(CHAR_COUNT_BITS.byte[1]);
		expect(charCountBits('byte', 27)).toBe(CHAR_COUNT_BITS.byte[2]);
	});

	it('never narrows as the version grows', () => {
		for (const mode of ['numeric', 'alphanumeric', 'byte', 'kanji'] as const) {
			const [small, medium, large] = CHAR_COUNT_BITS[mode];
			expect(medium).toBeGreaterThanOrEqual(small);
			expect(large).toBeGreaterThanOrEqual(medium);
		}
	});
});

describe('remainder bits', () => {
	it('is always fewer than a codeword', () => {
		for (const bits of REMAINDER_BITS) {
			expect(bits).toBeGreaterThanOrEqual(0);
			expect(bits).toBeLessThan(8);
		}
	});
});
