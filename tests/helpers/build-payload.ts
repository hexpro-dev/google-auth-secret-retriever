import { createHash } from 'node:crypto';

/**
 * A protobuf writer, used only by tests and the fixture generator.
 *
 * Every payload this package is tested against is built here from hard-coded
 * synthetic inputs. No real Google Authenticator export is in this repository
 * and none may be added: it is public, git history is permanent, and an export
 * QR is the full credential for every account inside it. See CLAUDE.md.
 *
 * Writing this by hand rather than reusing the reader also means the tests are
 * not checking the parser against itself.
 */

class Writer {
	private readonly parts: number[] = [];

	varint(value: number | bigint): this {
		let v = BigInt(value);
		if (v < 0n) {
			// Negative int64 is encoded as a 10-byte two's complement varint.
			v += 1n << 64n;
		}
		do {
			const byte = Number(v & 0x7fn);
			v >>= 7n;
			this.parts.push(v > 0n ? byte | 0x80 : byte);
		} while (v > 0n);
		return this;
	}

	tag(field: number, wireType: number): this {
		return this.varint((field << 3) | wireType);
	}

	varintField(field: number, value: number | bigint): this {
		return this.tag(field, 0).varint(value);
	}

	bytesField(field: number, value: Uint8Array): this {
		this.tag(field, 2).varint(value.length);
		for (const byte of value) {
			this.parts.push(byte);
		}
		return this;
	}

	stringField(field: number, value: string): this {
		return this.bytesField(field, new TextEncoder().encode(value));
	}

	/** Raw bytes with no tag, for splicing pre-built submessages. */
	raw(value: Uint8Array): this {
		for (const byte of value) {
			this.parts.push(byte);
		}
		return this;
	}

	finish(): Uint8Array {
		return new Uint8Array(this.parts);
	}
}

export function writer(): Writer {
	return new Writer();
}

/* ── Synthetic key material ───────────────────────────────────────────────── */

/** The RFC 4226 / RFC 6238 test seed. Published in an RFC, so safe by design. */
export const RFC_TEST_SEED = new TextEncoder().encode('12345678901234567890');

/**
 * A deterministic, obviously-fake secret of a given length.
 *
 * Derived from a labelled hash so the same fixture always produces the same
 * bytes and nobody is tempted to paste in something real to get variety.
 */
export function syntheticSecret(label: string, length = 20): Uint8Array {
	const out = new Uint8Array(length);
	let written = 0;
	let counter = 0;
	while (written < length) {
		const block = createHash('sha256').update(`gasr-fixture-${label}-${counter}`).digest();
		const take = Math.min(block.length, length - written);
		out.set(block.subarray(0, take), written);
		written += take;
		counter += 1;
	}
	return out;
}

/* ── Payload construction ─────────────────────────────────────────────────── */

export const ALGORITHM = {
	UNSPECIFIED: 0,
	SHA1: 1,
	SHA256: 2,
	SHA512: 3,
	MD5: 4,
} as const;

export const DIGITS = { UNSPECIFIED: 0, SIX: 1, EIGHT: 2 } as const;
export const TYPE = { UNSPECIFIED: 0, HOTP: 1, TOTP: 2 } as const;

export interface AccountSpec {
	readonly secret: Uint8Array;
	readonly name?: string;
	readonly issuer?: string;
	readonly algorithm?: number;
	readonly digits?: number;
	readonly type?: number;
	readonly counter?: number | bigint;
}

export function encodeAccount(spec: AccountSpec): Uint8Array {
	const w = writer().bytesField(1, spec.secret);
	if (spec.name !== undefined) {
		w.stringField(2, spec.name);
	}
	if (spec.issuer !== undefined) {
		w.stringField(3, spec.issuer);
	}
	if (spec.algorithm !== undefined) {
		w.varintField(4, spec.algorithm);
	}
	if (spec.digits !== undefined) {
		w.varintField(5, spec.digits);
	}
	if (spec.type !== undefined) {
		w.varintField(6, spec.type);
	}
	if (spec.counter !== undefined) {
		w.varintField(7, spec.counter);
	}
	return w.finish();
}

export interface PayloadSpec {
	readonly accounts: readonly AccountSpec[];
	readonly version?: number;
	readonly batchSize?: number;
	readonly batchIndex?: number;
	readonly batchId?: number;
}

export function encodePayload(spec: PayloadSpec): Uint8Array {
	const w = writer();
	for (const account of spec.accounts) {
		w.bytesField(1, encodeAccount(account));
	}
	w.varintField(2, spec.version ?? 2);
	w.varintField(3, spec.batchSize ?? 1);
	w.varintField(4, spec.batchIndex ?? 0);
	w.varintField(5, spec.batchId ?? 0);
	return w.finish();
}

/** Standard base64, matching what Google emits. Deliberately not url-safe. */
export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

export interface MigrationUriOptions {
	/** Percent-encode the payload, as Google's own QR codes do. Default true. */
	readonly encode?: boolean;
	/** Include base64 '=' padding. Default true. */
	readonly pad?: boolean;
}

export function toMigrationUri(spec: PayloadSpec, options: MigrationUriOptions = {}): string {
	let data = toBase64(encodePayload(spec));
	if (options.pad === false) {
		data = data.replace(/=+$/, '');
	}
	if (options.encode !== false) {
		data = encodeURIComponent(data);
	}
	return `otpauth-migration://offline?data=${data}`;
}

/* ── Ready-made specs ─────────────────────────────────────────────────────── */

export const ALICE: AccountSpec = {
	secret: syntheticSecret('alice', 20),
	name: 'alice@example.com',
	issuer: 'Example Corp',
	algorithm: ALGORITHM.SHA1,
	digits: DIGITS.SIX,
	type: TYPE.TOTP,
};

export const BOB: AccountSpec = {
	secret: syntheticSecret('bob', 10),
	name: 'bob@example.org',
	issuer: 'Test Service',
	algorithm: ALGORITHM.SHA256,
	digits: DIGITS.EIGHT,
	type: TYPE.TOTP,
};

/** No issuer field and no label prefix, like the second account in a real export. */
export const CAROL: AccountSpec = {
	secret: syntheticSecret('carol', 20),
	name: 'A4043',
	algorithm: ALGORITHM.SHA1,
	digits: DIGITS.SIX,
	type: TYPE.TOTP,
};

/** Counter-based, so it exercises the HOTP path. */
export const DAVE: AccountSpec = {
	secret: syntheticSecret('dave', 20),
	name: 'dave@test.invalid',
	issuer: 'Demo Bank',
	algorithm: ALGORITHM.SHA1,
	digits: DIGITS.SIX,
	type: TYPE.HOTP,
	counter: 42,
};

/** Every enum left unspecified, so the defaulting path is exercised. */
export const SILENT: AccountSpec = {
	secret: syntheticSecret('silent', 20),
	name: 'quiet@example.com',
};
