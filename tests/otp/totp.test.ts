import { describe, expect, it } from 'vitest';
import { generateTotp } from '../../src/otp/totp.js';
import type { OtpAlgorithm } from '../../src/types.js';

/**
 * RFC 6238 Appendix B.
 *
 * The three algorithms use three different seeds, which is the detail most
 * implementations get wrong when adding these vectors: the RFC repeats the
 * ASCII digit run to fill the key length for each hash.
 */
const SEEDS: Readonly<Record<'SHA1' | 'SHA256' | 'SHA512', Uint8Array>> = {
	SHA1: new TextEncoder().encode('12345678901234567890'),
	SHA256: new TextEncoder().encode('12345678901234567890123456789012'),
	SHA512: new TextEncoder().encode(
		'1234567890123456789012345678901234567890123456789012345678901234',
	),
};

const RFC_6238_APPENDIX_B: ReadonlyArray<
	readonly [seconds: number, sha1: string, sha256: string, sha512: string]
> = [
	[59, '94287082', '46119246', '90693936'],
	[1111111109, '07081804', '68084774', '25091201'],
	[1111111111, '14050471', '67062674', '99943326'],
	[1234567890, '89005924', '91819424', '93441116'],
	[2000000000, '69279037', '90698825', '38618901'],
	[20000000000, '65353130', '77737706', '47863826'],
];

describe('generateTotp against RFC 6238 Appendix B', () => {
	const cases = RFC_6238_APPENDIX_B.flatMap(([seconds, sha1, sha256, sha512]) =>
		(
			[
				['SHA1', sha1],
				['SHA256', sha256],
				['SHA512', sha512],
			] as ReadonlyArray<readonly [OtpAlgorithm & keyof typeof SEEDS, string]>
		).map(([algorithm, expected]) => [seconds, algorithm, expected] as const),
	);

	it.each(cases)('T=%i with %s gives %s', async (seconds, algorithm, expected) => {
		const result = await generateTotp(SEEDS[algorithm], {
			algorithm,
			digits: 8,
			period: 30,
			timestampMs: seconds * 1000,
		});

		expect(result.code).toBe(expected);
	});
});

describe('generateTotp mechanics', () => {
	it('defaults to 6 digits and a 30 second period, which is what Google exports', async () => {
		const result = await generateTotp(SEEDS.SHA1, { timestampMs: 59_000 });

		expect(result.code).toHaveLength(6);
		// The 6-digit code is the 8-digit one modulo a million.
		expect(result.code).toBe('287082');
	});

	it('derives the counter from the clock', async () => {
		const at59 = await generateTotp(SEEDS.SHA1, { timestampMs: 59_000 });
		const at1111111109 = await generateTotp(SEEDS.SHA1, { timestampMs: 1111111109_000 });

		expect(at59.counter).toBe(1n);
		expect(at1111111109.counter).toBe(37037036n);
	});

	it('reports a validity window that brackets the timestamp', async () => {
		const timestampMs = 1234567890_000;
		const result = await generateTotp(SEEDS.SHA1, { timestampMs });

		expect(result.validFromMs).toBeLessThanOrEqual(timestampMs);
		expect(result.validUntilMs).toBeGreaterThan(timestampMs);
		expect(result.validUntilMs - result.validFromMs).toBe(30_000);
	});

	it('holds the same code across a whole period and changes at the boundary', async () => {
		const start = 1234567890_000 - (1234567890_000 % 30_000);

		const atStart = await generateTotp(SEEDS.SHA1, { timestampMs: start });
		const nearEnd = await generateTotp(SEEDS.SHA1, { timestampMs: start + 29_999 });
		const atNext = await generateTotp(SEEDS.SHA1, { timestampMs: start + 30_000 });

		expect(nearEnd.code).toBe(atStart.code);
		expect(atNext.code).not.toBe(atStart.code);
		expect(atNext.counter).toBe(atStart.counter + 1n);
	});

	it('never reports zero seconds remaining while the code is still valid', async () => {
		const start = 1234567890_000 - (1234567890_000 % 30_000);

		for (const offset of [0, 1, 15_000, 29_000, 29_999]) {
			const result = await generateTotp(SEEDS.SHA1, { timestampMs: start + offset });
			expect(result.secondsRemaining).toBeGreaterThan(0);
			expect(result.secondsRemaining).toBeLessThanOrEqual(30);
		}
	});

	it('honours a non-default period', async () => {
		const result = await generateTotp(SEEDS.SHA1, { period: 60, timestampMs: 120_000 });

		expect(result.counter).toBe(2n);
		expect(result.validUntilMs - result.validFromMs).toBe(60_000);
	});

	it('honours a T0 epoch offset', async () => {
		const withoutOffset = await generateTotp(SEEDS.SHA1, { timestampMs: 60_000 });
		const withOffset = await generateTotp(SEEDS.SHA1, { timestampMs: 90_000, t0: 30 });

		expect(withOffset.code).toBe(withoutOffset.code);
	});

	it('uses the current clock when no timestamp is given', async () => {
		const before = Date.now();
		const result = await generateTotp(SEEDS.SHA1);
		const after = Date.now();

		expect(result.validFromMs).toBeLessThanOrEqual(after);
		expect(result.validUntilMs).toBeGreaterThanOrEqual(before);
	});
});
