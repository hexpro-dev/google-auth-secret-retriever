/** Public types. Values live in the modules that produce them. */

export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512' | 'MD5';
export type OtpType = 'totp' | 'hotp';
export type OtpDigits = 6 | 8;

/** Which fields were filled in by convention because the payload was silent. */
export type AppliedDefault = 'algorithm' | 'digits' | 'type';

/**
 * One account, with every field addressable separately.
 *
 * `uri` is a convenience. It is built from the fields below it, not decoded, so
 * if the two ever disagree the fields are right.
 */
export interface OtpAccount {
	/** RFC 4648 base32, uppercase, unpadded. What an authenticator calls the key. */
	readonly secret: string;
	/**
	 * The raw key material.
	 *
	 * Held as bytes rather than deriving everything from the base32 string
	 * because a `Uint8Array` can be overwritten and a string cannot. See
	 * `wipe()` in `encoding/bytes.ts`, and read its comment before making any
	 * claim about what that achieves.
	 */
	readonly secretBytes: Uint8Array;
	/** The protobuf `issuer` field. Empty string when the export omitted it. */
	readonly issuer: string;
	/** An issuer parsed out of a `Issuer:account` style name, if there was one. */
	readonly labelIssuer: string | null;
	/** The protobuf `name` field, verbatim. */
	readonly name: string;
	/** `name` with any `Issuer:` prefix removed. */
	readonly accountName: string;
	/** Whichever issuer is worth showing: the field, then the label, then nothing. */
	readonly displayIssuer: string;
	readonly type: OtpType;
	readonly algorithm: OtpAlgorithm;
	readonly digits: OtpDigits;
	/**
	 * Always 30, and not decoded from anything.
	 *
	 * The migration payload has no period field. Google Authenticator uses 30
	 * seconds for everything it exports, so that is what this says, and
	 * `periodSource` is here so the value is never mistaken for data that came
	 * out of the QR code. The website surfaces this distinction in its copy.
	 */
	readonly period: 30;
	readonly periodSource: 'google-default';
	/** HOTP only. Zero for TOTP accounts. */
	readonly counter: number;
	/** Rebuilt `otpauth://` URI. Contains the secret; treat it as one. */
	readonly uri: string;
	/** Fields that took a conventional default because the payload was silent. */
	readonly defaultsApplied: readonly AppliedDefault[];
	/** The untranslated protobuf record, for auditing. */
	readonly raw: RawOtpParameters;
}

/** Everything needed to build an `otpauth://` URI. */
export interface OtpAccountInput {
	readonly secret: Uint8Array;
	readonly issuer?: string;
	readonly accountName?: string;
	readonly type?: OtpType;
	readonly algorithm?: OtpAlgorithm;
	readonly digits?: OtpDigits;
	readonly period?: number;
	readonly counter?: number;
}

/** A record straight off the wire, with enum ordinals unmapped. */
export interface RawOtpParameters {
	readonly secret: Uint8Array;
	readonly name: string;
	readonly issuer: string;
	readonly algorithm: number;
	readonly digits: number;
	readonly type: number;
	readonly counter: bigint;
}

export interface MigrationPayload {
	readonly otpParameters: readonly RawOtpParameters[];
	readonly version: number;
	readonly batchSize: number;
	readonly batchIndex: number;
	readonly batchId: number;
}

/** One decoded QR code, or one pasted URI. */
export interface MigrationScan {
	/** The `otpauth-migration://` text that was decoded. Contains secrets. */
	readonly uri: string;
	readonly payload: MigrationPayload;
	/** The decoded protobuf bytes, used to tell a re-scan from a conflict. */
	readonly payloadBytes: Uint8Array;
	readonly accounts: readonly OtpAccount[];
	readonly batch: {
		readonly id: number;
		readonly size: number;
		readonly index: number;
	};
}

export interface TotpCode {
	readonly code: string;
	readonly counter: bigint;
	readonly validFromMs: number;
	readonly validUntilMs: number;
	readonly secondsRemaining: number;
}

/**
 * A bitmap, in the shape `CanvasRenderingContext2D.getImageData` returns.
 *
 * Declared structurally rather than as the DOM `ImageData` so the whole decode
 * path can be exercised in Node with no DOM anywhere near it.
 */
export interface ImageDataLike {
	readonly data: Uint8ClampedArray;
	readonly width: number;
	readonly height: number;
}

export type EcLevel = 'L' | 'M' | 'Q' | 'H';
export type QrMode = 'numeric' | 'alphanumeric' | 'byte' | 'kanji';

export interface Point {
	readonly x: number;
	readonly y: number;
}
