/**
 * The error taxonomy.
 *
 * One base class, a closed string-literal union of codes, and a subclass per
 * failure so a caller can narrow with `instanceof` or switch exhaustively on
 * `code`. Every message is written to be shown to a person as-is, because in
 * practice that is what happens to it.
 *
 * No message ever interpolates secret material. Not the base32 secret, not the
 * payload bytes, not the raw `data` parameter. Errors end up in console logs,
 * bug reports and screenshots, and a tool that leaks a credential into its own
 * diagnostics has failed at the only thing it promised.
 */

export type RetrieverErrorCode =
	| 'qr/not-found'
	| 'qr/decode-failed'
	| 'qr/unsupported'
	| 'qr/too-much-data'
	| 'migration/not-migration-uri'
	| 'migration/bad-base64'
	| 'migration/bad-protobuf'
	| 'migration/invalid-payload'
	| 'secret/bad-base32'
	| 'batch/mismatch'
	| 'otp/unsupported-algorithm'
	| 'crypto/unavailable'
	| 'image/decode-failed'
	| 'camera/permission-denied'
	| 'camera/unavailable'
	| 'camera/in-use';

export class RetrieverError extends Error {
	readonly code: RetrieverErrorCode;

	constructor(code: RetrieverErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
}

export function isRetrieverError(value: unknown): value is RetrieverError {
	return value instanceof RetrieverError;
}

/* ── QR ───────────────────────────────────────────────────────────────────── */

export class QrNotFoundError extends RetrieverError {
	readonly attempts: number;
	readonly elapsedMs: number;

	constructor(attempts: number, elapsedMs: number) {
		super(
			'qr/not-found',
			'No QR code found in that image. Try a sharper, straighter picture with the whole code visible, or use a screenshot instead of a photo.',
		);
		this.attempts = attempts;
		this.elapsedMs = elapsedMs;
	}
}

export type QrDecodeStage = 'format' | 'version' | 'reed-solomon' | 'segments';

export class QrDecodeError extends RetrieverError {
	readonly stage: QrDecodeStage;
	readonly errorsCorrected: number;

	constructor(stage: QrDecodeStage, errorsCorrected = 0, detail?: string) {
		super(
			'qr/decode-failed',
			`Found a QR code but could not read it${detail ? `: ${detail}` : '.'} Too many of its modules are unreadable.`,
		);
		this.stage = stage;
		this.errorsCorrected = errorsCorrected;
	}
}

export type QrUnsupportedFeature =
	'micro-qr' | 'structured-append' | 'fnc1' | 'eci' | 'mode' | 'version';

export class QrUnsupportedFeatureError extends RetrieverError {
	readonly feature: QrUnsupportedFeature;
	readonly detail: string;

	constructor(feature: QrUnsupportedFeature, detail: string) {
		super('qr/unsupported', `This QR code uses a feature this tool does not support: ${detail}.`);
		this.feature = feature;
		this.detail = detail;
	}
}

export class QrCapacityError extends RetrieverError {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(
			'qr/too-much-data',
			`Too much data for one QR code: ${bytes} bytes, and the largest symbol at this error-correction level holds ${maxBytes}.`,
		);
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

/* ── Migration payload ────────────────────────────────────────────────────── */

export type NotMigrationUriKind = 'single-account-uri' | 'other-uri' | 'plain-text';

export class NotMigrationUriError extends RetrieverError {
	readonly kind: NotMigrationUriKind;
	/**
	 * The decoded text, kept so a UI can show what was actually scanned.
	 *
	 * For `single-account-uri` this contains an `otpauth://` URI, which holds a
	 * secret. Callers must treat it with the same care as a secret and must not
	 * log it. It is on the error rather than in the message for exactly that
	 * reason: the message is safe to print, this field is not.
	 */
	readonly text: string;

	constructor(kind: NotMigrationUriKind, text: string) {
		super(
			'migration/not-migration-uri',
			kind === 'single-account-uri'
				? 'That QR code holds a single account rather than an export. You can still read it here.'
				: 'That QR code is not a Google Authenticator export. In the app, use Transfer accounts, then Export accounts.',
		);
		this.kind = kind;
		this.text = text;
	}
}

export class Base64DecodeError extends RetrieverError {
	readonly index: number;
	readonly reason: string;

