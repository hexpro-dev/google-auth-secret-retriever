import { describe, expect, it } from 'vitest';
import { encodeBase32 } from '../../src/encoding/base32.js';
import { PayloadValidationError } from '../../src/errors.js';
import { accountKey, toAccount, toAccounts } from '../../src/migration/accounts.js';
import { parseOtpauthUri } from '../../src/otp/otpauth-uri.js';
import { parseMigrationPayload } from '../../src/protobuf/migration-payload.js';
import type { RawOtpParameters } from '../../src/types.js';
import {
	ALGORITHM,
	ALICE,
	BOB,
	CAROL,
	DAVE,
	DIGITS,
	SILENT,
	TYPE,
	encodePayload,
	syntheticSecret,
} from '../helpers/build-payload.js';

const raw = (overrides: Partial<RawOtpParameters> = {}): RawOtpParameters => ({
	secret: syntheticSecret('t'),
	name: 'user@example.com',
	issuer: 'Example Corp',
	algorithm: ALGORITHM.SHA1,
	digits: DIGITS.SIX,
	type: TYPE.TOTP,
	counter: 0n,
	...overrides,
});

describe('toAccount enum mapping', () => {
	it.each([
		[ALGORITHM.SHA1, 'SHA1'],
		[ALGORITHM.SHA256, 'SHA256'],
		[ALGORITHM.SHA512, 'SHA512'],
		[ALGORITHM.MD5, 'MD5'],
	])('maps algorithm %i to %s', (value, expected) => {
		expect(toAccount(raw({ algorithm: value })).algorithm).toBe(expected);
	});

	it.each([
		[DIGITS.SIX, 6],
		[DIGITS.EIGHT, 8],
	])('maps digit count %i to %i', (value, expected) => {
		expect(toAccount(raw({ digits: value })).digits).toBe(expected);
	});

	it.each([
		[TYPE.TOTP, 'totp'],
		[TYPE.HOTP, 'hotp'],
	])('maps type %i to %s', (value, expected) => {
		expect(toAccount(raw({ type: value })).type).toBe(expected);
	});

	it('falls back to the conventional reading when an enum is unspecified', () => {
		const account = toAccount(
			raw({ algorithm: ALGORITHM.UNSPECIFIED, digits: DIGITS.UNSPECIFIED, type: TYPE.UNSPECIFIED }),
		);

		expect(account.algorithm).toBe('SHA1');
		expect(account.digits).toBe(6);
		expect(account.type).toBe('totp');
	});

	it('records which values were assumed rather than decoded', () => {
		// The difference between "SHA1 because the payload said SHA1" and "SHA1
		// because the payload said nothing" is the whole point of this field.
		expect(toAccount(raw()).defaultsApplied).toEqual([]);
		expect(toAccount(raw({ algorithm: ALGORITHM.UNSPECIFIED })).defaultsApplied).toEqual([
			'algorithm',
		]);
		expect(toAccount(raw({ algorithm: 0, digits: 0, type: 0 })).defaultsApplied).toEqual([
			'algorithm',
			'digits',
			'type',
		]);
	});

	it('treats an out-of-range enum as unspecified rather than crashing', () => {
		const account = toAccount(raw({ algorithm: 99, digits: 99, type: 99 }));

		expect(account.algorithm).toBe('SHA1');
		expect(account.defaultsApplied).toContain('algorithm');
	});
});

describe('toAccount label handling', () => {
	it('keeps the raw name verbatim', () => {
		expect(toAccount(raw({ name: 'Issuer:user@example.com' })).name).toBe(
			'Issuer:user@example.com',
		);
	});

	it('splits an Issuer:account name', () => {
		const account = toAccount(raw({ name: 'GitHub:octocat', issuer: '' }));

		expect(account.labelIssuer).toBe('GitHub');
		expect(account.accountName).toBe('octocat');
		expect(account.displayIssuer).toBe('GitHub');
	});

	it('splits on the first colon only, because an account name may contain one', () => {
		const account = toAccount(raw({ name: 'Service:user:with:colons', issuer: '' }));

		expect(account.labelIssuer).toBe('Service');
		expect(account.accountName).toBe('user:with:colons');
	});

	it('leaves a name with no colon alone', () => {
		const account = toAccount(raw({ name: 'A4043', issuer: '' }));

		expect(account.labelIssuer).toBeNull();
		expect(account.accountName).toBe('A4043');
		expect(account.displayIssuer).toBe('');
	});

	it('prefers the issuer field over a label prefix when both exist', () => {
		const account = toAccount(raw({ name: 'Old Name:user', issuer: 'Current Issuer' }));

		expect(account.displayIssuer).toBe('Current Issuer');
		expect(account.labelIssuer).toBe('Old Name');
	});

	it('trims the whitespace Google sometimes leaves in a label', () => {
		const account = toAccount(raw({ name: '  Spaced  :  user  ', issuer: '  Trimmed  ' }));

		expect(account.labelIssuer).toBe('Spaced');
		expect(account.accountName).toBe('user');
		expect(account.issuer).toBe('Trimmed');
	});
});

