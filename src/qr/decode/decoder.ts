import { QrNotFoundError, QrUnsupportedFeatureError, RetrieverError } from '../../errors.js';
import { type Result, err, ok } from '../../result.js';
import type { EcLevel, ImageDataLike, Point } from '../../types.js';
import { BitMatrix } from '../bit-matrix.js';
import { versionForDimension } from '../tables.js';
import { binariseHybrid, binariseOtsu, binariseSauvola } from './binarise.js';
import { candidateTriples, findFinderPatterns, moduleSizeAcross } from './finder.js';
import {
	type GreyImage,
	downscaleHalf,
	fitToWork,
	looksInverted,
	toGrey,
	upscaleSmooth,
} from './grey.js';
import { decodeMatrix } from './matrix-decoder.js';
import { findAlignmentCandidates, sampleGrid } from './sample.js';
import type { DecodeFailureReason, DecodeFrame, TelemetrySink } from './telemetry.js';
import { buildSamplingTransform } from './transform.js';
import type { PerspectiveTransform } from './transform.js';

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
	/** Reduce to at most this many pixels before doing any work. */
	readonly maxPixels?: number;
	/**
	 * Reduce so the long edge is at most this before doing any work.
	 *
	 * Discouraged, and ignored when `maxPixels` is given. Every stage is linear
	 * in area and nothing is linear in long edge, so a long-edge cap prices a
	 * 4032 by 3024 photo and a 4032 by 1000 panorama the same when one is four
	 * times the work. Kept for a caller that genuinely knows its input.
	 */
	readonly maxEdge?: number;
}

/**
 * Work ceiling for a still image, in pixels rather than in long edge.
 *
 * 2.5 megapixels is 1826 by 1369 at 4:3, which holds a 141-module symbol (a
 * fifteen account export, the largest this tool needs to plan for) at 9.7 pixels
 * per module across the short edge, and still at 4.8 with the symbol filling only
 * half of it. Nyquist is 2, so there is a factor of two in hand at the largest
 * symbol size and the worst framing this tool is for.
 *
 * Four megapixels was tried first and is not supported by anything measurable:
 * of the 408 corpus cases, 12 exceed 2.5 megapixels, none exceed 4, and all 12
 * score identically at both caps. It also creates a transient nothing else in the
 * pipeline has. The `double` rung upscales the working image by four in area, so
 * a 4 megapixel working image becomes a 16 megapixel one: 16 MB of greyscale and
 * another 16 MB of bitmap, about 50 MB live at once on a phone, for a rung whose
 * whole job is to rescue a *small* symbol. At 2.5 that transient is 20 MB.
 */
export const MAX_WORK_PIXELS = 2_500_000;

/**
 * Ceiling on the binarised bitmap handed to a telemetry consumer.
 *
 * The frame is a picture for a person to look at, not data anything decodes
 * from, and a consumer turns it into an ImageData at four bytes per pixel. At
 * the work ceiling that would be a 2.5 MB array behind a 10 MB ImageData on the
 * main thread. One megapixel is more than any overlay can show.
 */
export const BINARISED_TELEMETRY_PIXELS = 1_000_000;

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
 *
 * The order is set by what a *camera* can reach, because the camera is the only
 * caller that runs out of budget: it takes the front of the ladder and nothing
 * else, so a rung it cannot reach may as well not exist. Measured on 32 dim
 * 1600 by 1200 scenes, the winning rung was `otsu` at one scale or `half` at
 * either polarity in 23 of them, all of which used to sit at position 5 or
 * later, behind `double`.
 *
 * Cost per rung on a 1080p frame, measured: `half` 5 ms, `one` 10 ms, `double`
 * 52 to 64 ms. So the cheap rungs are also the discriminating ones, and putting
 * both polarities and both cheap scales in the first four positions costs less
 * than the old first three did. `double` is the opposite: it is five to twelve
 * times the price of anything else and it won none of the 32, so it goes last
 * where only the still-image budget reaches it. A blank aiming frame used to
 * cost 74 ms because `double` was third.
 */
