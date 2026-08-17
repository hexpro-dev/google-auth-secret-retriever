import { QrNotFoundError, RetrieverError } from '../../errors.js';
import { type Result, err, ok } from '../../result.js';
import type { EcLevel, ImageDataLike, Point } from '../../types.js';
import type { BitMatrix } from '../bit-matrix.js';
import { versionForDimension } from '../tables.js';
import { binariseHybrid, binariseOtsu, binariseSauvola } from './binarise.js';
import { candidateTriples, findFinderPatterns, moduleSizeBetween } from './finder.js';
import {
	type GreyImage,
	downscaleHalf,
	fitWithin,
	looksInverted,
	toGrey,
	upscaleNearest,
} from './grey.js';
import { decodeMatrix } from './matrix-decoder.js';
import { type AlignmentMatch, findAlignmentCandidates, sampleGrid } from './sample.js';
import type { DecodeFailureReason, DecodeFrame, TelemetrySink } from './telemetry.js';
import { buildSamplingTransform } from './transform.js';

/**
 * Finding and reading a QR code in a picture.
 *
 * The design is a ladder rather than a clever single attempt. Binarisation,
 * scale and polarity are all guesses, and a guess that costs three milliseconds
 * is not worth agonising over: try the cheap likely one, then the next, and
 * report which rung worked so a support conversation has something factual in
 * it. The exact half of decoding sits behind `decodeMatrix` and is never part
 * of the guessing.
 */

export type Binariser = 'hybrid' | 'otsu' | 'sauvola';

export interface DecodeAttemptDescriptor {
	readonly binariser: Binariser;
	readonly scale: 'half' | 'one' | 'double';
	readonly inverted: boolean;
	readonly robustSampling: boolean;
	readonly attempt: number;
}

export interface QrDecodeOptions {
	readonly maxAttempts?: number;
	readonly timeBudgetMs?: number;
	readonly tryInverted?: boolean;
	readonly robustSampling?: boolean;
	/** Injectable clock, so the budget is testable without waiting. */
	readonly now?: () => number;
	readonly onTelemetry?: TelemetrySink;
	/** Downscale so the long edge is at most this before doing any work. */
	readonly maxEdge?: number;
}

export interface QrDecodeSuccess {
	readonly text: string;
	readonly version: number;
	readonly ecLevel: EcLevel;
	readonly mask: number;
	readonly errorsCorrected: number;
	/** Symbol corners in source-image pixels, clockwise from the top-left. */
	readonly corners: readonly Point[];
	readonly attempt: DecodeAttemptDescriptor;
	readonly elapsedMs: number;
}

interface Rung {
	readonly binariser: Binariser;
	readonly scale: 'half' | 'one' | 'double';
	readonly invert: boolean;
	readonly robust: boolean;
}

/**
 * The ladder, cheapest and most likely first.
 *
 * `invert` here means "the opposite of what the corners suggested", not
 * "inverted": the polarity guess from the quiet zone is usually right, so the
 * second rung is the one that tries the other way round.
 */
const LADDER: readonly Rung[] = [
	{ binariser: 'hybrid', scale: 'one', invert: false, robust: false },
	{ binariser: 'hybrid', scale: 'one', invert: true, robust: false },
	{ binariser: 'otsu', scale: 'one', invert: false, robust: false },
	{ binariser: 'hybrid', scale: 'one', invert: false, robust: true },
	{ binariser: 'hybrid', scale: 'half', invert: false, robust: true },
	{ binariser: 'hybrid', scale: 'double', invert: false, robust: false },
	{ binariser: 'sauvola', scale: 'one', invert: false, robust: true },
	{ binariser: 'sauvola', scale: 'one', invert: true, robust: true },
];

function binarise(image: GreyImage, which: Binariser): BitMatrix {
	switch (which) {
		case 'hybrid':
			return binariseHybrid(image);
		case 'otsu':
			return binariseOtsu(image);
		case 'sauvola':
			return binariseSauvola(image);
	}
}

/**
 * Symbol dimensions worth trying, best guess first.
 *
 * The module size is measured, so it carries error, and under a keystone view
 * the two axes genuinely disagree. An error of a few percent moves the estimate
 * by a whole version step on a large symbol, so rather than committing to one
 * answer this offers the nearest legal dimension and its neighbours.
 *
 * Trying a wrong one is cheap and safe: the format information and then
 * Reed-Solomon reject it almost immediately, and they are exact rather than
 * estimated, which makes them a far better arbiter than a tighter guess here
 * would be.
 */
