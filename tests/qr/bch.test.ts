import { describe, expect, it } from 'vitest';
import {
	ALL_FORMAT_CODEWORDS,
	ALL_VERSION_CODEWORDS,
	decodeFormatInfo,
	decodeVersionInfo,
	encodeFormatInfo,
	encodeVersionInfo,
} from '../../src/qr/bch.js';
import { EC_LEVELS } from '../../src/qr/tables.js';

const bits = (value: number, width: number) => value.toString(2).padStart(width, '0');

function hammingDistance(a: number, b: number): number {
	let difference = a ^ b;
	let count = 0;
	while (difference !== 0) {
		difference &= difference - 1;
		count += 1;
	}
	return count;
}

describe('format information against published values', () => {
	it('encodes level L with mask 0 as the specification lists it', () => {
		expect(bits(encodeFormatInfo('L', 0), 15)).toBe('111011111000100');
	});

	it('encodes level M with mask 5 as the specification lists it', () => {
		expect(bits(encodeFormatInfo('M', 5), 15)).toBe('100000011001110');
	});

	it('never produces the all-zero codeword', () => {
		// The XOR mask exists precisely so a blank region of a damaged symbol
		// cannot read as valid format information.
		expect(ALL_FORMAT_CODEWORDS).not.toContain(0);
	});

	it('produces exactly 32 distinct codewords', () => {
		expect(ALL_FORMAT_CODEWORDS).toHaveLength(32);
		expect(new Set(ALL_FORMAT_CODEWORDS).size).toBe(32);
	});

	it('has a minimum distance of 7, which is the BCH(15,5) theorem', () => {
		// Not a value copied from the same source as the encoder: it follows
		// from the code's construction, so reproducing it means the generator
		// polynomial and the mask are both right.
		let minimum = Infinity;
		for (let i = 0; i < ALL_FORMAT_CODEWORDS.length; i += 1) {
			for (let j = i + 1; j < ALL_FORMAT_CODEWORDS.length; j += 1) {
				minimum = Math.min(
					minimum,
					hammingDistance(ALL_FORMAT_CODEWORDS[i]!, ALL_FORMAT_CODEWORDS[j]!),
				);
			}
		}
		expect(minimum).toBe(7);
	});
});

describe('decodeFormatInfo', () => {
	it('round trips every level and mask', () => {
		for (const level of EC_LEVELS) {
			for (let mask = 0; mask < 8; mask += 1) {
				const decoded = decodeFormatInfo(encodeFormatInfo(level, mask));

				expect(decoded, `${level} mask ${mask}`).not.toBeNull();
				expect(decoded!.ecLevel).toBe(level);
				expect(decoded!.mask).toBe(mask);
				expect(decoded!.errorsCorrected).toBe(0);
			}
		}
	});

	it.each([1, 2, 3])('corrects %i flipped bits', (errorCount) => {
		for (const level of EC_LEVELS) {
			for (let mask = 0; mask < 8; mask += 1) {
				const clean = encodeFormatInfo(level, mask);

				// Every distinct combination of positions at this error count.
				for (let a = 0; a < 15; a += 1) {
					const positions = [a, (a + 5) % 15, (a + 9) % 15].slice(0, errorCount);
					let corrupted = clean;
					for (const position of new Set(positions)) {
						corrupted ^= 1 << position;
					}

					const decoded = decodeFormatInfo(corrupted);
					expect(decoded, `${level} mask ${mask} bits ${positions}`).not.toBeNull();
					expect(decoded!.ecLevel).toBe(level);
					expect(decoded!.mask).toBe(mask);
				}
			}
		}
	});

	it('reports how many bits it had to correct', () => {
		const clean = encodeFormatInfo('Q', 3);
		expect(decodeFormatInfo(clean ^ 0b101)!.errorsCorrected).toBe(2);
	});

	it('ignores bits above the 15 it reads', () => {
		const clean = encodeFormatInfo('H', 7);
		expect(decodeFormatInfo(clean | 0xff0000)).toEqual(decodeFormatInfo(clean));
	});
});

describe('version information against published values', () => {
	it('encodes version 7 as the specification lists it', () => {
		expect(bits(encodeVersionInfo(7), 18)).toBe('000111110010010100');
	});

	it('covers versions 7 to 40 and nothing else', () => {
		expect(ALL_VERSION_CODEWORDS).toHaveLength(34);
		expect(() => encodeVersionInfo(6)).toThrow();
		expect(() => encodeVersionInfo(41)).toThrow();
	});

	it('has a minimum distance of 8, which is the BCH(18,6) theorem', () => {
		let minimum = Infinity;
		for (let i = 0; i < ALL_VERSION_CODEWORDS.length; i += 1) {
			for (let j = i + 1; j < ALL_VERSION_CODEWORDS.length; j += 1) {
				minimum = Math.min(
					minimum,
					hammingDistance(ALL_VERSION_CODEWORDS[i]!, ALL_VERSION_CODEWORDS[j]!),
				);
			}
		}
		expect(minimum).toBe(8);
	});
});

describe('decodeVersionInfo', () => {
	it('round trips every version that carries version information', () => {
		for (let version = 7; version <= 40; version += 1) {
			expect(decodeVersionInfo(encodeVersionInfo(version))).toBe(version);
		}
	});

	it.each([1, 2, 3])('corrects %i flipped bits', (errorCount) => {
		for (let version = 7; version <= 40; version += 1) {
			const clean = encodeVersionInfo(version);

			for (let a = 0; a < 18; a += 1) {
				const positions = [a, (a + 6) % 18, (a + 11) % 18].slice(0, errorCount);
				let corrupted = clean;
				for (const position of new Set(positions)) {
					corrupted ^= 1 << position;
				}

				expect(decodeVersionInfo(corrupted), `version ${version} bits ${positions}`).toBe(version);
			}
		}
	});

	it('refuses to guess when the bits are too far from any codeword', () => {
		// Guessing the version wrong means sampling the whole symbol on the
		// wrong grid, which is worse than admitting failure.
		//
		// Constructed rather than picked: minimum distance is 8, so a valid
		// codeword with 4 bits flipped sits at distance 4 from its own
		// codeword and at least 4 from every other, which is outside the
		// 3-bit correction radius by construction.
		const corrupted = encodeVersionInfo(20) ^ 0b1111;

		expect(decodeVersionInfo(corrupted)).toBeNull();
	});

	it('refuses every 4-bit corruption, for every version', () => {
		for (let version = 7; version <= 40; version += 1) {
			const clean = encodeVersionInfo(version);
			for (let a = 0; a < 18; a += 1) {
				const corrupted =
					clean ^ (1 << a) ^ (1 << ((a + 4) % 18)) ^ (1 << ((a + 9) % 18)) ^ (1 << ((a + 13) % 18));

				expect(decodeVersionInfo(corrupted), `version ${version} from bit ${a}`).toBeNull();
			}
		}
	});
});