const LADDER: readonly Rung[] = [
	{ binariser: 'hybrid', scale: 'one', invert: false, robust: false },
	{ binariser: 'hybrid', scale: 'one', invert: true, robust: false },
	// Half scale is the cheapest rung there is and it is the one that reads a dim
	// capture: the 2x2 average is what takes sensor noise out from under the
	// binariser. Both polarities, adjacent, because `looksInverted` guessed wrong
	// on 12 of the 32 dim scenes and a wrong guess must not cost more than one
	// rung.
	{ binariser: 'hybrid', scale: 'half', invert: false, robust: true },
	{ binariser: 'hybrid', scale: 'half', invert: true, robust: true },
	// A global threshold, for the scene the local one over-fits: a dim frame with
	// an evenly lit surround.
	{ binariser: 'otsu', scale: 'one', invert: false, robust: false },
	{ binariser: 'hybrid', scale: 'one', invert: false, robust: true },
	{ binariser: 'sauvola', scale: 'one', invert: false, robust: true },
	{ binariser: 'sauvola', scale: 'one', invert: true, robust: true },
	// Last, and only the still-image budget reaches it. It rescues a symbol too
	// small to sample, which is a photograph problem: a camera that cannot resolve
	// the symbol in this frame will be moved closer before this rung would have
	// paid for itself.
	{ binariser: 'hybrid', scale: 'double', invert: false, robust: false },
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

interface SamplingHypothesis {
	readonly transform: PerspectiveTransform;
	readonly alignment: Point | null;
}

/** Below this, in pixels, a re-search has landed on the same centre. */
const REFIT_MIN_SHIFT = 0.5;

/**
 * Every fourth-correspondence hypothesis worth sampling, best first.
 *
 * The plain three-point fit comes first: it is the right answer for a flat scan
 * and the only answer for version 1, which has no alignment pattern at all.
 * Then the scored alignment candidates, each of them optionally refitted.
 *
 * The refit is the reason this is a list rather than a single answer. The first
 * prediction for the far corner is affine, and on a genuine perspective view
 * that is several modules out, which is why the search window is wide. Once a
 * pattern has been found, though, the four-point fit through it is projective,
 * so its prediction is sub-module accurate and a tight re-search either
 * confirms the centre or lands it properly. Both are kept, because the decode
 * downstream is exact and can simply reject the wrong one.
 */
function alignmentHypotheses(
	source: BitMatrix,
	dimension: number,
	version: number,
	topLeft: Point,
	topRight: Point,
	bottomLeft: Point,
): SamplingHypothesis[] {
	const initial = buildSamplingTransform(dimension, topLeft, topRight, bottomLeft, null, 0);
	const out: SamplingHypothesis[] = [{ transform: initial, alignment: null }];

	for (const match of findAlignmentCandidates(source, initial, version, dimension)) {
		const transform = buildSamplingTransform(
			dimension,
			topLeft,
			topRight,
			bottomLeft,
			match.point,
			match.source,
		);

		const [refined] = findAlignmentCandidates(source, transform, version, dimension, {
			limit: 1,
			radiusModules: 2,
		});
		if (
			refined !== undefined &&
			Math.hypot(refined.point.x - match.point.x, refined.point.y - match.point.y) > REFIT_MIN_SHIFT
		) {
			out.push({
				transform: buildSamplingTransform(
					dimension,
					topLeft,
					topRight,
					bottomLeft,
					refined.point,
					refined.source,
				),
				alignment: refined.point,
			});
		}

		out.push({ transform, alignment: match.point });
	}

	return out;
}

/**
 * How informative a failure reason is, so the most useful one survives.
 *
 * "The grid never fitted" and "the grid fitted and the modules were unreadable"
 * are different conversations with a user, and only the second one is worth
 * answering with "retake the photograph".
 */
const FAILURE_RANK: Readonly<Record<string, number>> = {
	'no-finders': 0,
	// `geometry` sits above `partial-finders`, and the order is load-bearing rather
	// than arbitrary. `geometry` means some rung found all three corner patterns and
	// no grid fitted, which strictly dominates "only some were found": the patterns
	// demonstrably were all there. Ranked the other way round, a half-scale rung
	// that loses one pattern outranks the full-scale rung that found three, so a
	// tilted photograph with nothing cropped is told its crop cut a corner off.
	// That is a false statement about the visitor's own image, in every language,
	// and it suppresses the one piece of advice that would have helped.
	'partial-finders': 1,
	geometry: 2,
	checksum: 3,
	unsupported: 4,
};

function moreInformative(a: DecodeFailureReason, b: DecodeFailureReason): DecodeFailureReason {
	return (FAILURE_RANK[a] ?? 0) >= (FAILURE_RANK[b] ?? 0) ? a : b;
}

/**
 * Whether a sampled grid actually landed on the symbol.
 *
 * Row and column six alternate dark and light across every symbol ever made, so
 * they are the cheapest test there is of whether the grid is in the right place,
 * and unlike Reed-Solomon they answer that question specifically: a misplaced
 * grid scores about a half, near enough to a coin toss, and a genuinely damaged
 * symbol read on the correct grid still scores nearly one.
 *
 * The test is symmetric under transposition, so it costs one pass per sampled
 * grid rather than one per handedness.
 */
function onSymbol(matrix: BitMatrix): boolean {
	let matched = 0;
	let total = 0;

	for (let i = 8; i < matrix.width - 8; i += 1) {
		const dark = i % 2 === 0;
		if (matrix.get(i, 6) === dark) {
			matched += 1;
		}
		if (matrix.get(6, i) === dark) {
			matched += 1;
		}
		total += 2;
	}

	return total > 0 && matched / total >= TIMING_AGREEMENT;
}

/**
 * How much of the timing pattern has to read correctly.
 *
 * Chance is a half. On a 57-module symbol that is 98 samples, so a random grid
 * lands within about 0.15 of a half and never near this, while leaving room for a
 * badly blurred symbol read on the right grid to lose a few.
 */
const TIMING_AGREEMENT = 0.85;

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

	// The most telling thing seen while grinding through the hypotheses. Until
	// something is seen, the honest answer is that the markers were found and no
	// grid fitted.
	let failure: DecodeFailureReason = 'geometry';

	for (const triple of candidateTriples(patterns)) {
		const source = matrix;
		const topLeft = triple.topLeft;
		const topRight = triple.topRight;
		const bottomLeft = triple.bottomLeft;

		// Measured along the two axes joining the finders rather than taken from
		// the row scan, which inflates with rotation, and from both ends of each
		// axis, because under a keystone view the far finder genuinely is a
		// different size. See moduleSizeAcross.
		const acrossTop = moduleSizeAcross(source, topLeft, topRight);
		const downLeft = moduleSizeAcross(source, topLeft, bottomLeft);
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
			// alignment pattern that fit predicts. See alignmentHypotheses.
			for (const { transform, alignment } of alignmentHypotheses(
				source,
				dimension,
				version,
				topLeft,
				topRight,
				bottomLeft,
			)) {
				const sampled = sampleGrid(source, transform, dimension, { robust });
				if (sampled === null) {
					continue;
				}

				// Worked out once per grid rather than per handedness, and only used
				// to describe the failure afterwards.
				const fitted = onSymbol(sampled);

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
									: { x: alignment.x * scaleBack, y: alignment.y * scaleBack },
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
					} catch (error) {
						// Not a symbol at this size or fit, or the wrong
						// handedness. Fall through rather than giving up, but
						// remember what kind of failure it was: a grid that was
						// demonstrably on the symbol and still would not decode is
						// a damaged symbol, and one that was not is a fit that
						// never worked, which is a different sentence to a user
						// and different advice.
						failure = moreInformative(
							failure,
							error instanceof QrUnsupportedFeatureError
								? // Reed-Solomon had already succeeded, so the grid
									// was right and the symbol is simply something
									// this decoder refuses to read.
									'unsupported'
								: fitted
									? 'checksum'
									: 'geometry',
						);
					}
				}
			}
		}
	}

	return { failure };
}