function candidateDimensions(
	topLeft: Point,
	topRight: Point,
	bottomLeft: Point,
	moduleSize: number,
): number[] {
	const width = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y) / moduleSize;
	const height = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y) / moduleSize;

	// The finder centres sit 3.5 modules in from each edge, so the span between
	// them is 7 modules short of the full symbol.
	const estimate = (width + height) / 2 + 7;

	// Legal sizes are 1 mod 4, from 21 to 177.
	const nearest = Math.round((estimate - 17) / 4) * 4 + 17;
	const out: number[] = [];

	for (const dimension of [nearest, nearest - 4, nearest + 4, nearest - 8, nearest + 8]) {
		if (versionForDimension(dimension) !== null && !out.includes(dimension)) {
			out.push(dimension);
		}
	}

	return out;
}

/** Try to read a symbol from one binarised image. Null means "not here". */
function attemptOnMatrix(
	matrix: BitMatrix,
	robust: boolean,
	scaleBack: number,
	emit: ((frame: DecodeFrame) => void) | undefined,
):
	{ result: ReturnType<typeof decodeMatrix>; corners: Point[] } | { failure: DecodeFailureReason } {
	const patterns = findFinderPatterns(matrix);

	emit?.({
		stage: 'finders',
		patterns: patterns.map((p) => ({
			x: p.x * scaleBack,
			y: p.y * scaleBack,
			moduleSize: p.moduleSize * scaleBack,
			confidence: p.count,
		})),
	});

	if (patterns.length === 0) {
		return { failure: 'no-finders' };
	}
	if (patterns.length < 3) {
		// Diagnostic gold: the user cropped a corner off, and the interface can
		// say exactly that instead of "no QR code found".
		return { failure: 'partial-finders' };
	}

	for (const triple of candidateTriples(patterns)) {
		const source = matrix;
		const topLeft = triple.topLeft;
		const topRight = triple.topRight;
		const bottomLeft = triple.bottomLeft;

		// Measured along the two axes joining the finders rather than taken from
		// the row scan, which inflates with rotation. See moduleSizeBetween.
		const acrossTop = moduleSizeBetween(source, topLeft, topRight);
		const downLeft = moduleSizeBetween(source, topLeft, bottomLeft);
		const measured =
			acrossTop !== null && downLeft !== null
				? (acrossTop + downLeft) / 2
				: (acrossTop ?? downLeft);
		const moduleSize =
			measured ??
			(triple.topLeft.moduleSize + triple.topRight.moduleSize + triple.bottomLeft.moduleSize) / 3;

		for (const dimension of candidateDimensions(topLeft, topRight, bottomLeft, moduleSize)) {
			const version = versionForDimension(dimension);
			if (version === null) {
				continue;
			}

			// Fit from the three finders, then look for the bottom-right
			// alignment pattern that fit predicts.
			//
			// Several hypotheses are tried, not one, and the plain three-point
			// fit is among them. That fit is the right answer for a flat scan
			// and the only answer for version 1, which has no alignment pattern
			// at all. Where an alignment pattern does exist, the first fit is
			// affine, so on a perspective view its prediction for the far corner
			// is off by a noticeable fraction of the symbol; the search window
			// has to be wide enough to cover that, and a wide window on a large
			// symbol can contain an inner alignment pattern sitting closer to
			// the bad prediction than the right one. Committing to a single
			// guess drags the whole grid off the symbol, so instead each
			// hypothesis is handed to the decode, which is exact and can simply
			// reject the wrong ones.
			const initial = buildSamplingTransform(dimension, topLeft, topRight, bottomLeft, null, 0);
			const hypotheses: Array<AlignmentMatch | null> = [
				null,
				...findAlignmentCandidates(source, initial, version, dimension),
			];

			for (const alignment of hypotheses) {
				const transform =
					alignment === null
						? initial
						: buildSamplingTransform(
								dimension,
								topLeft,
								topRight,
								bottomLeft,
								alignment.point,
								alignment.source,
							);

				const sampled = sampleGrid(source, transform, dimension, { robust });
				if (sampled === null) {
					continue;
				}

				const corners: Point[] = [
					transform.apply(0, 0),
					transform.apply(dimension, 0),
					transform.apply(dimension, dimension),
					transform.apply(0, dimension),
				].map((point) => ({ x: point.x * scaleBack, y: point.y * scaleBack }));

				// Straight, then transposed. The second attempt is what reads a
				// mirrored symbol, which the finder geometry cannot distinguish and
				// which a photo of a reflection or a front-facing camera produces.
				//
				// Telemetry is emitted only once a candidate actually decodes, so a
				// consumer never draws a sampling grid for a size that turned out to
				// be wrong.
				for (const candidate of [sampled, sampled.transposed()]) {
					try {
						const result = decodeMatrix(candidate);

						emit?.({
							stage: 'located',
							corners: corners as unknown as readonly [Point, Point, Point, Point],
							dimension,
							alignment:
								alignment === null
									? null
									: { x: alignment.point.x * scaleBack, y: alignment.point.y * scaleBack },
							transform: [...transform.coefficients],
						});
						emit?.({ stage: 'sampled', dimension, modules: new Uint8Array(candidate.bits) });
						emit?.({
							stage: 'corrected',
							version: result.version,
							ecLevel: result.ecLevel,
							blocks: 0,
							errorsCorrected: result.errorsCorrected,
						});

						return { result, corners };
					} catch {
						// Not a symbol at this size or fit, or the wrong
						// handedness. Fall through rather than giving up.
					}
				}
			}
		}
	}

	return { failure: 'checksum' };
}

