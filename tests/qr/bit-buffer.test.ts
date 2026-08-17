import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from '../../src/qr/bit-buffer.js';
import { BitMatrix } from '../../src/qr/bit-matrix.js';

describe('BitWriter', () => {
	it('writes most significant bit first', () => {
		// The single most important property. Every bit field in QR is
		// MSB-first, and getting it backwards produces output that looks like
		// data and decodes to rubbish.
		expect(new BitWriter().put(0b101, 3).toBytes()).toEqual(new Uint8Array([0b10100000]));
	});

	it('packs consecutive fields without gaps', () => {
		const bytes = new BitWriter().put(0b0100, 4).put(0b0000_0011, 8).put(0b1010, 4).toBytes();

		expect(bytes).toEqual(new Uint8Array([0b0100_0000, 0b0011_1010]));
	});

	it('tracks bit length across partial bytes', () => {
		const writer = new BitWriter();
		expect(writer.bitLength).toBe(0);
		writer.put(0, 4);
		expect(writer.bitLength).toBe(4);
		writer.put(0, 8);
		expect(writer.bitLength).toBe(12);
	});

	it('left-aligns a partial final byte', () => {
		expect(new BitWriter().put(0b1, 1).toBytes()).toEqual(new Uint8Array([0b1000_0000]));
	});

	it('pads to a byte boundary on request', () => {
		const writer = new BitWriter().put(0b111, 3).padToByte();

		expect(writer.bitLength % 8).toBe(0);
		expect(writer.toBytes()).toEqual(new Uint8Array([0b1110_0000]));
	});

	it('writes whole bytes unchanged', () => {
		const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
		expect(new BitWriter().putBytes(bytes).toBytes()).toEqual(bytes);
	});
});

describe('BitReader', () => {
	it('reads most significant bit first', () => {
		expect(new BitReader(new Uint8Array([0b1010_0000])).read(3)).toBe(0b101);
	});

	it('reads across byte boundaries', () => {
		const reader = new BitReader(new Uint8Array([0b0100_0000, 0b0011_1010]));

		expect(reader.read(4)).toBe(0b0100);
		expect(reader.read(8)).toBe(0b0000_0011);
		expect(reader.read(4)).toBe(0b1010);
	});

	it('reports how much is left', () => {
		const reader = new BitReader(new Uint8Array(2));
		expect(reader.remaining).toBe(16);
		reader.read(5);
		expect(reader.remaining).toBe(11);
	});

	it('refuses to read past the end', () => {
		expect(() => new BitReader(new Uint8Array(1)).read(9)).toThrow(RangeError);
	});
});

describe('BitWriter and BitReader together', () => {
	it('round trips every field width from 1 to 31', () => {
		for (let width = 1; width <= 31; width += 1) {
			const value = width === 31 ? 0x7fffffff : (1 << width) - 1;
			const bytes = new BitWriter().put(value, width).padToByte().toBytes();

			expect(new BitReader(bytes).read(width), `width ${width}`).toBe(value);
		}
	});

	it('round trips a mixed sequence of widths', () => {
		const fields: ReadonlyArray<readonly [value: number, bits: number]> = [
			[0b0100, 4],
			[42, 8],
			[0b1, 1],
			[1023, 10],
			[7, 3],
			[65535, 16],
		];

		const writer = new BitWriter();
		for (const [value, bits] of fields) {
			writer.put(value, bits);
		}
		const reader = new BitReader(writer.padToByte().toBytes());

		for (const [value, bits] of fields) {
			expect(reader.read(bits)).toBe(value);
		}
	});
});

describe('BitMatrix', () => {
	it('stores and returns modules', () => {
		const matrix = new BitMatrix(5, 3);
		matrix.set(4, 2, true);

		expect(matrix.get(4, 2)).toBe(true);
		expect(matrix.get(0, 0)).toBe(false);
	});

	it('treats out-of-bounds as light, which is what a quiet zone is', () => {
		const matrix = new BitMatrix(3);
		matrix.setRegion(0, 0, 3, 3, true);

		expect(matrix.getSafe(-1, 0)).toBe(false);
		expect(matrix.getSafe(3, 0)).toBe(false);
		expect(matrix.getSafe(1, 1)).toBe(true);
	});

	it('fills a region', () => {
		const matrix = new BitMatrix(6);
		matrix.setRegion(1, 1, 3, 2, true);

		expect(matrix.countDark()).toBe(6);
		expect(matrix.get(1, 1)).toBe(true);
		expect(matrix.get(3, 2)).toBe(true);
		expect(matrix.get(4, 1)).toBe(false);
	});

	it('xors only where the value is set', () => {
		const matrix = new BitMatrix(2);
		matrix.set(0, 0, true);
		matrix.xor(0, 0, true);
		matrix.xor(1, 1, false);

		expect(matrix.get(0, 0)).toBe(false);
		expect(matrix.get(1, 1)).toBe(false);
	});

	it('inverts every module', () => {
		const matrix = new BitMatrix(4);
		matrix.set(1, 1, true);
		const inverted = matrix.inverted();

		expect(inverted.get(1, 1)).toBe(false);
		expect(inverted.countDark()).toBe(15);
		// The original is untouched, which the decode ladder relies on.
		expect(matrix.countDark()).toBe(1);
	});

	it('mirrors horizontally', () => {
		const matrix = new BitMatrix(3, 1);
		matrix.set(0, 0, true);

		expect(matrix.mirrored().get(2, 0)).toBe(true);
		expect(matrix.mirrored().get(0, 0)).toBe(false);
	});

	it('clones without sharing storage', () => {
		const matrix = new BitMatrix(3);
		const copy = matrix.clone();
		copy.set(0, 0, true);

		expect(matrix.get(0, 0)).toBe(false);
	});
});
