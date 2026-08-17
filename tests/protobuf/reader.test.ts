import { describe, expect, it } from 'vitest';
import { ProtobufParseError } from '../../src/errors.js';
import {
	ProtobufReader,
	WIRE_FIXED32,
	WIRE_FIXED64,
	WIRE_LENGTH,
	WIRE_VARINT,
} from '../../src/protobuf/reader.js';
import { writer } from '../helpers/build-payload.js';

describe('ProtobufReader varints', () => {
	const VALUES: readonly bigint[] = [
		0n,
		1n,
		127n,
		128n,
		300n,
		16383n,
		16384n,
		2097151n,
		2097152n,
		4294967295n,
		9007199254740991n,
		9223372036854775807n,
	];

	it.each(VALUES.map((v) => [v.toString()] as const))('round trips %s', (text) => {
		const value = BigInt(text);
		const reader = new ProtobufReader(writer().varint(value).finish());
		expect(reader.readVarint()).toBe(value);
		expect(reader.done).toBe(true);
	});

	it('encodes 127 in one byte and 128 in two, as the wire format requires', () => {
		expect(writer().varint(127).finish()).toHaveLength(1);
		expect(writer().varint(128).finish()).toHaveLength(2);
	});

	it('rejects a varint that never terminates', () => {
		const bytes = new Uint8Array(12).fill(0xff);
		expect(() => new ProtobufReader(bytes).readVarint()).toThrow(ProtobufParseError);
	});

	it('rejects a varint truncated by the end of the buffer', () => {
		expect(() => new ProtobufReader(new Uint8Array([0x80])).readVarint()).toThrow(
			ProtobufParseError,
		);
	});

	it('refuses to silently lose precision in readVarintAsNumber', () => {
		const bytes = writer().varint(9223372036854775807n).finish();
		expect(() => new ProtobufReader(bytes).readVarintAsNumber()).toThrow(ProtobufParseError);
	});
});

describe('ProtobufReader tags', () => {
	it('splits a key into field number and wire type', () => {
		const reader = new ProtobufReader(writer().tag(7, WIRE_VARINT).finish());
		expect(reader.readTag()).toEqual({ field: 7, wireType: WIRE_VARINT });
	});

	it('handles field numbers above 15, which need a two-byte key', () => {
		const reader = new ProtobufReader(writer().tag(2048, WIRE_LENGTH).finish());
		expect(reader.readTag()).toEqual({ field: 2048, wireType: WIRE_LENGTH });
	});

	it('rejects field number 0', () => {
		expect(() => new ProtobufReader(new Uint8Array([0x00])).readTag()).toThrow(ProtobufParseError);
	});

	it.each([3, 4, 6, 7])('rejects wire type %i, which proto3 does not use', (wireType) => {
		const bytes = writer().tag(1, wireType).finish();
		expect(() => new ProtobufReader(bytes).readTag()).toThrow(ProtobufParseError);
	});
});

describe('ProtobufReader length-delimited fields', () => {
	it('reads bytes', () => {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const reader = new ProtobufReader(writer().bytesField(1, payload).finish());
		reader.readTag();
		expect(reader.readLengthDelimited()).toEqual(payload);
	});

	it('reads a zero-length field', () => {
		const reader = new ProtobufReader(writer().bytesField(1, new Uint8Array(0)).finish());
		reader.readTag();
		expect(reader.readLengthDelimited()).toHaveLength(0);
	});

	it('reads utf-8 strings including characters outside the basic plane', () => {
		const reader = new ProtobufReader(writer().stringField(2, 'ünïcøde ✓ 日本語').finish());
		reader.readTag();
		expect(reader.readString()).toBe('ünïcøde ✓ 日本語');
	});

	it('rejects a length that runs past the end of the data', () => {
		// Claims 200 bytes, supplies 2.
		const bytes = new Uint8Array([0x0a, 200, 1, 2]);
		const reader = new ProtobufReader(bytes);
		reader.readTag();
		expect(() => reader.readLengthDelimited()).toThrow(ProtobufParseError);
	});
});

describe('ProtobufReader.skip', () => {
	it('steps over each wire type so unknown fields do not break parsing', () => {
		const bytes = writer()
			.varintField(1, 300)
			.tag(2, WIRE_FIXED64)
			.raw(new Uint8Array(8))
			.bytesField(3, new Uint8Array([9, 9, 9]))
			.tag(4, WIRE_FIXED32)
			.raw(new Uint8Array(4))
			.varintField(5, 7)
			.finish();

		const reader = new ProtobufReader(bytes);
		for (let i = 0; i < 4; i += 1) {
			reader.skip(reader.readTag().wireType);
		}

		// Having skipped four fields of four different shapes, the fifth is
		// still exactly where it should be.
		expect(reader.readTag()).toEqual({ field: 5, wireType: WIRE_VARINT });
		expect(reader.readVarintAsNumber()).toBe(7);
		expect(reader.done).toBe(true);
	});

	it('rejects a fixed64 truncated by the end of the buffer', () => {
		const reader = new ProtobufReader(
			writer().tag(1, WIRE_FIXED64).raw(new Uint8Array(4)).finish(),
		);
		reader.readTag();
		expect(() => reader.skip(WIRE_FIXED64)).toThrow(ProtobufParseError);
	});

	it('rejects a fixed32 truncated by the end of the buffer', () => {
		const reader = new ProtobufReader(
			writer().tag(1, WIRE_FIXED32).raw(new Uint8Array(2)).finish(),
		);
		reader.readTag();
		expect(() => reader.skip(WIRE_FIXED32)).toThrow(ProtobufParseError);
	});
});