describe('toAccount secret and period', () => {
	it('base32-encodes the secret the way an authenticator displays it', () => {
		const secret = syntheticSecret('display', 20);
		const account = toAccount(raw({ secret }));

		expect(account.secret).toBe(encodeBase32(secret));
		expect(account.secret).toHaveLength(32);
		expect(account.secret).toMatch(/^[A-Z2-7]+$/);
	});

	it('keeps the raw bytes alongside the text form', () => {
		const secret = syntheticSecret('bytes', 10);
		expect(toAccount(raw({ secret })).secretBytes).toEqual(secret);
	});

	it('rejects an account with no secret', () => {
		expect(() => toAccount(raw({ secret: new Uint8Array(0) }))).toThrow(PayloadValidationError);
	});

	it('always reports a 30 second period and says where it came from', () => {
		// The migration payload has no period field at all. Presenting 30 as
		// decoded data would be a quiet lie about a security parameter.
		const account = toAccount(raw());

		expect(account.period).toBe(30);
		expect(account.periodSource).toBe('google-default');
	});

	it('carries an HOTP counter and zeroes it for TOTP', () => {
		expect(toAccount(raw({ type: TYPE.HOTP, counter: 42n })).counter).toBe(42);
		expect(toAccount(raw({ type: TYPE.TOTP, counter: 42n })).counter).toBe(0);
	});
});

describe('toAccount URI round trip', () => {
	it('builds a URI that parses back to the same fields', () => {
		const account = toAccount(raw({ name: 'user@example.com', issuer: 'Example Corp' }));
		const parsed = parseOtpauthUri(account.uri);

		expect(parsed.secret).toEqual(account.secretBytes);
		expect(parsed.issuer).toBe('Example Corp');
		expect(parsed.accountName).toBe('user@example.com');
		expect(parsed.algorithm).toBe('SHA1');
		expect(parsed.digits).toBe(6);
		expect(parsed.period).toBe(30);
	});

	it('does not prefix the issuer twice when the name already carries it', () => {
		const account = toAccount(raw({ name: 'Example Corp:user', issuer: 'Example Corp' }));

		expect(account.uri).toContain('otpauth://totp/Example%20Corp:user?');
		expect(account.uri).not.toContain('Example%20Corp:Example%20Corp');
	});

	it('round trips an HOTP account with its counter', () => {
		const account = toAccount(raw({ type: TYPE.HOTP, counter: 1234n }));
		const parsed = parseOtpauthUri(account.uri);

		expect(parsed.type).toBe('hotp');
		expect(parsed.counter).toBe(1234);
		expect(account.uri).not.toContain('period=');
	});

	it('round trips 8 digits and SHA256', () => {
		const account = toAccount(raw({ algorithm: ALGORITHM.SHA256, digits: DIGITS.EIGHT }));
		const parsed = parseOtpauthUri(account.uri);

		expect(parsed.algorithm).toBe('SHA256');
		expect(parsed.digits).toBe(8);
	});
});

describe('toAccounts', () => {
	it('maps a whole payload in order', () => {
		const payload = parseMigrationPayload(
			encodePayload({ accounts: [ALICE, BOB, CAROL, DAVE, SILENT] }),
		);
		const accounts = toAccounts(payload);

		expect(accounts.map((a) => a.accountName)).toEqual([
			'alice@example.com',
			'bob@example.org',
			'A4043',
			'dave@test.invalid',
			'quiet@example.com',
		]);
		expect(accounts[4]!.defaultsApplied).toEqual(['algorithm', 'digits', 'type']);
	});
});

describe('accountKey', () => {
	it('is stable for the same account', () => {
		expect(accountKey(toAccount(raw()))).toBe(accountKey(toAccount(raw())));
	});

	it('separates two accounts that differ only by secret', () => {
		const a = toAccount(raw({ secret: syntheticSecret('a') }));
		const b = toAccount(raw({ secret: syntheticSecret('b') }));

		expect(accountKey(a)).not.toBe(accountKey(b));
	});

	it('separates accounts that differ by type', () => {
		expect(accountKey(toAccount(raw({ type: TYPE.TOTP })))).not.toBe(
			accountKey(toAccount(raw({ type: TYPE.HOTP }))),
		);
	});
});
