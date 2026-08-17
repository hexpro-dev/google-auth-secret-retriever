import type { OtpAlgorithm, OtpDigits, TotpCode } from '../types.js';
import { generateHotp } from './hotp.js';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * TOTP is HOTP with the counter derived from the clock, so this is thin. The
 * only real decisions are that `timestampMs` is injectable (which is what makes
 * the RFC's test vectors testable) and that the returned object carries the
 * validity window, so a countdown can be driven from it without the caller
 * repeating the arithmetic and drifting.
 */

export interface TotpOptions {
	readonly algorithm?: OtpAlgorithm;
	readonly digits?: OtpDigits;
	readonly period?: number;
	/** Defaults to now. Set it to reproduce a code at a given instant. */
	readonly timestampMs?: number;
	/** The epoch offset, T0 in the RFC. Zero everywhere in practice. */
	readonly t0?: number;
	readonly crypto?: SubtleCrypto;
}

export async function generateTotp(
	secret: Uint8Array,
	options: TotpOptions = {},
): Promise<TotpCode> {
	const period = options.period ?? 30;
	const t0 = options.t0 ?? 0;
	const timestampMs = options.timestampMs ?? Date.now();

	const seconds = Math.floor(timestampMs / 1000) - t0;
	const counter = BigInt(Math.floor(seconds / period));

	const code = await generateHotp(secret, counter, {
		algorithm: options.algorithm,
		digits: options.digits,
		crypto: options.crypto,
	});

	const validFromMs = (Number(counter) * period + t0) * 1000;
	const validUntilMs = validFromMs + period * 1000;

	return {
		code,
		counter,
		validFromMs,
		validUntilMs,
		// Rounded up, so a display never shows 0 while the code is still valid.
		secondsRemaining: Math.max(0, Math.ceil((validUntilMs - timestampMs) / 1000)),
	};
}
