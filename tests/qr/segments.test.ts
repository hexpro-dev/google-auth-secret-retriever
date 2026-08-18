import { describe, expect, it } from 'vitest';
import { QrUnsupportedFeatureError } from '../../src/errors.js';
import { BitWriter } from '../../src/qr/bit-buffer.js';
import { decodeSegments } from '../../src/qr/decode/segments.js';

/**
 * Character set handling in the segment decoder.
 *
 * A Google Authenticator export never carries an ECI designator, so nothing on
 * the main path reaches this. It matters for the generic QR input the package
 * also accepts, where the failure mode is silent: the wrong character set does
 * not throw, it returns text that is the right length and the wrong letters.
 */

const MODE_ECI = 0b0111;
const MODE_BYTE = 0b0100;

/** A version 1 bitstream: an optional ECI designator, then one byte segment. */
function byteSegment(bytes: number[], eci?: number): Uint8Array {
	const writer = new BitWriter();
	if (eci !== undefined) {
		// One-byte designator form, which covers everything below 128.
		writer.put(MODE_ECI, 4).put(eci, 8);
	}
	writer.put(MODE_BYTE, 4).put(bytes.length, 8);
	for (const byte of bytes) {
		writer.put(byte, 8);
	}
	return writer.toBytes();
}

// 0xa1 is a different letter in latin6 than in latin1, so it tells the two
// apart. In latin1 it is an inverted exclamation mark.
const NORDIC = [0x48, 0xa1];

describe('decodeSegments character sets', () => {
	it('reads a latin6 byte segment when the symbol declares ECI 12', () => {
		// ISO/IEC 8859-10 is the Nordic set. Without the mapping the whole
		// symbol is refused as an unsupported character set, which is a worse
		// answer than the one the specification asks for.
		expect(decodeSegments(byteSegment(NORDIC, 12), 1)).toBe('HĄ');
	});

	it('falls back to latin1 for a byte segment that declares nothing', () => {
		// 0xa1 alone is not valid UTF-8, so the strict attempt fails and the
		// specification's default applies. Same bytes, different letter.
		expect(decodeSegments(byteSegment(NORDIC), 1)).toBe('H¡');
	});

	it('prefers UTF-8 over the specification default when the bytes are valid UTF-8', () => {
		// What encoders actually emit: UTF-8 with no ECI at all. Taking the
		// specification at its word here would render every non-ASCII export
		// name as mojibake.
		const utf8 = [...new TextEncoder().encode('Ä')];

		expect(decodeSegments(byteSegment(utf8), 1)).toBe('Ä');
	});

	it('refuses a character set it cannot decode rather than guessing one', () => {
		// ECI 2 is cp437, which no runtime implements. Guessing latin1 would
		// return text that reads as plausible and is wrong.
		expect(() => decodeSegments(byteSegment(NORDIC, 2), 1)).toThrow(QrUnsupportedFeatureError);
		expect(() => decodeSegments(byteSegment(NORDIC, 99), 1)).toThrow(/character set ECI 99/);
	});
});
