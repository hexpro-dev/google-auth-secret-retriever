import { ProtobufParseError } from '../errors.js';
import type { MigrationPayload, RawOtpParameters } from '../types.js';
import { ProtobufReader, WIRE_LENGTH, WIRE_VARINT } from './reader.js';

/**
 * The `otpauth-migration://offline?data=` payload.
 *
 * Google has never published a .proto for this. The schema below was confirmed
 * field by field against a real two-account export (algorithm 1, digits 1,
 * type 2, version 2, batch_size 1, batch_index 0, secrets of 10 and 20 bytes,
 * which base32-encode to 16 and 32 characters exactly as the app displays
 * them). That export is not in this repository and must never be; see the top
 * of CLAUDE.md.
 *
 *   message MigrationPayload {
 *     enum Algorithm  { ALGORITHM_UNSPECIFIED=0; SHA1=1; SHA256=2; SHA512=3; MD5=4; }
 *     enum DigitCount { DIGIT_COUNT_UNSPECIFIED=0; SIX=1; EIGHT=2; }
 *     enum OtpType    { OTP_TYPE_UNSPECIFIED=0; HOTP=1; TOTP=2; }
 *
 *     message OtpParameters {
 *       bytes      secret    = 1;
 *       string     name      = 2;
 *       string     issuer    = 3;
 *       Algorithm  algorithm = 4;
 *       DigitCount digits    = 5;
 *       OtpType    type      = 6;
 *       int64      counter   = 7;
 *     }
 *
 *     repeated OtpParameters otp_parameters = 1;
 *     int32 version    = 2;
 *     int32 batch_size = 3;
 *     int32 batch_index = 4;
 *     int32 batch_id   = 5;
 *   }
 *
 * Unknown fields are skipped rather than rejected. If Google adds a field, this
 * should degrade to ignoring it, not to refusing to read anyone's accounts.
 */

export const ALGORITHM_UNSPECIFIED = 0;
export const DIGITS_UNSPECIFIED = 0;
export const TYPE_UNSPECIFIED = 0;

function parseOtpParameters(bytes: Uint8Array): RawOtpParameters {
	// proto3 defaults: an absent scalar is zero, absent bytes are empty.
	let secret = new Uint8Array(0);
	let name = '';
	let issuer = '';
	let algorithm = ALGORITHM_UNSPECIFIED;
	let digits = DIGITS_UNSPECIFIED;
	let type = TYPE_UNSPECIFIED;
	let counter = 0n;

	const reader = new ProtobufReader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.readTag();
		switch (field) {
			case 1:
				if (wireType !== WIRE_LENGTH) {
					throw new ProtobufParseError(
						reader.position,
						'the secret field has the wrong shape',
						field,
						wireType,
					);
				}
				// Copied, not a view: the caller keeps this after the source
				// buffer is gone, and it is the one thing here that matters.
				secret = new Uint8Array(reader.readLengthDelimited());
				break;
			case 2:
				if (wireType !== WIRE_LENGTH) {
					throw new ProtobufParseError(
						reader.position,
						'the name field has the wrong shape',
						field,
						wireType,
					);
				}
				name = reader.readString();
				break;
			case 3:
				if (wireType !== WIRE_LENGTH) {
					throw new ProtobufParseError(
						reader.position,
						'the issuer field has the wrong shape',
						field,
						wireType,
					);
				}
				issuer = reader.readString();
				break;
			case 4:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the algorithm field has the wrong shape',
						field,
						wireType,
					);
				}
				algorithm = reader.readVarintAsNumber();
				break;
			case 5:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the digits field has the wrong shape',
						field,
						wireType,
					);
				}
				digits = reader.readVarintAsNumber();
				break;
			case 6:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the type field has the wrong shape',
						field,
						wireType,
					);
				}
				type = reader.readVarintAsNumber();
				break;
			case 7:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the counter field has the wrong shape',
						field,
						wireType,
					);
				}
				counter = reader.readVarint();
				break;
			default:
				reader.skip(wireType);
				break;
		}
	}

	return { secret, name, issuer, algorithm, digits, type, counter };
}

export function parseMigrationPayload(bytes: Uint8Array): MigrationPayload {
	const otpParameters: RawOtpParameters[] = [];
	let version = 0;
	let batchSize = 0;
	let batchIndex = 0;
	let batchId = 0;

	const reader = new ProtobufReader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.readTag();
		switch (field) {
			case 1:
				if (wireType !== WIRE_LENGTH) {
					throw new ProtobufParseError(
						reader.position,
						'the account list has the wrong shape',
						field,
						wireType,
					);
				}
				otpParameters.push(parseOtpParameters(reader.readLengthDelimited()));
				break;
			case 2:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the version field has the wrong shape',
						field,
						wireType,
					);
				}
				version = reader.readVarintAsNumber();
				break;
			case 3:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the batch size field has the wrong shape',
						field,
						wireType,
					);
				}
				batchSize = reader.readVarintAsNumber();
				break;
			case 4:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the batch index field has the wrong shape',
						field,
						wireType,
					);
				}
				batchIndex = reader.readVarintAsNumber();
				break;
			case 5:
				if (wireType !== WIRE_VARINT) {
					throw new ProtobufParseError(
						reader.position,
						'the batch id field has the wrong shape',
						field,
						wireType,
					);
				}
				batchId = reader.readVarintAsNumber();
				break;
			default:
				reader.skip(wireType);
				break;
		}
	}

	// A payload with no accounts parsed cleanly but says nothing. Treating it
	// as success would show the user an empty results list with no explanation.
	if (otpParameters.length === 0) {
		throw new ProtobufParseError(0, 'the export contains no accounts');
	}

	// An export always has at least one part, whether or not it says so.
	return {
		otpParameters,
		version,
		batchSize: batchSize === 0 ? 1 : batchSize,
		batchIndex,
		batchId,
	};
}
