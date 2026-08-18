import { describe, expect, it } from 'vitest';
import { encodeBase32 } from '../../src/encoding/base32.js';
import { ProtobufParseError } from '../../src/errors.js';
import { parseMigrationPayload } from '../../src/protobuf/migration-payload.js';
import { WIRE_FIXED32, WIRE_FIXED64, WIRE_LENGTH, WIRE_VARINT } from '../../src/protobuf/reader.js';
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

/**
 * Rejection paths.
 *
 * This parser eats untrusted input on a security tool, so the shape checks are
 * the part worth testing. A payload that was never a migration payload has to
 * fail loudly here: every batch field defaults to a plausible number and an
 * account list that quietly stayed empty reads as "you have no accounts"
 * rather than "this is not an export".
 */

/** Parse, expecting rejection, and hand back the error so its fields can be read. */
function expectParseError(bytes: Uint8Array): ProtobufParseError {
	try {
		parseMigrationPayload(bytes);
	} catch (error) {
		if (error instanceof ProtobufParseError) {
			return error;
		}
		throw error;
	}
	expect.unreachable('expected the payload to be rejected');
}

/** Wrap a hand-built account submessage in an otherwise well-formed payload. */
function payloadAround(account: Uint8Array): Uint8Array {
	return writer().bytesField(1, account).varintField(2, 2).finish();
}

describe('parseMigrationPayload rejects a field with the wrong wire type', () => {
	// The malformed field goes first in every case below, so the reported
	// offset is one byte in, just past its single-byte tag. That keeps the
	// assertion a constant instead of arithmetic over whatever preceded it.

	it('rejects an account list that arrives as a varint', () => {
		const error = expectParseError(writer().varintField(1, 1234).finish());

		expect(error.code).toBe('migration/bad-protobuf');
		expect(error.field).toBe(1);
		expect(error.wireType).toBe(WIRE_VARINT);
		expect(error.offset).toBe(1);
	});

	it.each([
		{ field: 2, label: 'version' },
		{ field: 3, label: 'batch size' },
		{ field: 4, label: 'batch index' },
		{ field: 5, label: 'batch id' },
	])('rejects the $label field arriving length-delimited', ({ field }) => {
		const bytes = writer()
			.stringField(field, 'not a number')
			.bytesField(1, encodeAccount(ALICE))
			.finish();
		const error = expectParseError(bytes);

		expect(error.field).toBe(field);
		expect(error.wireType).toBe(WIRE_LENGTH);
		expect(error.offset).toBe(1);
	});

	it.each([
		{ wireType: WIRE_FIXED64, width: 8, label: 'fixed64' },
		{ wireType: WIRE_FIXED32, width: 4, label: 'fixed32' },
	])('rejects the batch size field arriving as a $label', ({ wireType, width }) => {
		// The test is "is this a varint", not "is this length-delimited", so a
		// fixed-width number has to be refused as well.
		const bytes = writer()
			.tag(3, wireType)
			.raw(new Uint8Array(width))
			.bytesField(1, encodeAccount(ALICE))
			.finish();
		const error = expectParseError(bytes);

		expect(error.field).toBe(3);
		expect(error.wireType).toBe(wireType);
		expect(error.offset).toBe(1);
	});
});

describe('parseMigrationPayload rejects a malformed account', () => {
	// An account is a nested message, so the offset on these errors counts from
	// the start of the account rather than the start of the payload. Worth
	// knowing before reading one of them in a bug report.

	it.each([
		{ field: 1, label: 'secret' },
		{ field: 2, label: 'name' },
		{ field: 3, label: 'issuer' },
	])('rejects the $label field arriving as a varint', ({ field }) => {
		const account = writer().varintField(field, 7).bytesField(1, ALICE.secret).finish();
		const error = expectParseError(payloadAround(account));

		expect(error.field).toBe(field);
		expect(error.wireType).toBe(WIRE_VARINT);
		expect(error.offset).toBe(1);
	});

	it.each([
		{ field: 4, label: 'algorithm' },
		{ field: 5, label: 'digits' },
		{ field: 6, label: 'type' },
		{ field: 7, label: 'counter' },
	])('rejects the $label field arriving length-delimited', ({ field }) => {
		const account = writer()
			.stringField(field, 'not a number')
			.bytesField(1, ALICE.secret)
			.finish();
		const error = expectParseError(payloadAround(account));

		expect(error.field).toBe(field);
		expect(error.wireType).toBe(WIRE_LENGTH);
		expect(error.offset).toBe(1);
	});

	it('rejects a secret arriving as a fixed64', () => {
		// The secret is the one field where a wrong reading is worth more than
		// an error, so it refuses everything that is not length-delimited.
		const account = writer().tag(1, WIRE_FIXED64).raw(new Uint8Array(8)).finish();
		const error = expectParseError(payloadAround(account));

		expect(error.field).toBe(1);
		expect(error.wireType).toBe(WIRE_FIXED64);
	});
});

