import { ProtobufParseError } from '../errors.js';

/**
 * Just enough protobuf wire format to read one known message.
 *
 * No schema compiler, no descriptors, no code generation. The migration payload
 * is two message types and seven fields, and a general protobuf runtime would be
 * larger than the rest of this package put together.
 *
 * Every read bounds-checks. Malformed input here means a corrupted QR code that
 * got through Reed-Solomon, or something that was never a migration payload, and
 * both should produce a clear error rather than a confidently wrong account.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH = 2;
export const WIRE_FIXED32 = 5;

export type WireType = 0 | 1 | 2 | 5;

export interface Tag {
	readonly field: number;
	readonly wireType: WireType;
}

export class ProtobufReader {
	private readonly bytes: Uint8Array;
	private offset = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}

	get done(): boolean {
		return this.offset >= this.bytes.length;
	}

	get position(): number {
		return this.offset;
	}

	readTag(): Tag {
		const start = this.offset;
		const key = this.readVarintAsNumber();
		const field = key >>> 3;
		const wireType = key & 7;

		if (field === 0) {
			throw new ProtobufParseError(start, 'field number 0 is not valid');
		}
		// Wire types 3 and 4 are start-group and end-group, removed in proto3.
		// Nothing Google emits uses them, and supporting them would mean a
		// recursive skip for no benefit.
		if (
			wireType !== WIRE_VARINT &&
			wireType !== WIRE_FIXED64 &&
			wireType !== WIRE_LENGTH &&
			wireType !== WIRE_FIXED32
		) {
			throw new ProtobufParseError(
				start,
				`wire type ${wireType} is not supported`,
				field,
				wireType,
			);
		}

		return { field, wireType: wireType as WireType };
	}

	readVarint(): bigint {
		const start = this.offset;
		let result = 0n;
		let shift = 0n;

		for (let i = 0; i < 10; i += 1) {
			if (this.offset >= this.bytes.length) {
				throw new ProtobufParseError(start, 'the data ends inside a number');
			}
			const byte = this.bytes[this.offset] as number;
			this.offset += 1;
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) {
				return result;
			}
			shift += 7n;
		}

		throw new ProtobufParseError(start, 'a number runs longer than 10 bytes');
	}

	/** For fields that are conceptually small. Throws rather than losing precision. */
	readVarintAsNumber(): number {
		const start = this.offset;
		const value = this.readVarint();
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new ProtobufParseError(start, 'a number is too large to be meaningful here');
		}
		return Number(value);
	}

	/** A view into the source buffer, not a copy. Do not mutate it. */
	readLengthDelimited(): Uint8Array {
		const start = this.offset;
		const length = this.readVarintAsNumber();
		if (this.offset + length > this.bytes.length) {
			throw new ProtobufParseError(start, 'a length runs past the end of the data');
		}
		const view = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return view;
	}

	readString(): string {
		// Non-fatal on purpose: a mangled character in an account label should
		// not cost someone the secret sitting next to it.
		return new TextDecoder('utf-8').decode(this.readLengthDelimited());
	}

	/** Step over a field this reader does not care about. */
	skip(wireType: WireType): void {
		const start = this.offset;
		switch (wireType) {
			case WIRE_VARINT:
				this.readVarint();
				return;
			case WIRE_FIXED64:
				if (this.offset + 8 > this.bytes.length) {
					throw new ProtobufParseError(start, 'the data ends inside a fixed64 field');
				}
				this.offset += 8;
				return;
			case WIRE_LENGTH:
				this.readLengthDelimited();
				return;
			case WIRE_FIXED32:
				if (this.offset + 4 > this.bytes.length) {
					throw new ProtobufParseError(start, 'the data ends inside a fixed32 field');
				}
				this.offset += 4;
				return;
		}
	}
}
