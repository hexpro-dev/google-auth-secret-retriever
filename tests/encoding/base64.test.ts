import { describe, expect, it } from 'vitest';
import { Base64DecodeError } from '../../src/errors.js';
import { decodeBase64Loose, encodeBase64 } from '../../src/encoding/base64.js';

const ascii = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** RFC 4648 section 10. */
const RFC_4648_VECTORS: ReadonlyArray<readonly [input: string, padded: string]> = [
	['', ''],
	['f', 'Zg=='],
	['fo', 'Zm8='],
	['foo', 'Zm9v'],
	['foob', 'Zm9vYg=='],
	['fooba', 'Zm9vYmE='],
	['foobar', 'Zm9vYmFy'],
];

describe('encodeBase64', () => {
	it.each(RFC_4648_VECTORS)('encodes %j as %j (RFC 4648)', (input, padded) => {
		expect(encodeBase64(ascii(input))).toBe(padded);
	});

	it('omits padding when asked', () => {
		expect(encodeBase64(ascii('f'), { pad: false })).toBe('Zg');
		expect(encodeBase64(ascii('fo'), { pad: false })).toBe('Zm8');
	});

	it('uses the url-safe alphabet when asked, unpadded by default', () => {
		// 0xfb 0xff exercises both of the two characters the alphabets differ on.
		const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
		expect(encodeBase64(bytes)).toBe('+/+/');
		expect(encodeBase64(bytes, { urlSafe: true })).toBe('-_-_');
	});
});

describe('decodeBase64Loose', () => {
	it.each(RFC_4648_VECTORS)('decodes the padded form of %j', (input, padded) => {
		expect(text(decodeBase64Loose(padded))).toBe(input);
	});

	it.each(RFC_4648_VECTORS)('decodes the unpadded form of %j', (input, padded) => {
		expect(text(decodeBase64Loose(padded.replace(/=+$/, '')))).toBe(input);
	});

	it('decodes the url-safe alphabet', () => {
		expect(decodeBase64Loose('-_-_')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
	});

	it('decodes a mixture of both alphabets, which no encoder should emit but some do', () => {
		// '+' and '-' are both 62, '_' and '/' are both 63.
		expect(decodeBase64Loose('+_-/')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
	});

	it('ignores embedded whitespace and newlines', () => {
		expect(text(decodeBase64Loose('Zm9v\nYmFy'))).toBe('foobar');
		expect(text(decodeBase64Loose('Zm9v YmFy'))).toBe('foobar');
	});

	it('rejects a length that cannot be a base64 quantum', () => {
		// No number of bytes produces a single trailing character.
		expect(() => decodeBase64Loose('Zm9vY')).toThrow(Base64DecodeError);
	});

	it('rejects characters outside both alphabets', () => {
		try {
			decodeBase64Loose('Zm9v*mFy');
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(Base64DecodeError);
			expect((error as Base64DecodeError).index).toBe(4);
			expect((error as Base64DecodeError).code).toBe('migration/bad-base64');
		}
	});

	it('rejects a final group carrying bits that should be zero', () => {
		expect(() => decodeBase64Loose('Zg==')).not.toThrow();
		expect(() => decodeBase64Loose('Zh==')).toThrow(Base64DecodeError);
	});

	it('round trips every length from 0 to 64 bytes', () => {
		for (let length = 0; length <= 64; length += 1) {
			const bytes = new Uint8Array(length);
			for (let i = 0; i < length; i += 1) {
				bytes[i] = (i * 53 + length * 7) & 0xff;
			}
			expect(decodeBase64Loose(encodeBase64(bytes))).toEqual(bytes);
			expect(decodeBase64Loose(encodeBase64(bytes, { urlSafe: true }))).toEqual(bytes);
		}
	});
});

describe('the plus-sign hazard', () => {
	/**
	 * Why the URI parser extracts `data` with a regex rather than with
	 * URLSearchParams.
	 *
	 * The payload is *standard* base64, so it contains '+' and '/'. It arrives
	 * inside a query string, where '+' has a second meaning: URLSearchParams
	 * applies application/x-www-form-urlencoded decoding and turns a literal
	 * '+' into a space.
	 *
	 * Both forms occur in practice. Google Authenticator's own QR codes
	 * percent-encode the '+' as %2B, and those survive URLSearchParams intact.
	 * But a literal '+' is perfectly legal in a query string, and turns up
	 * whenever the URI has been relayed by another tool, pasted by hand, or
	 * produced by something that did not encode it. Those are destroyed, and
	 * depending on where the '+' lands the result is either a base64 error or a
	 * silently wrong secret that generates codes which never work.
	 *
	 * Regex extraction plus decodeURIComponent is correct for both, because
	 * decodeURIComponent leaves a literal '+' alone and still resolves %2B.
	 */
	// Chosen so the encoding contains both '+' and '/': 0xfb 0xff 0xbf maps to
	// the 6-bit groups 62, 63, 62, 63.
	const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf]);
	const payload = encodeBase64(bytes);
	const extract = (uri: string) => decodeURIComponent(/[?&]data=([^&#]*)/.exec(uri)?.[1] ?? '');

	it('produces a payload containing the characters at issue', () => {
		expect(payload).toContain('+');
		expect(payload).toContain('/');
	});

	it('is destroyed by URLSearchParams when the plus is literal', () => {
		const uri = `otpauth-migration://offline?data=${payload}`;
		const viaSearchParams = new URL(uri).searchParams.get('data');

		expect(viaSearchParams).not.toBe(payload);
		expect(viaSearchParams).toContain(' ');
	});

	it('survives our extraction when the plus is literal', () => {
		const uri = `otpauth-migration://offline?data=${payload}`;

		expect(extract(uri)).toBe(payload);
		expect(decodeBase64Loose(extract(uri))).toEqual(bytes);
	});

	it('survives our extraction when the plus is percent-encoded, as Google emits it', () => {
		const uri = `otpauth-migration://offline?data=${encodeURIComponent(payload)}`;

		expect(extract(uri)).toBe(payload);
		expect(decodeBase64Loose(extract(uri))).toEqual(bytes);
	});
});