describe('parseMigrationPayload rejects truncated data', () => {
	it('rejects a varint that runs off the end of the payload', () => {
		// A continuation byte with nothing after it. Reading it anyway would
		// invent a version number out of half a value.
		const bytes = writer()
			.tag(2, WIRE_VARINT)
			.raw(new Uint8Array([0x80]))
			.finish();
		const error = expectParseError(bytes);

		expect(error.offset).toBe(1);
		// The reader does not know which field it was inside when the bytes ran
		// out, so the offset is the whole of the diagnostic here.
		expect(error.field).toBeNull();
		expect(error.wireType).toBeNull();
	});

	it('rejects an account whose declared length runs past the end of the payload', () => {
		const bytes = writer().tag(1, WIRE_LENGTH).varint(200).raw(encodeAccount(ALICE)).finish();
		const error = expectParseError(bytes);

		expect(error.offset).toBe(1);
	});

	it('rejects a secret whose declared length runs past the end of its account', () => {
		// The dangerous truncation. Without the bounds check the secret would
		// be padded or would read into whatever followed it, and the result is
		// a base32 string that looks entirely reasonable and never works.
		const account = writer()
			.tag(1, WIRE_LENGTH)
			.varint(32)
			.raw(syntheticSecret('truncated', 8))
			.finish();
		const error = expectParseError(payloadAround(account));

		expect(error.offset).toBe(1);
	});

	it('rejects an account that ends inside a counter', () => {
		const account = writer()
			.bytesField(1, syntheticSecret('cut', 20))
			.tag(7, WIRE_VARINT)
			.raw(new Uint8Array([0x80]))
			.finish();

		expect(() => parseMigrationPayload(payloadAround(account))).toThrow(ProtobufParseError);
	});
});

describe('parseMigrationPayload skips fields it does not recognise', () => {
	// Google has never published a .proto for this, so the schema is inferred
	// and a new field is a question of when. Skipping one costs a user nothing;
	// rejecting it would refuse to read their accounts.

	it('skips an unknown field of every wire type', () => {
		const bytes = writer()
			.bytesField(1, encodeAccount(ALICE))
			.varintField(20, 300)
			.tag(21, WIRE_FIXED64)
			.raw(new Uint8Array(8))
			.stringField(22, 'a field from some later version')
			.tag(23, WIRE_FIXED32)
			.raw(new Uint8Array(4))
			.varintField(2, 2)
			.finish();
		const payload = parseMigrationPayload(bytes);

		// Reading the version afterwards is the real assertion: it only comes
		// out right if every skip left the reader on a tag boundary.
		expect(payload.otpParameters).toHaveLength(1);
		expect(payload.version).toBe(2);
	});

	it('skips an unknown field of every wire type inside an account', () => {
		const account = writer()
			.bytesField(1, ALICE.secret)
			.varintField(20, 300)
			.tag(21, WIRE_FIXED64)
			.raw(new Uint8Array(8))
			.stringField(22, 'a field from some later version')
			.tag(23, WIRE_FIXED32)
			.raw(new Uint8Array(4))
			.stringField(2, 'alice@example.com')
			.finish();
		const parsed = parseMigrationPayload(payloadAround(account)).otpParameters[0]!;

		expect(parsed.secret).toEqual(ALICE.secret);
		expect(parsed.name).toBe('alice@example.com');
	});

	it('rejects an unknown field whose own length runs past the end', () => {
		// Skipping is not the same as ignoring. The skip is still bounded, or a
		// malformed unknown field becomes a way around the checks on the known
		// ones.
		const bytes = writer()
			.bytesField(1, encodeAccount(ALICE))
			.tag(24, WIRE_LENGTH)
			.varint(500)
			.raw(new Uint8Array(4))
			.finish();

		expect(() => parseMigrationPayload(bytes)).toThrow(ProtobufParseError);
	});
});

describe('parseMigrationPayload field values', () => {
	it('passes an out-of-range enum through rather than rejecting it', () => {
		// This layer reads the wire format; the schema is somebody else's job.
		// `toAccount` decides what an unrecognised algorithm means and records
		// that it fell back, and that record is lost if the parse throws here.
		const account = {
			secret: syntheticSecret('enums'),
			name: 'future@example.com',
			algorithm: 99,
			digits: 7,
			type: 5,
		};
		const raw = parseMigrationPayload(encodePayload({ accounts: [account] })).otpParameters[0]!;

		expect(raw.algorithm).toBe(99);
		expect(raw.digits).toBe(7);
		expect(raw.type).toBe(5);
	});

	it('takes the last value when a scalar field repeats', () => {
		// proto3 says the last occurrence wins. Rejecting instead would refuse
		// a payload that every other protobuf implementation reads happily.
		const bytes = writer()
			.bytesField(1, encodeAccount(ALICE))
			.varintField(3, 2)
			.varintField(3, 5)
			.finish();

		expect(parseMigrationPayload(bytes).batchSize).toBe(5);
	});

	it('keeps a counter above 2^53 but refuses a batch id that large', () => {
		// The counter is int64 and stays a bigint, so nothing is lost. The
		// batch fields are read as numbers, and a batch id that quietly rounded
		// would make two different exports look like parts of the same one.
		const account = {
			secret: syntheticSecret('counter'),
			name: 'hotp@example.com',
			type: TYPE.HOTP,
			counter: 9223372036854775807n,
		};
		const payload = parseMigrationPayload(encodePayload({ accounts: [account] }));
		expect(payload.otpParameters[0]!.counter).toBe(9223372036854775807n);

		const bytes = writer()
			.varintField(5, 9223372036854775807n)
			.bytesField(1, encodeAccount(ALICE))
			.finish();

		expect(expectParseError(bytes).offset).toBe(1);
	});

	it('rejects empty input', () => {
		// Zero bytes parses cleanly and says nothing at all, which is the one
		// case where "no accounts" would be reported as success.
		const error = expectParseError(new Uint8Array(0));

		expect(error.offset).toBe(0);
		expect(error.field).toBeNull();
		expect(error.wireType).toBeNull();
	});
});
