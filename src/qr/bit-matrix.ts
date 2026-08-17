/**
 * A rectangular grid of bits, used for both the binarised camera image and the
 * sampled QR symbol.
 *
 * One byte per module rather than a packed bitset. The largest thing this ever
 * holds is a 177 by 177 symbol (31 kB) or a downscaled camera frame, and the
 * unpacked form removes a whole class of shift-and-mask bug from code that is
 * already dense enough.
 */
export class BitMatrix {
	readonly width: number;
	readonly height: number;
	readonly bits: Uint8Array;

	constructor(width: number, height: number = width, bits?: Uint8Array) {
		this.width = width;
		this.height = height;
		this.bits = bits ?? new Uint8Array(width * height);
	}

	get(x: number, y: number): boolean {
		return this.bits[y * this.width + x] === 1;
	}

	/** Out-of-bounds reads as light, which is what a quiet zone would be. */
	getSafe(x: number, y: number): boolean {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
			return false;
		}
		return this.bits[y * this.width + x] === 1;
	}

	set(x: number, y: number, value: boolean): void {
		this.bits[y * this.width + x] = value ? 1 : 0;
	}

	xor(x: number, y: number, value: boolean): void {
		if (value) {
			this.bits[y * this.width + x] = (this.bits[y * this.width + x] as number) ^ 1;
		}
	}

	setRegion(x: number, y: number, width: number, height: number, value: boolean): void {
		const fill = value ? 1 : 0;
		for (let row = y; row < y + height; row += 1) {
			this.bits.fill(fill, row * this.width + x, row * this.width + x + width);
		}
	}

	clone(): BitMatrix {
		return new BitMatrix(this.width, this.height, new Uint8Array(this.bits));
	}

	/**
	 * Flip every module.
	 *
	 * The cheapest possible answer to a dark-mode screenshot: rather than
	 * guessing the polarity from the image, the decode ladder simply tries both.
	 * One pass over a Uint8Array costs microseconds.
	 */
	inverted(): BitMatrix {
		const bits = new Uint8Array(this.bits.length);
		for (let i = 0; i < this.bits.length; i += 1) {
			bits[i] = (this.bits[i] as number) ^ 1;
		}
		return new BitMatrix(this.width, this.height, bits);
	}

	/** Mirror horizontally, for a photo of a reflection or a front camera. */
	mirrored(): BitMatrix {
		const out = new BitMatrix(this.width, this.height);
		for (let y = 0; y < this.height; y += 1) {
			for (let x = 0; x < this.width; x += 1) {
				out.set(this.width - 1 - x, y, this.get(x, y));
			}
		}
		return out;
	}

	/**
	 * Reflect across the leading diagonal.
	 *
	 * This is how a mirrored symbol is recovered. Mirroring is invisible to the
	 * finder geometry (a reflected code has three finders in exactly the same
	 * L), so it cannot be detected before sampling. Once sampled, though, a
	 * mirrored symbol is precisely the transpose of a readable one, and 441
	 * bytes of transpose is far cheaper than a second pass over the image.
	 */
	transposed(): BitMatrix {
		const out = new BitMatrix(this.height, this.width);
		for (let y = 0; y < this.height; y += 1) {
			for (let x = 0; x < this.width; x += 1) {
				out.set(y, x, this.get(x, y));
			}
		}
		return out;
	}

	countDark(): number {
		let count = 0;
		for (let i = 0; i < this.bits.length; i += 1) {
			count += this.bits[i] as number;
		}
		return count;
	}

	/** Debug rendering. Handy in a failing test; never shipped to a user. */
	toString(dark = '#', light = '.'): string {
		const rows: string[] = [];
		for (let y = 0; y < this.height; y += 1) {
			let row = '';
			for (let x = 0; x < this.width; x += 1) {
				row += this.get(x, y) ? dark : light;
			}
			rows.push(row);
		}
		return rows.join('\n');
	}
}
