import { Base64DecodeError } from '../errors.js';

/**
 * Base64, hand-rolled rather than delegated to `atob`.
 *
 * Three reasons. `atob` does not exist in Node, so the same code could not be
 * tested outside a browser. It rejects unpadded input, and Google's export
 * strings are frequently unpadded. And it has no url-safe mode, while the wild
 * contains both alphabets.
 *
 * Google Authenticator emits the standard alphabet (`+` and `/`), which is the
 * fact that matters most here. See `migration/parse-uri.ts` for why that rules
 * out `URLSearchParams` when pulling the payload out of the URI.
 */

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Accepts both alphabets at once: `-` and `_` decode as `+` and `/`. */
const DECODE_TABLE: Int8Array = (() => {
	const table = new Int8Array(128).fill(-1);
	for (let i = 0; i < STANDARD.length; i += 1) {
		table[STANDARD.charCodeAt(i)] = i;
	}
	table['-'.charCodeAt(0)] = 62;
	table['_'.charCodeAt(0)] = 63;
	return table;
})();

export interface Base64EncodeOptions {
	readonly urlSafe?: boolean;
	readonly pad?: boolean;
}

export function encodeBase64(bytes: Uint8Array, options: Base64EncodeOptions = {}): string {
	const alphabet = options.urlSafe === true ? URL_SAFE : STANDARD;
	const pad = options.pad ?? !(options.urlSafe === true);
	let out = '';

	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] as number;
		const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
		const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
		const triple = (b0 << 16) | (b1 << 8) | b2;
		const remaining = bytes.length - i;

		out += alphabet[(triple >>> 18) & 63];
		out += alphabet[(triple >>> 12) & 63];
		out += remaining > 1 ? alphabet[(triple >>> 6) & 63] : pad ? '=' : '';
		out += remaining > 2 ? alphabet[triple & 63] : pad ? '=' : '';
	}

	return out;
}

/**
 * Decode base64 in whichever form it arrives.
 *
 * Tolerates: either alphabet, mixed alphabets, absent padding, excess padding,
 * and embedded whitespace or newlines. Rejects: characters outside both
 * alphabets, a length that cannot be a base64 quantum, and a final group whose
 * unused low bits are non-zero, which means a character was dropped.
 */
export function decodeBase64Loose(text: string): Uint8Array {
	const clean = text.replace(/[\s\r\n]/g, '').replace(/=+$/, '');

	if (clean.length === 0) {
		return new Uint8Array(0);
	}

	// A base64 quantum is 4 characters encoding 3 bytes. A remainder of 1 is
	// impossible: no number of bytes produces a single trailing character.
	if (clean.length % 4 === 1) {
		throw new Base64DecodeError(clean.length - 1, 'the data ends mid-character');
	}

	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let outIndex = 0;
	let buffer = 0;
	let bits = 0;

	for (let i = 0; i < clean.length; i += 1) {
		const code = clean.charCodeAt(i);
		const value = code < 128 ? (DECODE_TABLE[code] as number) : -1;
		if (value < 0) {
			throw new Base64DecodeError(
				i,
				`'${clean[i]}' at position ${i + 1} is not a base64 character`,
			);
		}
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			out[outIndex] = (buffer >>> (bits - 8)) & 0xff;
			outIndex += 1;
			bits -= 8;
		}
	}

	if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
		throw new Base64DecodeError(
			clean.length - 1,
			'the final character carries bits that should be zero',
		);
	}

	return out.subarray(0, outIndex);
}
