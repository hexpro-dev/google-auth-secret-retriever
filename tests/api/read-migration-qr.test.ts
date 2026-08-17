import { describe, expect, it } from 'vitest';
import {
	BatchCollector,
	encodeQr,
	generateTotp,
	readMigrationQr,
	renderQrImageData,
} from '../../src/index.js';
import { decodeMatrix } from '../../src/qr/decode/matrix-decoder.js';
import {
	ALICE,
	BOB,
	CAROL,
	DAVE,
	RFC_TEST_SEED,
	SILENT,
	type PayloadSpec,
	toMigrationUri,
} from '../helpers/build-payload.js';
import { expectErr, expectOk } from '../helpers/expect-result.js';
import { blur, noise, pad, perspective, rotate } from '../helpers/image.js';

/**
 * The whole job, end to end: a picture of a QR code in, accounts out.
 *
 * Everything below is built from synthetic payloads. No real Google
 * Authenticator export is in this repository and none may be added.
 */

function qrImage(spec: PayloadSpec, scale = 6) {
	return renderQrImageData(encodeQr(toMigrationUri(spec), { ecLevel: 'M' }), { scale });
}

describe('readMigrationQr', () => {
	it('reads a single-account export', () => {
		const scan = expectOk(readMigrationQr(qrImage({ accounts: [ALICE] })));

		expect(scan.accounts).toHaveLength(1);
		const account = scan.accounts[0]!;
		expect(account.displayIssuer).toBe('Example Corp');
		expect(account.accountName).toBe('alice@example.com');
		expect(account.algorithm).toBe('SHA1');
		expect(account.digits).toBe(6);
		expect(account.type).toBe('totp');
		expect(account.secret).toMatch(/^[A-Z2-7]+$/);
	});

	it('surfaces every field the export carries, not just a URI', () => {
		// The point of the result type: someone integrating this needs the
		// pieces, not a string they have to re-parse.
		const scan = expectOk(readMigrationQr(qrImage({ accounts: [BOB] })));
		const account = scan.accounts[0]!;

		expect(account).toMatchObject({
			issuer: 'Test Service',
			name: 'bob@example.org',
			accountName: 'bob@example.org',
			algorithm: 'SHA256',
			digits: 8,
			type: 'totp',
			period: 30,
			periodSource: 'google-default',
			counter: 0,
		});
		expect(account.secretBytes).toBeInstanceOf(Uint8Array);
		expect(account.uri.startsWith('otpauth://totp/')).toBe(true);
		expect(account.raw.secret).toEqual(BOB.secret);
	});

	it('reads several accounts in export order', () => {
		const scan = expectOk(
			readMigrationQr(qrImage({ accounts: [ALICE, BOB, CAROL, DAVE, SILENT] })),
		);

		expect(scan.accounts.map((a) => a.accountName)).toEqual([
			'alice@example.com',
			'bob@example.org',
			'A4043',
			'dave@test.invalid',
			'quiet@example.com',
		]);
	});

	it('marks values that were assumed rather than decoded', () => {
		const scan = expectOk(readMigrationQr(qrImage({ accounts: [SILENT] })));

		expect(scan.accounts[0]!.defaultsApplied).toEqual(['algorithm', 'digits', 'type']);
	});

	it('reads an account with no issuer', () => {
		const scan = expectOk(readMigrationQr(qrImage({ accounts: [CAROL] })));

		expect(scan.accounts[0]!.issuer).toBe('');
		expect(scan.accounts[0]!.displayIssuer).toBe('');
		expect(scan.accounts[0]!.accountName).toBe('A4043');
	});

	it('reads a counter-based account', () => {
		const scan = expectOk(readMigrationQr(qrImage({ accounts: [DAVE] })));

		expect(scan.accounts[0]!.type).toBe('hotp');
		expect(scan.accounts[0]!.counter).toBe(42);
		expect(scan.accounts[0]!.uri).toContain('counter=42');
	});

	it('reads a photograph rather than only a clean render', () => {
		const image = noise(
			blur(perspective(pad(qrImage({ accounts: [ALICE, BOB] }, 9), 40), 0.15), 1),
			20,
			3,
		);

		expect(expectOk(readMigrationQr(image)).accounts).toHaveLength(2);
	});

	it('reads a rotated screenshot', () => {
		const image = rotate(pad(qrImage({ accounts: [ALICE] }, 8), 40), 27);

		expect(expectOk(readMigrationQr(image)).accounts).toHaveLength(1);
	});
});

