import { describe, expect, it } from 'vitest';
import { QrDecodeError, QrUnsupportedFeatureError } from '../../src/errors.js';
import { BitMatrix } from '../../src/qr/bit-matrix.js';
import { decodeMatrix } from '../../src/qr/decode/matrix-decoder.js';
import { decodeSegments } from '../../src/qr/decode/segments.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import { EC_LEVELS } from '../../src/qr/tables.js';
import type { EcLevel } from '../../src/types.js';

/**
 * Round trips through the encoder, which is itself pinned to the specification
 * and to an independent implementation. That ordering is what makes these
 * meaningful: on their own, an encoder and decoder written from one misreading
 * would agree perfectly and prove nothing.
 */

describe('decodeMatrix round trips', () => {
	it.each(EC_LEVELS)('reads back every mask at level %s', (level: EcLevel) => {
		const text = 'otpauth://totp/Hex:alice?secret=JBSWY3DPEHPK3PXP&issuer=Hex';

		for (let mask = 0; mask < 8; mask += 1) {
			const symbol = encodeQr(text, { ecLevel: level, mask });
			const decoded = decodeMatrix(symbol.matrix);

			expect(decoded.text, `level ${level} mask ${mask}`).toBe(text);
			expect(decoded.ecLevel).toBe(level);
			expect(decoded.mask).toBe(mask);
			expect(decoded.version).toBe(symbol.version);
			expect(decoded.errorsCorrected).toBe(0);
		}
	});

	it('reads back every version from 1 to 40', () => {
		for (let version = 1; version <= 40; version += 1) {
			// Sized so it lands in the intended version rather than a smaller one.
			const text = `v${version}-`.padEnd(Math.max(4, version * 2), 'x');
			const symbol = encodeQr(text, { ecLevel: 'L', minVersion: version, maxVersion: version });
			const decoded = decodeMatrix(symbol.matrix);

			expect(decoded.text, `version ${version}`).toBe(text);
			expect(decoded.version).toBe(version);
		}
	});

	it.each(['numeric', 'alphanumeric', 'byte'] as const)('reads back %s mode', (mode) => {
		const text =
			mode === 'numeric'
				? '0123456789012345678901234567890'
				: mode === 'alphanumeric'
					? 'HELLO WORLD 123 $%*+-./: TEST'
					: 'Mixed case, punctuation and ünïcøde ✓ 日本語';

		const symbol = encodeQr(text, { mode, ecLevel: 'M' });
		expect(decodeMatrix(symbol.matrix).text).toBe(text);
	});

	it('reads back a realistic migration payload', () => {
		const text =
			'otpauth-migration://offline?data=CksKCs%2FSZTJhqIO%2BKYASI2FsaWNlQGV4YW1wbGUuY29tGhJhdXRoLmV4YW1wbGUudGVzdCABKAEwAgojChTxZXW8hBpXh2dAiI4YopDgCtgLhRIFQTQwNDMgASgBMAIQAhgBIAA';
		const symbol = encodeQr(text, { ecLevel: 'M' });

		expect(decodeMatrix(symbol.matrix).text).toBe(text);
	});

	it('reads back an empty-ish payload and a very long one', () => {
		for (const text of ['a', 'x'.repeat(1000)]) {
			const symbol = encodeQr(text, { ecLevel: 'L' });
			expect(decodeMatrix(symbol.matrix).text, `length ${text.length}`).toBe(text);
		}
	});
});

describe('decodeMatrix error correction', () => {
	const text = 'otpauth://totp/Hex:alice?secret=JBSWY3DPEHPK3PXP';

	it('repairs damage and reports how much it repaired', () => {
		const symbol = encodeQr(text, { ecLevel: 'H' });
		const damaged = symbol.matrix.clone();

		// A patch of the data region, well away from the function patterns.
		const start = Math.floor(symbol.moduleCount / 2);
		for (let y = start; y < start + 3; y += 1) {
			for (let x = start; x < start + 3; x += 1) {
				damaged.set(x, y, !damaged.get(x, y));
			}
		}

		const decoded = decodeMatrix(damaged);
		expect(decoded.text).toBe(text);
		expect(decoded.errorsCorrected).toBeGreaterThan(0);
	});

	it('survives one format information copy being destroyed', () => {
		// The two copies exist precisely so losing a corner is recoverable.
		const symbol = encodeQr(text, { ecLevel: 'M' });
		const damaged = symbol.matrix.clone();

		for (let i = 0; i < 6; i += 1) {
			damaged.set(i, 8, !damaged.get(i, 8));
		}

		expect(decodeMatrix(damaged).text).toBe(text);
	});

	it('gives up rather than guessing when the damage is beyond repair', () => {
		const symbol = encodeQr(text, { ecLevel: 'L' });
		const damaged = symbol.matrix.clone();

		// Half the data region inverted is far outside any correcting radius.
		for (let y = 9; y < symbol.moduleCount - 9; y += 1) {
			for (let x = 9; x < symbol.moduleCount - 9; x += 1) {
				damaged.set(x, y, !damaged.get(x, y));
			}
		}

		expect(() => decodeMatrix(damaged)).toThrow();
	});
});

describe('decodeMatrix rejections', () => {
	it('rejects a matrix that is not a legal symbol size', () => {
		expect(() => decodeMatrix(new BitMatrix(20))).toThrow(QrDecodeError);
		expect(() => decodeMatrix(new BitMatrix(22))).toThrow(QrDecodeError);
	});

	it('rejects a blank matrix rather than returning empty text', () => {
		expect(() => decodeMatrix(new BitMatrix(21))).toThrow();
	});
});

describe('decodeSegments', () => {
	it('reads the ISO/IEC 18004 Annex I bitstream', () => {
		// The specification's worked example, byte-aligned:
		//   0001 0000001000 0000001100 0101011001 1000011 0000
		// which is mode 1 (numeric), count 8, then 012 345 67.
		const data = new Uint8Array([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80]);

		expect(decodeSegments(data, 1)).toBe('01234567');
	});

	it('rejects a structured-append symbol with a message that says why', () => {
		// Mode 0011 in the top nibble.
		const data = new Uint8Array([0x30, 0x00, 0x00, 0x00]);

		try {
			decodeSegments(data, 1);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(QrUnsupportedFeatureError);
			expect((error as QrUnsupportedFeatureError).feature).toBe('structured-append');
			// A user arriving with a multi-part Google export needs to be told
			// that this is not what that is.
			expect((error as QrUnsupportedFeatureError).message).toContain('Google Authenticator');
		}
	});

	it('rejects FNC1 symbols', () => {
		expect(() => decodeSegments(new Uint8Array([0x50, 0x00]), 1)).toThrow(
			QrUnsupportedFeatureError,
		);
		expect(() => decodeSegments(new Uint8Array([0x90, 0x00]), 1)).toThrow(
			QrUnsupportedFeatureError,
		);
	});

	it('rejects a segment claiming more data than the symbol holds', () => {
		// Byte mode, count 255, followed by nothing.
		const data = new Uint8Array([0x4f, 0xf0]);
		expect(() => decodeSegments(data, 1)).toThrow(QrDecodeError);
	});

	it('stops cleanly at the terminator', () => {
		const data = new Uint8Array([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0x00, 0x00]);
		expect(decodeSegments(data, 1)).toBe('01234567');
	});
});