	constructor(index: number, reason: string) {
		super('migration/bad-base64', 'The export data is damaged and could not be decoded.');
		this.index = index;
		this.reason = reason;
	}
}

export class Base32DecodeError extends RetrieverError {
	readonly index: number;

	constructor(index: number, reason: string) {
		super('secret/bad-base32', `That secret is not valid base32: ${reason}.`);
		this.index = index;
	}
}

export class ProtobufParseError extends RetrieverError {
	readonly offset: number;
	readonly field: number | null;
	readonly wireType: number | null;

	constructor(
		offset: number,
		reason: string,
		field: number | null = null,
		wireType: number | null = null,
	) {
		super(
			'migration/bad-protobuf',
			`The export data does not match the expected format (${reason}).`,
		);
		this.offset = offset;
		this.field = field;
		this.wireType = wireType;
	}
}

export class PayloadValidationError extends RetrieverError {
	readonly field: string;
	readonly accountIndex: number;

	constructor(field: string, accountIndex: number, reason: string) {
		super(
			'migration/invalid-payload',
			`One account in the export is missing required data (${reason}).`,
		);
		this.field = field;
		this.accountIndex = accountIndex;
	}
}

export type BatchMismatchKind = 'foreign-batch' | 'size-mismatch' | 'conflict';

export class BatchMismatchError extends RetrieverError {
	readonly kind: BatchMismatchKind;
	readonly expected: number;
	readonly seen: number;

	constructor(kind: BatchMismatchKind, expected: number, seen: number) {
		super(
			'batch/mismatch',
			kind === 'foreign-batch'
				? 'That QR code belongs to a different export. Finish this one first, or clear it and start again.'
				: kind === 'size-mismatch'
					? 'That QR code says the export has a different number of parts. It is probably from a different export.'
					: 'That QR code has the same part number as one already captured but different contents.',
		);
		this.kind = kind;
		this.expected = expected;
		this.seen = seen;
	}
}

/* ── OTP ──────────────────────────────────────────────────────────────────── */

export class UnsupportedAlgorithmError extends RetrieverError {
	readonly algorithm: string;

	constructor(algorithm: string) {
		super(
			'otp/unsupported-algorithm',
			`This account uses ${algorithm}, which browsers cannot compute. The secret and its parameters are still correct.`,
		);
		this.algorithm = algorithm;
	}
}

export class CryptoUnavailableError extends RetrieverError {
	constructor() {
		super(
			'crypto/unavailable',
			'Generating codes needs WebCrypto, which is only available over https or from a local file.',
		);
	}
}

/* ── Browser adapters ─────────────────────────────────────────────────────── */

export class ImageDecodeError extends RetrieverError {
	readonly mime: string;

	constructor(mime: string, options?: ErrorOptions) {
		super(
			'image/decode-failed',
			mime === 'image/heic' || mime === 'image/heif'
				? 'This browser cannot open HEIC images. Convert it to PNG or JPEG, or take a screenshot instead.'
				: 'That file is not an image this browser can open.',
			options,
		);
		this.mime = mime;
	}
}

export class CameraPermissionError extends RetrieverError {
	constructor(options?: ErrorOptions) {
		super(
			'camera/permission-denied',
			'Camera access was denied. Allow the camera in your browser settings, or upload a screenshot instead.',
			options,
		);
	}
}

export type CameraUnavailableReason = 'insecure-context' | 'no-api' | 'no-device' | 'constraints';

export class CameraUnavailableError extends RetrieverError {
	readonly reason: CameraUnavailableReason;

	constructor(reason: CameraUnavailableReason, options?: ErrorOptions) {
		super(
			'camera/unavailable',
			reason === 'insecure-context'
				? 'The camera is only available over https or from a local file.'
				: reason === 'no-device'
					? 'No camera was found. Upload a screenshot instead.'
					: 'No camera is available here. Upload a screenshot instead.',
			options,
		);
		this.reason = reason;
	}
}

export class CameraInUseError extends RetrieverError {
	constructor(options?: ErrorOptions) {
		super(
			'camera/in-use',
			'The camera is being used by another application. Close it and try again.',
			options,
		);
	}
}
