import { describe, expect, it } from 'vitest';
import { encodeBase32 } from '../../src/encoding/base32.js';
import { ProtobufParseError } from '../../src/errors.js';
import { parseMigrationPayload } from '../../src/protobuf/migration-payload.js';
import {
	ALGORITHM,
	ALICE,
	BOB,
	CAROL,
	DIGITS,
	SILENT,
	TYPE,
	encodeAccount,
	encodePayload,
	syntheticSecret,
	writer,
} from '../helpers/build-payload.js';

describe('parseMigrationPayload', () => {
	it('reads a single account with every field set', () => {
		const payload = parseMigrationPayload(encodePayload({ accounts: [ALICE] }));

		expect(payload.otpParameters).toHaveLength(1);
		const account = payload.otpParameters[0]!;
		expect(account.secret).toEqual(ALICE.secret);
		expect(account.name).toBe('alice@example.com');
		expect(account.issuer).toBe('Example Corp');
		expect(account.algorithm).toBe(ALGORITHM.SHA1);
		expect(account.digits).toBe(DIGITS.SIX);
		expect(account.type).toBe(TYPE.TOTP);
		expect(account.counter).toBe(0n);
	});

	it('reads several accounts in order', () => {
		const payload = parseMigrationPayload(encodePayload({ accounts: [ALICE, BOB, CAROL] }));

		expect(payload.otpParameters.map((a) => a.name)).toEqual([
			'alice@example.com',
			'bob@example.org',
			'A4043',
		]);
	});

	it('reads the batch envelope', () => {
		const payload = parseMigrationPayload(
			encodePayload({
				accounts: [ALICE],
				version: 2,
				batchSize: 3,
				batchIndex: 1,
				batchId: 987654,
			}),
		);

		expect(payload.version).toBe(2);
		expect(payload.batchSize).toBe(3);
		expect(payload.batchIndex).toBe(1);
		expect(payload.batchId).toBe(987654);
	});

	it('applies proto3 defaults when fields are absent', () => {
		const payload = parseMigrationPayload(encodePayload({ accounts: [SILENT] }));
		const account = payload.otpParameters[0]!;

		expect(account.issuer).toBe('');
		expect(account.algorithm).toBe(ALGORITHM.UNSPECIFIED);
		expect(account.digits).toBe(DIGITS.UNSPECIFIED);
		expect(account.type).toBe(TYPE.UNSPECIFIED);
		expect(account.counter).toBe(0n);
	});

	it('treats an absent batch size as one part', () => {
		// A single-QR export sometimes omits it entirely. Reporting size 0 would
		// make the batch collector think it could never finish.
		const bytes = writer().bytesField(1, encodeAccount(ALICE)).varintField(2, 2).finish();

		expect(parseMigrationPayload(bytes).batchSize).toBe(1);
	});

	it('does not depend on field order', () => {
		// Nothing requires a producer to emit fields in tag order.
		const reversed = writer()
			.varintField(5, 4242)
			.varintField(4, 1)
			.varintField(3, 2)
			.varintField(2, 2)
			.bytesField(1, encodeAccount(ALICE))
			.finish();
		const payload = parseMigrationPayload(reversed);

		expect(payload.otpParameters).toHaveLength(1);
		expect(payload.batchId).toBe(4242);
		expect(payload.batchSize).toBe(2);
	});

	it('accumulates a repeated field split across the message', () => {
		const bytes = writer()
			.bytesField(1, encodeAccount(ALICE))
			.varintField(2, 2)
			.bytesField(1, encodeAccount(BOB))
			.finish();

		expect(parseMigrationPayload(bytes).otpParameters).toHaveLength(2);
	});

	it('reads an HOTP counter', () => {
		const account = {
			secret: syntheticSecret('h'),
			name: 'h',
			type: TYPE.HOTP,
			counter: 9007199254740991,
		};
		const payload = parseMigrationPayload(encodePayload({ accounts: [account] }));

		expect(payload.otpParameters[0]!.counter).toBe(9007199254740991n);
	});

	it('tolerates an unknown field, so a future schema change degrades rather than breaks', () => {
		const bytes = writer()
			.bytesField(1, encodeAccount(ALICE))
			.varintField(2, 2)
			.varintField(99, 12345)
			.stringField(98, 'something new')
			.finish();

		expect(parseMigrationPayload(bytes).otpParameters).toHaveLength(1);
	});

	it('tolerates an unknown field inside an account', () => {
		const account = writer()
			.bytesField(1, ALICE.secret)
			.stringField(2, 'alice@example.com')
			.varintField(42, 7)
			.finish();
		const bytes = writer().bytesField(1, account).varintField(2, 2).finish();

		expect(parseMigrationPayload(bytes).otpParameters[0]!.name).toBe('alice@example.com');
	});

	it('rejects a payload that parses cleanly but contains no accounts', () => {
		// Succeeding here would show an empty results list with no explanation.
		const bytes = writer().varintField(2, 2).varintField(3, 1).finish();

		expect(() => parseMigrationPayload(bytes)).toThrow(ProtobufParseError);
	});

	it('rejects a truncated payload', () => {
		const full = encodePayload({ accounts: [ALICE, BOB] });

		expect(() => parseMigrationPayload(full.subarray(0, full.length - 5))).toThrow(
			ProtobufParseError,
		);
	});

	it('rejects a field whose wire type is wrong for its number', () => {
		// The secret arriving as a varint means this is not a migration payload.
		const account = writer().varintField(1, 1234).finish();
		const bytes = writer().bytesField(1, account).finish();

		expect(() => parseMigrationPayload(bytes)).toThrow(ProtobufParseError);
	});

	it('reports the offset and field on failure, for diagnostics', () => {
		const account = writer().varintField(1, 1234).finish();
		const bytes = writer().bytesField(1, account).finish();

		try {
			parseMigrationPayload(bytes);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(ProtobufParseError);
			expect((error as ProtobufParseError).code).toBe('migration/bad-protobuf');
			expect((error as ProtobufParseError).field).toBe(1);
		}
	});

	it('produces secret lengths that base32-encode the way a real export does', () => {
		// The confirmed real export carried a 10-byte and a 20-byte secret,
		// which the app displays as 16 and 32 characters.
		const payload = parseMigrationPayload(encodePayload({ accounts: [BOB, ALICE] }));

		expect(payload.otpParameters[0]!.secret).toHaveLength(10);
		expect(encodeBase32(payload.otpParameters[0]!.secret)).toHaveLength(16);
		expect(payload.otpParameters[1]!.secret).toHaveLength(20);
		expect(encodeBase32(payload.otpParameters[1]!.secret)).toHaveLength(32);
	});

	it('copies the secret rather than viewing the source buffer', () => {
		// The caller keeps this long after the source is gone, and a view into
		// a recycled decode buffer would be a very hard bug to find.
		const source = encodePayload({ accounts: [ALICE] });
		const payload = parseMigrationPayload(source);
		source.fill(0);

		expect(payload.otpParameters[0]!.secret).toEqual(ALICE.secret);
	});
});
