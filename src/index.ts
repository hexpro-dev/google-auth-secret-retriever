import { parseMigrationUri } from './migration/parse-uri.js';
import { decodeQrFromImageData } from './qr/decode/decoder.js';
import type { QrDecodeOptions } from './qr/decode/decoder.js';
import { type Result, err } from './result.js';
import type { ImageDataLike, MigrationScan } from './types.js';

/**
 * Read a Google Authenticator export QR code out of a picture.
 *
 * The one call most consumers need: pixels in, accounts out. The pieces are all
 * exported separately too, for anyone who already has the QR text, or who wants
 * to build otpauth URIs without going near an image.
 *
 * Returns a `Result` rather than throwing, because both halves of the job fail
 * routinely and for reasons a person can act on: there was no code in the
 * picture, or there was one and it was not an export. The error carries a
 * `code` from a closed union so a caller can tell those apart precisely.
 */
export function readMigrationQr(
	image: ImageDataLike,
	options: QrDecodeOptions = {},
): Result<MigrationScan> {
	const decoded = decodeQrFromImageData(image, options);
	if (!decoded.ok) {
		return err(decoded.error);
	}

	return parseMigrationUri(decoded.value.text);
}

/**
 * Read one from text that has already been extracted.
 *
 * Accepts the full `otpauth-migration://` URI or a bare base64 payload, which
 * is what someone arrives with after using `zbarimg` or any generic QR reader.
 */
export { parseMigrationUri } from './migration/parse-uri.js';
export { extractMigrationData } from './migration/parse-uri.js';

/* ── Types ────────────────────────────────────────────────────────────────── */

export type {
	AppliedDefault,
	EcLevel,
	ImageDataLike,
	MigrationPayload,
	MigrationScan,
	OtpAccount,
	OtpAccountInput,
	OtpAlgorithm,
	OtpDigits,
	OtpType,
	Point,
	QrMode,
	RawOtpParameters,
	TotpCode,
} from './types.js';

export type { Result } from './result.js';
export { attempt, err, ok, unwrap } from './result.js';

/* ── Payload ──────────────────────────────────────────────────────────────── */

export { parseMigrationPayload } from './protobuf/migration-payload.js';
export { accountKey, toAccount, toAccounts } from './migration/accounts.js';
export { BatchCollector } from './migration/batch.js';
export type { BatchAddOutcome, BatchProgress } from './migration/batch.js';

/* ── One-time passwords ───────────────────────────────────────────────────── */

export { buildOtpauthUri, parseOtpauthUri } from './otp/otpauth-uri.js';
export { generateHotp } from './otp/hotp.js';
export type { HotpOptions } from './otp/hotp.js';
export { generateTotp } from './otp/totp.js';
export type { TotpOptions } from './otp/totp.js';

/* ── Encoding ─────────────────────────────────────────────────────────────── */

export { decodeBase32, encodeBase32, isValidBase32 } from './encoding/base32.js';
export { decodeBase64Loose, encodeBase64 } from './encoding/base64.js';
export { bytesEqual, fromHex, toHex, wipe } from './encoding/bytes.js';

/* ── QR ───────────────────────────────────────────────────────────────────── */

export {
	MAX_WORK_PIXELS,
	decodeQrFromBitMatrix,
	decodeQrFromImageData,
} from './qr/decode/decoder.js';
export type {
	Binariser,
	DecodeAttemptDescriptor,
	QrDecodeOptions,
	QrDecodeSuccess,
} from './qr/decode/decoder.js';
export type {
	DecodeFailureReason,
	DecodeFrame,
	TelemetryFinder,
	TelemetrySink,
} from './qr/decode/telemetry.js';
export { encodeQr } from './qr/encode/encoder.js';
export type { QrEncodeOptions, QrSymbol } from './qr/encode/encoder.js';
export { renderQrImageData, renderQrPng, renderQrSvg } from './qr/encode/render.js';
export type { RenderOptions } from './qr/encode/render.js';

/* ── Errors ───────────────────────────────────────────────────────────────── */

export {
	Base32DecodeError,
	Base64DecodeError,
	BatchMismatchError,
	CameraInUseError,
	CameraPermissionError,
	CameraUnavailableError,
	CryptoUnavailableError,
	ImageDecodeError,
	NotMigrationUriError,
	PayloadValidationError,
	ProtobufParseError,
	QrCapacityError,
	QrDecodeError,
	QrNotFoundError,
	QrUnsupportedFeatureError,
	RetrieverError,
	UnsupportedAlgorithmError,
	isRetrieverError,
} from './errors.js';
export type {
	BatchMismatchKind,
	CameraUnavailableReason,
	NotMigrationUriKind,
	QrDecodeStage,
	QrUnsupportedFeature,
	RetrieverErrorCode,
} from './errors.js';
