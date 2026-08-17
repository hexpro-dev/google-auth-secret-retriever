import { describe, expect, it } from 'vitest';
import { Base32DecodeError } from '../../src/errors.js';
import { decodeBase32, encodeBase32, isValidBase32 } from '../../src/encoding/base32.js';

const ascii = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * RFC 4648 section 10 gives base32 vectors with padding. This package encodes
 * without it (authenticators do), so the expected values are the RFC's with the
 * '=' run removed, and the padded forms are asserted separately on decode.
 */
const RFC_4648_VECTORS: ReadonlyArray<readonly [input: string, unpadded: string, padded: string]> =
	[
		['', '', ''],
		['f', 'MY', 'MY======'],
		['fo', 'MZXQ', 'MZXQ===='],
		['foo', 'MZXW6', 'MZXW6==='],
		['foob', 'MZXW6YQ', 'MZXW6YQ='],
		['fooba', 'MZXW6YTB', 'MZXW6YTB'],
		['foobar', 'MZXW6YTBOI', 'MZXW6YTBOI======'],
	];

describe('encodeBase32', () => {
	it.each(RFC_4648_VECTORS)('encodes %j as %j (RFC 4648)', (input, unpadded) => {
		expect(encodeBase32(ascii(input))).toBe(unpadded);
	});

	it('never emits padding', () => {
		for (let length = 0; length <= 40; length += 1) {
			expect(encodeBase32(new Uint8Array(length))).not.toContain('=');
		}
	});

	it('never emits lowercase', () => {
		const bytes = new Uint8Array(64);
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = i * 4;
		}
		expect(encodeBase32(bytes)).toBe(encodeBase32(bytes).toUpperCase());
	});

	it('produces the lengths real Google Authenticator secrets have', () => {
		// Confirmed against a real export: 10-byte and 20-byte secrets, which
		// are what the two accounts in it carried.
		expect(encodeBase32(new Uint8Array(10))).toHaveLength(16);
		expect(encodeBase32(new Uint8Array(20))).toHaveLength(32);
	});
});

describe('decodeBase32', () => {
	it.each(RFC_4648_VECTORS)('decodes the unpadded form of %j', (input, unpadded) => {
		expect(text(decodeBase32(unpadded))).toBe(input);
	});

	it.each(RFC_4648_VECTORS)('decodes the padded form of %j', (input, _unpadded, padded) => {
		expect(text(decodeBase32(padded))).toBe(input);
	});

	it('accepts lowercase, because people retype secrets off a screen', () => {
		expect(text(decodeBase32('mzxw6ytboi'))).toBe('foobar');
	});

	it('accepts mixed case', () => {
		expect(text(decodeBase32('MzXw6YtBoI'))).toBe('foobar');
	});

	it('ignores the spacing authenticators use when displaying a secret', () => {
		expect(text(decodeBase32('MZXW 6YTB OI'))).toBe('foobar');
		expect(text(decodeBase32('MZXW-6YTB-OI'))).toBe('foobar');
		expect(text(decodeBase32('MZXW\n6YTB\tOI'))).toBe('foobar');
	});

	it('returns empty for an empty string', () => {
		expect(decodeBase32('')).toHaveLength(0);
		expect(decodeBase32('   ')).toHaveLength(0);
	});

	it.each(['0', '1', '8', '9'])(
		'rejects %j rather than aliasing it the way Crockford base32 would',
		(character) => {
			// Aliasing 0 to O would accept a mistyped secret and hand back key
			// material that generates wrong codes, with nothing on screen to
			// say so. A visible rejection is the safer failure.
			expect(() => decodeBase32(`MZXW${character}YTB`)).toThrow(Base32DecodeError);
		},
	);

	it('reports where the invalid character was', () => {
		try {
			decodeBase32('MZXW0YTB');
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(Base32DecodeError);
			expect((error as Base32DecodeError).index).toBe(4);
			expect((error as Base32DecodeError).code).toBe('secret/bad-base32');
		}
	});

	it('rejects a final character carrying bits that should be zero', () => {
		// Two characters carry 10 bits, of which 8 are a byte and 2 are padding
		// that a conforming encoder leaves zero. 'A' is 0 so 'MA' is clean;
		// 'B' is 1 so 'MB' has a stray bit and cannot have come from an encoder.
		expect(() => decodeBase32('MA')).not.toThrow();
		expect(() => decodeBase32('MB')).toThrow(Base32DecodeError);
	});

	it('round trips every length from 0 to 64 bytes', () => {
		for (let length = 0; length <= 64; length += 1) {
			const bytes = new Uint8Array(length);
			for (let i = 0; i < length; i += 1) {
				// Deterministic spread across the byte range, no RNG.
				bytes[i] = (i * 37 + length * 11) & 0xff;
			}
			expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
		}
	});
});

describe('isValidBase32', () => {
	it('accepts what decodeBase32 accepts', () => {
		expect(isValidBase32('MZXW6YTBOI')).toBe(true);
		expect(isValidBase32('mzxw 6ytb oi')).toBe(true);
		expect(isValidBase32('')).toBe(true);
	});

	it('rejects what decodeBase32 rejects, without throwing', () => {
		expect(isValidBase32('MZXW0YTB')).toBe(false);
		expect(isValidBase32('not base32!')).toBe(false);
	});
});