/**
 * The binarised frame, decimated if it is larger than any overlay can show.
 *
 * A consumer turns this into an ImageData at four bytes per pixel on the main
 * thread, so at the work ceiling the honest full-resolution copy would be tens
 * of megabytes for a picture nobody can see the detail in. The frame carries its
 * own width and height, so a smaller one needs no other change.
 */
function binarisedFrame(matrix: BitMatrix): DecodeFrame {
	const pixels = matrix.width * matrix.height;
	if (pixels <= BINARISED_TELEMETRY_PIXELS) {
		return {
			stage: 'binarised',
			width: matrix.width,
			height: matrix.height,
			bits: new Uint8Array(matrix.bits),
		};
	}

	// An integer stride keeps this a nearest-neighbour pick with no arithmetic
	// per pixel beyond the index, and keeps the module grid from beating against
	// a fractional step.
	let stride = Math.ceil(Math.sqrt(pixels / BINARISED_TELEMETRY_PIXELS));
	while (
		Math.ceil(matrix.width / stride) * Math.ceil(matrix.height / stride) >
		BINARISED_TELEMETRY_PIXELS
	) {
		// Rounding up twice can leave the result a fraction over the ceiling, and
		// the ceiling is the whole point of this function.
		stride += 1;
	}
	const width = Math.max(1, Math.ceil(matrix.width / stride));
	const height = Math.max(1, Math.ceil(matrix.height / stride));
	const bits = new Uint8Array(width * height);

	for (let y = 0; y < height; y += 1) {
		const row = Math.min(matrix.height - 1, y * stride) * matrix.width;
		for (let x = 0; x < width; x += 1) {
			bits[y * width + x] = matrix.bits[row + Math.min(matrix.width - 1, x * stride)] as number;
		}
	}

	return { stage: 'binarised', width, height, bits };
}

