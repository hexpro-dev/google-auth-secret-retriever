import { Base32DecodeError } from '../errors.js';

/**
 * Base32 as RFC 4648 section 6, which is what every authenticator means by
 * "secret key".
 *
 * Encoding is uppercase and unpadded, because that is the form authenticators
 * show and accept. Decoding is forgiving about case, whitespace and padding,
 * because people retype these from screens and paste them out of documents.
 *
 * It is not forgiving about the alphabet. Crockford base32 maps `0` to `O` and
 * `1` to `I` to help humans; doing that here would silently accept a mistyped
 * secret and hand back working-looking key material that generates wrong codes.
 * A rejection the user can see beats a secret that is quietly wrong.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Reverse lookup, -1 for anything not in the alphabet. Built once. */
const DECODE_TABLE: Int8Array = (() => {
	const table = new Int8Array(128).fill(-1);
	for (let i = 0; i < ALPHABET.length; i += 1) {
		const code = ALPHABET.charCodeAt(i);
		table[code] = i;
		// Lowercase is accepted on input; `encodeBase32` never produces it.
		// Guarded to the letters on purpose: '2' to '7' are codes 50 to 55, so
		// a blanket `code + 32` writes over 82 to 87, which is 'R' to 'W'.
		if (code >= 0x41 && code <= 0x5a) {
			table[code + 32] = i;
		}
	}
	return table;
})();

export function encodeBase32(bytes: Uint8Array): string {
	let out = '';
	let buffer = 0;
	let bits = 0;

	for (let i = 0; i < bytes.length; i += 1) {
		buffer = (buffer << 8) | (bytes[i] as number);
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}

	if (bits > 0) {
		// Left-align the remaining bits and pad the low end with zeroes, which
		// is what the RFC specifies for a partial final group.
		out += ALPHABET[(buffer << (5 - bits)) & 31];
	}

	return out;
}

export function decodeBase32(text: string): Uint8Array {
	// Strip whitespace and trailing padding before validating, so "JBSW Y3DP"
	// and "JBSWY3DP====" both work.
	const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '');

	if (clean.length === 0) {
		return new Uint8Array(0);
	}

	const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
	let outIndex = 0;
	let buffer = 0;
	let bits = 0;

	for (let i = 0; i < clean.length; i += 1) {
		const code = clean.charCodeAt(i);
		const value = code < 128 ? (DECODE_TABLE[code] as number) : -1;
		if (value < 0) {
			throw new Base32DecodeError(
				i,
				`'${clean[i]}' at position ${i + 1} is not a base32 character (A to Z and 2 to 7)`,
			);
		}
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			out[outIndex] = (buffer >>> (bits - 8)) & 0xff;
			outIndex += 1;
			bits -= 8;
		}
	}

	// Whatever is left is the zero padding of a partial group. If it is not
	// zero the input was not produced by a conforming encoder, which usually
	// means a character was dropped or transposed.
	if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
		throw new Base32DecodeError(
			clean.length - 1,
			'the final character carries bits that should be zero',
		);
	}

	return out.subarray(0, outIndex);
}

export function isValidBase32(text: string): boolean {
	try {
		decodeBase32(text);
		return true;
	} catch {
		return false;
	}
}
