/**
 * Bit-level reading and writing, most significant bit first.
 *
 * Every bit ordering in QR is MSB-first: mode indicators, character counts,
 * segment data, codewords. Having one implementation of that rather than an
 * ad-hoc shift at each call site removes an entire category of bug, and it is
 * the kind of bug that produces plausible-looking wrong output rather than an
 * obvious failure.
 */

export class BitWriter {
	private readonly bytes: number[] = [];
	private current = 0;
	private used = 0;

	get bitLength(): number {
		return this.bytes.length * 8 + this.used;
	}

	/** Append the low `bits` bits of `value`. */
	put(value: number, bits: number): this {
		for (let i = bits - 1; i >= 0; i -= 1) {
			this.putBit(((value >>> i) & 1) === 1);
		}
		return this;
	}

	putBit(bit: boolean): this {
		this.current = (this.current << 1) | (bit ? 1 : 0);
		this.used += 1;
		if (this.used === 8) {
			this.bytes.push(this.current);
			this.current = 0;
			this.used = 0;
		}
		return this;
	}

	putBytes(bytes: Uint8Array): this {
		for (const byte of bytes) {
			this.put(byte, 8);
		}
		return this;
	}

	/** Zero-fill to the next byte boundary. */
	padToByte(): this {
		while (this.used !== 0) {
			this.putBit(false);
		}
		return this;
	}

	toBytes(): Uint8Array {
		const out = new Uint8Array(this.bytes.length + (this.used > 0 ? 1 : 0));
		out.set(this.bytes);
		if (this.used > 0) {
			// A partial final byte is left-aligned, which is what the QR data
			// stream expects: the unused low bits are the terminator's padding.
			out[this.bytes.length] = this.current << (8 - this.used);
		}
		return out;
	}
}

export class BitReader {
	private readonly bytes: Uint8Array;
	private offset = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}

	get remaining(): number {
		return this.bytes.length * 8 - this.offset;
	}

	get position(): number {
		return this.offset;
	}

	read(bits: number): number {
		if (bits > this.remaining) {
			throw new RangeError(`asked for ${bits} bits with ${this.remaining} left`);
		}
		let value = 0;
		for (let i = 0; i < bits; i += 1) {
			value = (value << 1) | (this.readBit() ? 1 : 0);
		}
		return value;
	}

	readBit(): boolean {
		const byte = this.bytes[this.offset >>> 3] as number;
		const bit = ((byte >>> (7 - (this.offset & 7))) & 1) === 1;
		this.offset += 1;
		return bit;
	}

	readBytes(count: number): Uint8Array {
		const out = new Uint8Array(count);
		for (let i = 0; i < count; i += 1) {
			out[i] = this.read(8);
		}
		return out;
	}
}
