import { CryptoUnavailableError, UnsupportedAlgorithmError } from '../errors.js';
import type { OtpAlgorithm, OtpDigits } from '../types.js';

/**
 * HMAC-based one-time passwords, RFC 4226.
 *
 * WebCrypto does the HMAC, so there is no hand-rolled crypto here and nothing
 * to get subtly wrong. HMAC-SHA1 is still available in `crypto.subtle` even
 * though bare SHA-1 signatures are deprecated elsewhere, which matters because
 * SHA1 is what essentially every TOTP account uses.
 */

const WEBCRYPTO_HASH: Readonly<Record<string, string>> = {
	SHA1: 'SHA-1',
	SHA256: 'SHA-256',
	SHA512: 'SHA-512',
};

export interface HotpOptions {
	readonly algorithm?: OtpAlgorithm;
	readonly digits?: OtpDigits;
	/** Injectable for tests and for runtimes that expose it somewhere else. */
	readonly crypto?: SubtleCrypto;
}

function resolveSubtle(provided?: SubtleCrypto): SubtleCrypto {
	const subtle = provided ?? globalThis.crypto?.subtle;
	if (subtle === undefined) {
		// Not an error we can work around: `crypto.subtle` is absent on plain
		// http, and no amount of retrying will conjure it.
		throw new CryptoUnavailableError();
	}
	return subtle;
}

/** The 8-byte big-endian counter block RFC 4226 specifies. */
function counterBlock(counter: bigint): Uint8Array {
	const block = new Uint8Array(8);
	let remaining = counter;
	for (let i = 7; i >= 0; i -= 1) {
		block[i] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return block;
}

export async function generateHotp(
	secret: Uint8Array,
	counter: bigint,
	options: HotpOptions = {},
): Promise<string> {
	const algorithm = options.algorithm ?? 'SHA1';
	const hash = WEBCRYPTO_HASH[algorithm];
	if (hash === undefined) {
		// MD5 is in Google's enum and browsers cannot compute it. Shipping a
		// hand-rolled MD5 for an algorithm Google has never actually emitted
		// would be attack surface bought for nothing; the secret and its
		// parameters are still shown, which is what the user came for.
		throw new UnsupportedAlgorithmError(algorithm);
	}

	const digits = options.digits ?? 6;
	const subtle = resolveSubtle(options.crypto);

	const key = await subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash }, false, [
		'sign',
	]);
	const mac = new Uint8Array(await subtle.sign('HMAC', key, counterBlock(counter) as BufferSource));

	// Dynamic truncation: the low nibble of the last byte picks the offset, and
	// the high bit of the selected word is masked so the result is positive.
	const offset = (mac[mac.length - 1] as number) & 0x0f;
	const binary =
		(((mac[offset] as number) & 0x7f) << 24) |
		((mac[offset + 1] as number) << 16) |
		((mac[offset + 2] as number) << 8) |
		(mac[offset + 3] as number);

	return String(binary % 10 ** digits).padStart(digits, '0');
}
