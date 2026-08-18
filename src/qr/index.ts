/**
 * The QR codec on its own.
 *
 * Exported as a subpath because it is about two thirds of this package and has
 * nothing to do with Google Authenticator. Nothing under `src/qr/` imports
 * anything outside it except the shared error base, which is enforced by
 * ESLint, so it stays liftable into its own package if that is ever worth
 * doing.
 */

export { BitMatrix } from './bit-matrix.js';
export { BitReader, BitWriter } from './bit-buffer.js';

export {
	BINARISED_TELEMETRY_PIXELS,
	MAX_WORK_PIXELS,
	decodeQrFromBitMatrix,
	decodeQrFromImageData,
} from './decode/decoder.js';
export type {
	Binariser,
	DecodeAttemptDescriptor,
	QrDecodeOptions,
	QrDecodeSuccess,
} from './decode/decoder.js';
export { decodeMatrix } from './decode/matrix-decoder.js';
export type { MatrixDecodeResult } from './decode/matrix-decoder.js';
export type {
	DecodeFailureReason,
	DecodeFrame,
	TelemetryFinder,
	TelemetrySink,
} from './decode/telemetry.js';

export { binariseHybrid, binariseOtsu, binariseSauvola, otsuThreshold } from './decode/binarise.js';
export {
	downscaleArea,
	downscaleHalf,
	fitPixels,
	fitToWork,
	fitWithin,
	looksInverted,
	toGrey,
	upscaleNearest,
	upscaleSmooth,
} from './decode/grey.js';
export type { GreyImage, WorkLimits } from './decode/grey.js';
export {
	candidateTriples,
	findFinderPatterns,
	moduleSizeAcross,
	moduleSizeBetween,
	orderFinders,
} from './decode/finder.js';
export type { FinderPattern, FinderTriple } from './decode/finder.js';
export { PerspectiveTransform, quadrilateralToQuadrilateral } from './decode/transform.js';

export { encodeQr } from './encode/encoder.js';
export type { QrEncodeOptions, QrSymbol } from './encode/encoder.js';
export { renderQrImageData, renderQrPng, renderQrSvg } from './encode/render.js';
export type { RenderOptions } from './encode/render.js';

export { rsDecode, rsEncode } from './reed-solomon.js';
export { decodeFormatInfo, decodeVersionInfo, encodeFormatInfo, encodeVersionInfo } from './bch.js';
export { MASK_PATTERNS, penaltyScore } from './mask.js';
export {
	ALIGNMENT_CENTRES,
	EC_BLOCKS,
	EC_LEVELS,
	TOTAL_CODEWORDS,
	dimensionForVersion,
	ecBlocksFor,
	versionForDimension,
} from './tables.js';