export function decodeQrFromImageData(
	image: ImageDataLike,
	options: QrDecodeOptions = {},
): Result<QrDecodeSuccess> {
	const now = options.now ?? (() => Date.now());
	const started = now();
	const budget = options.timeBudgetMs ?? 400;
	const maxAttempts = options.maxAttempts ?? LADDER.length;
	const emit = options.onTelemetry;

	emit?.({ stage: 'source', width: image.width, height: image.height });

	// One greyscale conversion, shared by every rung.
	const full = toGrey(image);
	const fitted = fitWithin(full, options.maxEdge ?? 1600);
	const shrink = full.width / fitted.width;
	const startInverted = looksInverted(fitted);

	let lastFailure: DecodeFailureReason = 'no-finders';
	let attempted = 0;

	for (const rung of LADDER.slice(0, maxAttempts)) {
		if (now() - started > budget) {
			break;
		}
		attempted += 1;

		const scaled =
			rung.scale === 'half'
				? downscaleHalf(fitted)
				: rung.scale === 'double'
					? upscaleNearest(fitted, 2)
					: fitted;
		const scaleBack = shrink * (rung.scale === 'half' ? 2 : rung.scale === 'double' ? 0.5 : 1);

		let matrix = binarise(scaled, rung.binariser);
		const inverted = startInverted !== rung.invert;
		if (inverted) {
			matrix = matrix.inverted();
		}

		if (attempted === 1) {
			emit?.({
				stage: 'binarised',
				width: matrix.width,
				height: matrix.height,
				bits: new Uint8Array(matrix.bits),
			});
		}

		const outcome = attemptOnMatrix(
			matrix,
			rung.robust || (options.robustSampling ?? false),
			scaleBack,
			emit,
		);

		if ('result' in outcome) {
			const elapsedMs = now() - started;
			emit?.({ stage: 'decoded', text: outcome.result.text, ms: elapsedMs });

			return ok({
				text: outcome.result.text,
				version: outcome.result.version,
				ecLevel: outcome.result.ecLevel,
				mask: outcome.result.mask,
				errorsCorrected: outcome.result.errorsCorrected,
				corners: outcome.corners,
				attempt: {
					binariser: rung.binariser,
					scale: rung.scale,
					inverted,
					robustSampling: rung.robust,
					attempt: attempted,
				},
				elapsedMs,
			});
		}

		// Keep the most informative failure seen, not the last one: "two of
		// three markers" tells the user something, "no markers" does not.
		if (outcome.failure === 'partial-finders' || lastFailure === 'no-finders') {
			lastFailure = outcome.failure;
		}
	}

	const elapsedMs = now() - started;
	emit?.({ stage: 'failed', reason: lastFailure, ms: elapsedMs });

	return err(new QrNotFoundError(attempted, elapsedMs));
}

/** Decode an already-sampled symbol. Exposed for tests and for reuse. */
export function decodeQrFromBitMatrix(matrix: BitMatrix): Result<QrDecodeSuccess> {
	try {
		const result = decodeMatrix(matrix);
		return ok({
			text: result.text,
			version: result.version,
			ecLevel: result.ecLevel,
			mask: result.mask,
			errorsCorrected: result.errorsCorrected,
			corners: [
				{ x: 0, y: 0 },
				{ x: matrix.width, y: 0 },
				{ x: matrix.width, y: matrix.height },
				{ x: 0, y: matrix.height },
			],
			attempt: {
				binariser: 'hybrid',
				scale: 'one',
				inverted: false,
				robustSampling: false,
				attempt: 1,
			},
			elapsedMs: 0,
		});
	} catch (error) {
		if (error instanceof RetrieverError) {
			return err(error);
		}
		throw error;
	}
}
