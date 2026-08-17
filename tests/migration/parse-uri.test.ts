import { describe, expect, it } from 'vitest';
import { Base64DecodeError, NotMigrationUriError } from '../../src/errors.js';
import { extractMigrationData, parseMigrationUri } from '../../src/migration/parse-uri.js';
import { unwrap } from '../../src/result.js';
import { ALICE, BOB, encodePayload, toBase64, toMigrationUri } from '../helpers/build-payload.js';
import { expectErr } from '../helpers/expect-result.js';

describe('extractMigrationData', () => {
	it('reads the data parameter', () => {
		expect(extractMigrationData('otpauth-migration://offline?data=AAEC')).toBe('AAEC');
	});

	it('reads it from among other parameters, in any position', () => {
		expect(extractMigrationData('otpauth-migration://offline?v=1&data=AAEC&x=2')).toBe('AAEC');
		expect(extractMigrationData('otpauth-migration://offline?data=AAEC&x=2')).toBe('AAEC');
	});

	it('stops at a fragment', () => {
		expect(extractMigrationData('otpauth-migration://offline?data=AAEC#frag')).toBe('AAEC');
	});

	it('resolves percent escapes', () => {
		expect(extractMigrationData('otpauth-migration://offline?data=a%2Bb%2Fc')).toBe('a+b/c');
	});

	it('leaves a literal plus alone, which is the whole point of not using URLSearchParams', () => {
		expect(extractMigrationData('otpauth-migration://offline?data=a+b/c')).toBe('a+b/c');
	});

	it('rejects a link with no data parameter', () => {
		expect(() => extractMigrationData('otpauth-migration://offline')).toThrow(Base64DecodeError);
		expect(() => extractMigrationData('otpauth-migration://offline?data=')).toThrow(
			Base64DecodeError,
		);
	});

	it('rejects a broken escape sequence rather than throwing a raw URIError', () => {
		expect(() => extractMigrationData('otpauth-migration://offline?data=a%2')).toThrow(
			Base64DecodeError,
		);
	});
});

describe('parseMigrationUri', () => {
	it('parses the shape Google actually emits', () => {
		const scan = unwrap(parseMigrationUri(toMigrationUri({ accounts: [ALICE, BOB] })));

		expect(scan.accounts).toHaveLength(2);
		expect(scan.accounts[0]!.accountName).toBe('alice@example.com');
		expect(scan.batch).toEqual({ id: 0, size: 1, index: 0 });
	});

	it('parses an unpadded payload', () => {
		const scan = unwrap(parseMigrationUri(toMigrationUri({ accounts: [ALICE] }, { pad: false })));
		expect(scan.accounts).toHaveLength(1);
	});

	it('parses an unencoded payload, where a literal plus would otherwise be destroyed', () => {
		const scan = unwrap(
			parseMigrationUri(toMigrationUri({ accounts: [ALICE] }, { encode: false })),
		);
		expect(scan.accounts).toHaveLength(1);
	});

	it('agrees with itself across all four encoding and padding combinations', () => {
		const spec = { accounts: [ALICE, BOB] };
		const variants = [
			toMigrationUri(spec, { encode: true, pad: true }),
			toMigrationUri(spec, { encode: true, pad: false }),
			toMigrationUri(spec, { encode: false, pad: true }),
			toMigrationUri(spec, { encode: false, pad: false }),
		];

		const secrets = variants.map((uri) =>
			unwrap(parseMigrationUri(uri)).accounts.map((a) => a.secret),
		);
		for (const set of secrets) {
			expect(set).toEqual(secrets[0]);
		}
	});

	it('accepts a trailing slash on the authority', () => {
		const uri = toMigrationUri({ accounts: [ALICE] }).replace('offline?', 'offline/?');
		expect(unwrap(parseMigrationUri(uri)).accounts).toHaveLength(1);
	});

	it('accepts extra query parameters', () => {
		const uri = toMigrationUri({ accounts: [ALICE] }).replace('?data=', '?v=1&data=');
		expect(unwrap(parseMigrationUri(uri)).accounts).toHaveLength(1);
	});

	it('is not case sensitive about the scheme', () => {
		const uri = toMigrationUri({ accounts: [ALICE] }).replace(
			'otpauth-migration',
			'OTPAUTH-MIGRATION',
		);
		expect(unwrap(parseMigrationUri(uri)).accounts).toHaveLength(1);
	});

	it('ignores surrounding whitespace, because pasted text has it', () => {
		const uri = `\n  ${toMigrationUri({ accounts: [ALICE] })}  \n`;
		expect(unwrap(parseMigrationUri(uri)).accounts).toHaveLength(1);
	});

	it('accepts a bare base64 payload, for people who already have one', () => {
		const scan = unwrap(parseMigrationUri(toBase64(encodePayload({ accounts: [ALICE] }))));
		expect(scan.accounts).toHaveLength(1);
	});

	it('carries the batch envelope through', () => {
		const scan = unwrap(
			parseMigrationUri(
				toMigrationUri({ accounts: [ALICE], batchSize: 3, batchIndex: 2, batchId: 777 }),
			),
		);

		expect(scan.batch).toEqual({ id: 777, size: 3, index: 2 });
	});

	it('keeps the decoded bytes, so a re-scan can be told from a conflict', () => {
		const scan = unwrap(parseMigrationUri(toMigrationUri({ accounts: [ALICE] })));
		expect(scan.payloadBytes).toEqual(encodePayload({ accounts: [ALICE] }));
	});
});