export function decodeQrFromImageData(
	image: ImageDataLike,
	options: QrDecodeOptions = {},
): Result<QrDecodeSuccess> {
	const now = options.now ?? (() => Date.now());
	const started = now();
	// Sized for the work ceiling above, not for the 800-pixel working image the
	// old halving-only fit happened to produce. All nine rungs over a 2.5
	// megapixel frame with nothing in it measures 177 ms in Node on a 2024 laptop,
	// so a mid-range phone gets four times that and still finishes the ladder,
	// which is the point: a still image is one decode a person is waiting on, and
	// stopping it early to save a tenth of a second is a bad trade.
	const budget = options.timeBudgetMs ?? 1500;
	const maxAttempts = options.maxAttempts ?? LADDER.length;
	const emit = options.onTelemetry;

	emit?.({ stage: 'source', width: image.width, height: image.height });

	// One greyscale conversion, shared by every rung.
	const full = toGrey(image);
	const fitted = fitToWork(full, {
		maxPixels: options.maxPixels ?? (options.maxEdge === undefined ? MAX_WORK_PIXELS : undefined),
		maxEdge: options.maxEdge,
	});
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
					? upscaleSmooth(fitted, 2)
					: fitted;
		const scaleBack = shrink * (rung.scale === 'half' ? 2 : rung.scale === 'double' ? 0.5 : 1);

		let matrix = binarise(scaled, rung.binariser);
		const inverted = startInverted !== rung.invert;
		if (inverted) {
			matrix = matrix.inverted();
		}

		if (attempted === 1 && emit !== undefined) {
			emit(binarisedFrame(matrix));
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
		lastFailure = moreInformative(lastFailure, outcome.failure);
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