describe('readMigrationQr failures', () => {
	it('reports no QR code when there is none', () => {
		const data = new Uint8ClampedArray(200 * 200 * 4);
		data.fill(255);

		expect(expectErr(readMigrationQr({ data, width: 200, height: 200 })).code).toBe('qr/not-found');
	});

	it('reports a QR code that is not an export', () => {
		const image = renderQrImageData(encodeQr('https://example.com', { ecLevel: 'M' }), {
			scale: 6,
		});

		expect(expectErr(readMigrationQr(image)).code).toBe('migration/not-migration-uri');
	});

	it('flags a single-account QR as its own case, so it can still be handled', () => {
		const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example';
		const image = renderQrImageData(encodeQr(uri, { ecLevel: 'M' }), { scale: 6 });
		const error = expectErr(readMigrationQr(image));

		expect(error.code).toBe('migration/not-migration-uri');
		expect(error).toMatchObject({ kind: 'single-account-uri' });
	});
});

describe('a complete multi-part export', () => {
	it('merges three QR codes into one account list', () => {
		// What Google produces for a large account list, and the part the
		// command line route handles worst.
		const collector = new BatchCollector();
		const parts: PayloadSpec[] = [
			{ accounts: [ALICE], batchSize: 3, batchIndex: 0, batchId: 4242 },
			{ accounts: [BOB, CAROL], batchSize: 3, batchIndex: 1, batchId: 4242 },
			{ accounts: [DAVE], batchSize: 3, batchIndex: 2, batchId: 4242 },
		];

		for (const part of parts) {
			const scan = expectOk(readMigrationQr(qrImage(part)));
			collector.add(scan);
		}

		expect(collector.progress?.complete).toBe(true);
		expect(collector.accounts.map((a) => a.accountName)).toEqual([
			'alice@example.com',
			'bob@example.org',
			'A4043',
			'dave@test.invalid',
		]);
	});

	it('says which parts are still missing', () => {
		const collector = new BatchCollector();
		collector.add(
			expectOk(
				readMigrationQr(qrImage({ accounts: [ALICE], batchSize: 3, batchIndex: 1, batchId: 7 })),
			),
		);

		expect(collector.progress).toMatchObject({ captured: [1], missing: [0, 2], complete: false });
	});
});

describe('the round trip a user actually performs', () => {
	it('extracts a secret, rebuilds a QR from it, and reads that back', () => {
		// This is the whole point of the re-import feature: the code shown on
		// screen has to carry the same account into another authenticator.
		const scan = expectOk(readMigrationQr(qrImage({ accounts: [ALICE] })));
		const account = scan.accounts[0]!;

		const reimport = encodeQr(account.uri, { ecLevel: 'M' });
		expect(decodeMatrix(reimport.matrix).text).toBe(account.uri);
	});

	it('generates a code from an extracted secret', async () => {
		// Verified against the RFC seed, so the number is checkable rather than
		// merely self-consistent: this is the same value hotp.test.ts pins.
		const spec: PayloadSpec = { accounts: [{ ...ALICE, secret: RFC_TEST_SEED }] };
		const scan = expectOk(readMigrationQr(qrImage(spec)));
		const account = scan.accounts[0]!;

		const code = await generateTotp(account.secretBytes, {
			algorithm: account.algorithm,
			digits: account.digits,
			period: account.period,
			timestampMs: 59_000,
		});

		expect(code.code).toBe('287082');
	});
});
