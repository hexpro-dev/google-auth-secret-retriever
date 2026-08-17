/** Small byte helpers shared across the encoding layer. */

/** Constant-time-ish equality. Not a security boundary, just a tidy helper. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= (a[i] as number) ^ (b[i] as number);
	}
	return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 1) {
		out += (bytes[i] as number).toString(16).padStart(2, '0');
	}
	return out;
}

export function fromHex(hex: string): Uint8Array {
	const clean = hex.replace(/\s+/g, '');
	if (clean.length % 2 !== 0) {
		throw new Error('hex string must have an even length');
	}
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) {
			throw new Error(`invalid hex at index ${i * 2}`);
		}
		out[i] = byte;
	}
	return out;
}

/**
 * Overwrite a byte array in place.
 *
 * Worth being precise about what this does and does not achieve, because the
 * website's privacy copy depends on the distinction. It zeroes the one buffer
 * you hand it. It cannot reach copies the engine made, and it does nothing at
 * all for strings, which are immutable in JavaScript. That is why secrets are
 * held as `Uint8Array` here and the base32 form is derived on demand rather
 * than cached. Do not describe this as memory scrubbing.
 */
export function wipe(bytes: Uint8Array): void {
	bytes.fill(0);
}
