import { describe, expect, it } from 'vitest';
import { CryptoUnavailableError, UnsupportedAlgorithmError } from '../../src/errors.js';
import { generateHotp } from '../../src/otp/hotp.js';
import { RFC_TEST_SEED } from '../helpers/build-payload.js';

/**
 * RFC 4226 Appendix D. The seed is the ASCII string "12345678901234567890" and
 * these are the published 6-digit values for counters 0 through 9.
 *
 * This is an external anchor: it pins the implementation to the specification
 * rather than to itself, which a round-trip test cannot do.
 */
const RFC_4226_APPENDIX_D: readonly string[] = [
	'755224',
	'287082',
	'359152',
	'969429',
	'338314',
	'254676',
	'287922',
	'162583',
	'399871',
	'520489',
];

describe('generateHotp', () => {
	it.each(RFC_4226_APPENDIX_D.map((code, counter) => [counter, code] as const))(
		'matches RFC 4226 Appendix D at counter %i',
		async (counter, expected) => {
			await expect(generateHotp(RFC_TEST_SEED, BigInt(counter))).resolves.toBe(expected);
		},
	);

	it('pads a short code to the requested width', async () => {
		// Counter 42 with this seed produces a value under 100000 on SHA1,
		// which is the case a naive String(n) gets wrong.
		const codes = await Promise.all(
			Array.from({ length: 200 }, (_, i) => generateHotp(RFC_TEST_SEED, BigInt(i))),
		);

		for (const code of codes) {
			expect(code).toHaveLength(6);
			expect(code).toMatch(/^\d{6}$/);
		}
	});

	it('produces 8 digits when asked', async () => {
		const code = await generateHotp(RFC_TEST_SEED, 0n, { digits: 8 });

		expect(code).toHaveLength(8);
		// The 8-digit value shares its last 6 digits with the 6-digit one,
		// because both are the same truncated integer modulo a power of ten.
		expect(code.endsWith(RFC_4226_APPENDIX_D[0]!)).toBe(true);
	});

	it('handles a counter beyond 32 bits, which int64 allows', async () => {
		await expect(generateHotp(RFC_TEST_SEED, 0xffffffffffn)).resolves.toMatch(/^\d{6}$/);
	});

	it('supports the SHA256 and SHA512 variants', async () => {
		await expect(generateHotp(RFC_TEST_SEED, 0n, { algorithm: 'SHA256' })).resolves.toMatch(
			/^\d{6}$/,
		);
		await expect(generateHotp(RFC_TEST_SEED, 0n, { algorithm: 'SHA512' })).resolves.toMatch(
			/^\d{6}$/,
		);
	});

	it('gives different algorithms different answers, so the parameter is really used', async () => {
		const [sha1, sha256, sha512] = await Promise.all([
			generateHotp(RFC_TEST_SEED, 1n, { algorithm: 'SHA1' }),
			generateHotp(RFC_TEST_SEED, 1n, { algorithm: 'SHA256' }),
			generateHotp(RFC_TEST_SEED, 1n, { algorithm: 'SHA512' }),
		]);

		expect(new Set([sha1, sha256, sha512]).size).toBe(3);
	});

	it('refuses MD5 rather than shipping a hand-rolled one', async () => {
		// It is in Google's enum but browsers cannot compute it, and the secret
		// is still shown, which is what the user actually came for.
		await expect(generateHotp(RFC_TEST_SEED, 0n, { algorithm: 'MD5' })).rejects.toBeInstanceOf(
			UnsupportedAlgorithmError,
		);
	});

	it('says so plainly when WebCrypto is absent', async () => {
		// What a page served over plain http looks like.
		await expect(
			generateHotp(RFC_TEST_SEED, 0n, {
				crypto: undefined as unknown as SubtleCrypto,
				algorithm: 'SHA1',
			}),
		).resolves.toMatch(/^\d{6}$/);

		const noSubtle = { subtle: undefined };
		const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
		Object.defineProperty(globalThis, 'crypto', { value: noSubtle, configurable: true });
		try {
			await expect(generateHotp(RFC_TEST_SEED, 0n)).rejects.toBeInstanceOf(CryptoUnavailableError);
		} finally {
			if (original !== undefined) {
				Object.defineProperty(globalThis, 'crypto', original);
			}
		}
	});
});
