import { describe, expect, it } from 'vitest';
import { bytesEqual, fromHex, toHex, wipe } from '../../src/encoding/bytes.js';

/**
 * The byte helpers are part of the published API, and `wipe` is the one the
 * privacy copy leans on, so what is pinned here is the contract a caller can
 * rely on: how far `wipe` reaches, and what `fromHex` does with input that is
 * not hex.
 */

describe('wipe', () => {
	it('zeroes every byte', () => {
		const bytes = new Uint8Array([0x01, 0x7f, 0x80, 0xff]);

		wipe(bytes);

		expect(Array.from(bytes)).toEqual([0, 0, 0, 0]);
	});

	it('zeroes only the window it was handed', () => {
		// A Uint8Array can be a view onto a larger buffer, and secrets arrive as
		// slices of a decoded payload. Wiping one account's view must stop at
		// its own bounds, or clearing a single account would corrupt the rest.
		const buffer = new Uint8Array(8).fill(0xff);
		const view = buffer.subarray(2, 5);

		wipe(view);

		expect(Array.from(buffer)).toEqual([0xff, 0xff, 0, 0, 0, 0xff, 0xff, 0xff]);
	});

	it('accepts an empty array', () => {
		expect(() => wipe(new Uint8Array(0))).not.toThrow();
	});
});

describe('bytesEqual', () => {
	it('is true for equal contents held in different arrays', () => {
		expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
	});

	it('is false when a byte differs, wherever it sits', () => {
		// The last position is where a loop bound that stops one short would
		// hide, and it would hide as a false positive.
		expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([9, 2, 3]))).toBe(false);
		expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(false);
		expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 9]))).toBe(false);
	});

	it('is false when one is a prefix of the other, in either order', () => {
		expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
		expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
	});

	it('is true for two empty arrays', () => {
		expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});

	it('compares the view, not the buffer behind it', () => {
		// One side is a window onto a larger buffer with different bytes either
		// side of it. Reading the underlying buffer instead of the view would
		// report a difference that is not in the data the caller passed.
		const buffer = new Uint8Array([9, 9, 1, 2, 3, 9]);

		expect(bytesEqual(buffer.subarray(2, 5), new Uint8Array([1, 2, 3]))).toBe(true);
	});
});

describe('toHex', () => {
	it('pads every byte to two lowercase digits', () => {
		// Without the pad, 0x0f would render as one digit and shift everything
		// after it, so the output would still parse and mean something else.
		expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0xa0]))).toBe('000fffa0');
	});

	it('returns an empty string for an empty array', () => {
		expect(toHex(new Uint8Array(0))).toBe('');
	});
});

describe('fromHex', () => {
	it('round trips every byte value', () => {
		const all = new Uint8Array(256);
		for (let i = 0; i < all.length; i += 1) {
			all[i] = i;
		}

		expect(fromHex(toHex(all))).toEqual(all);
	});

	it('accepts either case', () => {
		expect(fromHex('DEADBEEF')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
		expect(fromHex('DeAdBeEf')).toEqual(fromHex('deadbeef'));
	});

	it('ignores whitespace, because hex gets pasted in groups', () => {
		expect(fromHex('de ad\nbe\tef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
	});

	it('returns an empty array for an empty string', () => {
		expect(fromHex('')).toHaveLength(0);
		expect(fromHex('   ')).toHaveLength(0);
	});

	it('rejects an odd number of digits rather than guessing which one is missing', () => {
		expect(() => fromHex('abc')).toThrow(/even length/);
	});

	it('rejects a pair with no hex digit in it, and says where', () => {
		expect(() => fromHex('dezz')).toThrow(/invalid hex at index 2/);
	});

	it('accepts a pair that merely starts with a hex digit, which is looser than it looks', () => {
		// Pinning current behaviour, not endorsing it. Each pair goes through
		// Number.parseInt, which stops at the first character it cannot use
		// instead of failing, and which honours a leading sign. So a typo in the
		// second position is read as a single digit, and '-1' lands as 0xff.
		// Nothing in this package feeds fromHex untrusted input, but it is
		// exported, so the leniency should be visible rather than discovered.
		expect(fromHex('4z')).toEqual(new Uint8Array([0x04]));
		expect(fromHex('-1')).toEqual(new Uint8Array([0xff]));
	});
});