describe('parseMigrationUri failures', () => {
	it('flags a single-account URI as its own case rather than a flat rejection', () => {
		// This is a QR code the user can still be helped with, so the caller
		// needs to be able to tell it apart from genuine rubbish.
		const result = parseMigrationUri('otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP');

		const error = expectErr(result);
		expect(error).toBeInstanceOf(NotMigrationUriError);
		expect((error as NotMigrationUriError).kind).toBe('single-account-uri');
		expect((error as NotMigrationUriError).text).toContain('otpauth://totp/');
	});

	it('rejects an unrelated URI', () => {
		const result = parseMigrationUri('https://example.com/hello');

		expect((expectErr(result) as NotMigrationUriError).kind).toBe('other-uri');
	});

	it('rejects plain text', () => {
		const result = parseMigrationUri('just some words, not a code');

		expect((expectErr(result) as NotMigrationUriError).kind).toBe('plain-text');
	});

	it('rejects an empty string', () => {
		expect(parseMigrationUri('   ').ok).toBe(false);
	});

	it('reports damaged base64 as such', () => {
		const result = parseMigrationUri('otpauth-migration://offline?data=####');

		expect(expectErr(result)).toBeInstanceOf(Base64DecodeError);
	});

	it('reports a payload that is valid base64 but not a migration payload', () => {
		const result = parseMigrationUri(
			`otpauth-migration://offline?data=${toBase64(new Uint8Array([1, 2, 3, 4]))}`,
		);

		expect(expectErr(result).code).toBe('migration/bad-protobuf');
	});

	it('reports a truncated payload rather than returning half the accounts', () => {
		const full = encodePayload({ accounts: [ALICE, BOB] });
		const result = parseMigrationUri(
			`otpauth-migration://offline?data=${toBase64(full.subarray(0, 20))}`,
		);

		expect(result.ok).toBe(false);
	});

	it('returns a Result rather than throwing, for every failure mode', () => {
		const inputs = [
			'',
			'nonsense',
			'https://example.com',
			'otpauth://totp/x?secret=A',
			'otpauth-migration://offline?data=%%%',
		];

		for (const input of inputs) {
			expect(() => parseMigrationUri(input)).not.toThrow();
			expect(parseMigrationUri(input).ok).toBe(false);
		}
	});
});
