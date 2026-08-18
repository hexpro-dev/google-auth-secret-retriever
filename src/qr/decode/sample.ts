import type { Point } from '../../types.js';
import { BitMatrix } from '../bit-matrix.js';
import { ALIGNMENT_CENTRES } from '../tables.js';
import type { PerspectiveTransform } from './transform.js';

/**
 * Reading modules out of the image through the transform.
 *
 * The estimating half of decoding ends here. Everything downstream is exact.
 */

export interface SampleOptions {
	/**
	 * Take each module as the majority of a five-point cross rather than a
	 * single centre pixel.
	 *
	 * Roughly four times the work, and it recovers photographs that a single
	 * sample loses: one blown-out pixel in the middle of a module no longer
	 * flips it. Off for the first camera pass, on for still images and for the
	 * later rungs of the ladder.
	 */
	readonly robust?: boolean;
}

export function sampleGrid(
	image: BitMatrix,
	transform: PerspectiveTransform,
	dimension: number,
	options: SampleOptions = {},
): BitMatrix | null {
	const out = new BitMatrix(dimension);
	const robust = options.robust ?? false;

	for (let y = 0; y < dimension; y += 1) {
		for (let x = 0; x < dimension; x += 1) {
			// Module centres, so half a module in from the grid line.
			const point = transform.apply(x + 0.5, y + 0.5);

			if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) {
				// The transform put part of the symbol outside the picture,
				// which means the fit is wrong rather than the code is damaged.
				return null;
			}

			out.set(
				x,
				y,
				robust
					? majorityAt(image, transform, x, y)
					: image.get(Math.floor(point.x), Math.floor(point.y)),
			);
		}
	}

	return out;
}

/** Majority of five samples within one module: centre plus four offsets. */
function majorityAt(
	image: BitMatrix,
	transform: PerspectiveTransform,
	x: number,
	y: number,
): boolean {
	const offsets: ReadonlyArray<readonly [number, number]> = [
		[0.5, 0.5],
		[0.25, 0.5],
		[0.75, 0.5],
		[0.5, 0.25],
		[0.5, 0.75],
	];

	let dark = 0;
	for (const [dx, dy] of offsets) {
		const point = transform.apply(x + dx, y + dy);
		if (image.getSafe(Math.floor(point.x), Math.floor(point.y))) {
			dark += 1;
		}
	}

	return dark >= 3;
}

export interface AlignmentMatch {
	/** Where it was found, in image pixels. */
	readonly point: Point;
	/**
	 * Its position in symbol coordinates.
	 *
	 * The *centre* of the module, so module index 46 is 46.5, exactly as the
	 * finder centres are 3.5 rather than 3. Returning the coordinate rather
	 * than an index or an offset is deliberate: mixing the two conventions puts
	 * the fourth correspondence half a module out, which is invisible on a
	 * clean image and quietly costs a handful of Reed-Solomon corrections on
	 * every symbol large enough to have an alignment pattern.
	 */
	readonly source: number;
	/**
	 * How much this candidate fails to look like a bullseye. Lower is better,
	 * and zero is a perfect one.
	 */
	readonly score: number;
	/** How far it sits from the prediction, in modules. */
	readonly offset: number;
}

export interface AlignmentSearchOptions {
	readonly limit?: number;
	/**
	 * Search radius in modules, overriding the prediction-error estimate.
	 *
	 * For the second pass only, where the prediction came from a four-point fit
	 * and is already sub-module accurate.
	 */
	readonly radiusModules?: number;
}

/**
 * Find candidates for the bottom-right alignment pattern, best-looking first.
 *
 * An empty list is an ordinary outcome, not a failure: version 1 has no
 * alignment pattern at all, and the caller falls back to extrapolating the
 * fourth corner from the three finders.
 */
export function findAlignmentCandidates(
	image: BitMatrix,
	transform: PerspectiveTransform,
	version: number,
	dimension: number,
	options: AlignmentSearchOptions = {},
): AlignmentMatch[] {
	const centres = ALIGNMENT_CENTRES[version - 1] as readonly number[];
	if (centres.length === 0) {
		return [];
	}

	// The bottom-right alignment pattern, in symbol coordinates.
	const centre = centres[centres.length - 1] as number;
	const expected = transform.apply(centre + 0.5, centre + 0.5);

	// One module in image pixels, to size the search.
	const oneModule = Math.hypot(
		transform.apply(centre + 1.5, centre + 0.5).x - expected.x,
		transform.apply(centre + 1.5, centre + 0.5).y - expected.y,
	);
	if (!Number.isFinite(oneModule) || oneModule <= 0) {
		return [];
	}

	// The search window has to cover how wrong the prediction can be, not how
	// big the pattern is. When only three finders are known the fourth corner
	// is extrapolated as if the view were affine, and on a genuine perspective
	// view that extrapolation is off by a good fraction of a symbol width at
	// the far corner. A window sized to a few modules finds the pattern on a
	// flat scan and misses it on exactly the photographs it exists to rescue.
	const radius =
		options.radiusModules !== undefined
			? Math.max(2, Math.round(options.radiusModules * oneModule))
			: Math.max(4, Math.round(Math.min(oneModule * 6 + dimension * oneModule * 0.12, 160)));

	return searchAlignment(
		image,
		Math.round(expected.x),
		Math.round(expected.y),
		radius,
		oneModule,
		options.limit ?? 3,
	).map((candidate) => ({
		point: candidate.point,
		source: centre + 0.5,
		score: candidate.score,
		offset: candidate.offset,
	}));
}

/**
 * Search a window for the alignment pattern, ranked by how much each candidate
 * looks like one.
 *
 * The ranking is the whole point, and getting it wrong is what a wide window
 * costs. An alignment pattern is a 5 by 5 bullseye, so a line through its
 * centre crosses light, dark, light in equal one-module runs, and it does so in
 * *every* direction. An ordinary isolated dark data module satisfies that along
 * the two axes surprisingly often, and there are dozens of them inside a window
 * sized to cover the affine prediction error. Ranking those by distance from a
 * prediction that is known to be several modules out is a lottery: the true
 * pattern came seventh at version 18 and fourteenth at version 26 on measured
 * scenes, and committing to a wrong point drags the whole grid off the symbol,
 * so every module after it samples as noise.
 *
 * So quality first, and position only between candidates of equal quality. On
 * scenes where the affine prediction was up to ten modules out, the true pattern
 * scored 0.05 or better every time and the best false positive never scored
 * below 0.29. Position still matters, because two genuine patterns (the
 * bottom-right one and an inner one that fell inside the window) both score near
 * zero, and then distance from the prediction is all there is to go on.
 */
function searchAlignment(
	image: BitMatrix,
	cx: number,
	cy: number,
	radius: number,
	moduleSize: number,
	limit: number,
): { point: Point; score: number; offset: number }[] {
	const found: { point: Point; score: number; offset: number }[] = [];

	for (let dy = -radius; dy <= radius; dy += 1) {
		const y = cy + dy;
		if (y < 0 || y >= image.height) {
			continue;
		}

		for (let dx = -radius; dx <= radius; dx += 1) {
			const x = cx + dx;
			if (x < 0 || x >= image.width || !image.get(x, y)) {
				continue;
			}

			const measured = scoreAlignmentAt(image, x, y, moduleSize);
			if (measured === null) {
				continue;
			}

			const { point, score } = measured;
			const offset = Math.hypot(point.x - cx, point.y - cy) / moduleSize;

			// Cluster: many starting pixels inside one pattern resolve to the
			// same centre, and those are one candidate rather than hundreds.
			// The best-scoring member of the cluster is the one worth keeping.
			const existing = found.findIndex(
				(candidate) =>
					Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y) < moduleSize,
			);
			if (existing < 0) {
				found.push({ point, score, offset });
			} else if (score < (found[existing] as { score: number }).score) {
				found[existing] = { point, score, offset };
			}
		}
	}

	return found
		.sort((a, b) => {
			// Quality first, at the resolution quality can actually be measured,
			// and position only inside a band. Adding a weighted distance instead
			// looks tidier and cannot work: the weight would have to be small
			// enough not to swamp the gap between a pattern and a data module
			// (measured at 0.05 against 0.29) and large enough to separate two
			// candidates that both score near zero, and there is no such number.
			const band = Math.floor(a.score / SCORE_BAND) - Math.floor(b.score / SCORE_BAND);
			return band !== 0 ? band : a.offset - b.offset;
		})
		.slice(0, limit);
}

/**
 * Scores within this of each other are the same score.
 *
 * A tenth. Two genuine patterns in one window (the bottom-right one and an inner
 * one) measured 0.01 to 0.05 apart, and the best data-module false positive
 * measured 0.29, so a tenth separates the two populations and not the pair.
 */
const SCORE_BAND = 0.1;

/** How many directions a bullseye is measured along: both axes, both diagonals. */
const SCORE_DIRECTIONS = 4;

/**
 * What a direction with no measurable run triple costs.
 *
 * Charged rather than rejected outright, because blur erodes the light ring at
 * the corners of a pattern before it touches the axes, and a real pattern at
 * three pixels per module can lose a diagonal. Large enough that a candidate
 * missing both diagonals loses to any genuine pattern.
 */
const MISSING_DIRECTION = 2;

/**
 * Score a candidate centre, and refine it.
 *
 * Null means "not a plausible pattern at all", which is the acceptance test:
 * both axes have to produce a light-dark-light triple of roughly equal runs, at
 * roughly the expected module size. The diagonals do not gate, they only score,
 * and they are where nearly all of the discrimination comes from.
 */
function scoreAlignmentAt(
	image: BitMatrix,
	x: number,
	y: number,
	moduleSize: number,
): { point: Point; score: number } | null {
	const horizontal = measureRunTriple(image, x, y, 1, 0, moduleSize);
	if (horizontal === null || !plausible(horizontal, moduleSize)) {
		return null;
	}
	const vertical = measureRunTriple(image, x, y, 0, 1, moduleSize);
	if (vertical === null || !plausible(vertical, moduleSize)) {
		return null;
	}

	const diagonals = [
		measureRunTriple(image, x, y, 1, 1, moduleSize),
		measureRunTriple(image, x, y, 1, -1, moduleSize),
	];

	let error = horizontal.error + vertical.error;
	for (const diagonal of diagonals) {
		error += diagonal === null ? MISSING_DIRECTION : diagonal.error;
	}

	// Opposite directions of one pair cross the same rings, so a real pattern
	// implies the same module size along both. The two pairs do not agree with
	// each other except at 22.5 degrees of rotation, which is why they are
	// compared within a pair rather than across all four.
	const axisPair = pairDisagreement(horizontal.size, vertical.size);
	const diagonalPair =
		diagonals[0] === null || diagonals[1] === null
			? MISSING_DIRECTION / 2
			: pairDisagreement(diagonals[0].size, diagonals[1].size);

	return {
		point: { x: x + horizontal.offset, y: y + vertical.offset },
		score: error / SCORE_DIRECTIONS + axisPair + diagonalPair,
	};
}

function pairDisagreement(a: number, b: number): number {
	const mean = (a + b) / 2;
	return mean > 0 ? Math.abs(a - b) / mean : MISSING_DIRECTION;
}

interface RunTriple {
	/** Light, dark centre, light, in steps along the direction. */
	readonly runs: readonly [number, number, number];
	/** Implied module size, in pixels. */
	readonly size: number;
	/** How far the three runs are from equal, as a scale-free sum of squares. */
	readonly error: number;
	/** Where the centre of the middle run sits, in steps from the start point. */
	readonly offset: number;
}

/**
 * Measure the light-dark-light run triple through a point along one direction.
 *
 * The outer dark ring is required but not measured: reaching it is what tells a
 * real pattern from a dark module with a wide light gap beside it, while its
 * width says nothing, because it touches ordinary data modules more often than
 * not and its run merges with them.
 */
function measureRunTriple(
	image: BitMatrix,
	x: number,
	y: number,
	dx: number,
	dy: number,
	moduleSize: number,
): RunTriple | null {
	// A diagonal step covers root two pixels, so runs counted in steps have to
	// be converted before any size is compared with a module width.
	const stepLength = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
	const limit = (moduleSize * 3) / stepLength;

	const walk = (sign: number): { centre: number; light: number } | null => {
		let centre = 0;
		let light = 0;
		let inLight = false;
		let px = x + sign * dx;
		let py = y + sign * dy;

		while (px >= 0 && py >= 0 && px < image.width && py < image.height) {
			const dark = image.get(px, py);

			if (!inLight) {
				if (dark) {
					centre += 1;
				} else {
					inLight = true;
					light += 1;
				}
			} else if (!dark) {
				light += 1;
			} else {
				// Reached the outer dark ring, which is as far as we care.
				return { centre, light };
			}

			if (centre > limit || light > limit) {
				return null;
			}

			px += sign * dx;
			py += sign * dy;
		}

		return null;
	};

	const back = walk(-1);
	const forward = walk(1);
	if (back === null || forward === null) {
		return null;
	}

	const runs: [number, number, number] = [
		back.light,
		back.centre + 1 + forward.centre,
		forward.light,
	];
	const mean = (runs[0] + runs[1] + runs[2]) / 3;
	if (mean <= 0) {
		return null;
	}

	// Normalised by the mean rather than measured in pixels, so the number means
	// the same thing at four pixels per module as at fifteen.
	let error = 0;
	for (const run of runs) {
		error += ((run - mean) / mean) ** 2;
	}

	return { runs, size: mean * stepLength, error, offset: (forward.centre - back.centre) / 2 };
}

/**
 * Whether a triple is worth scoring at all.
 *
 * The runs are compared to each other rather than to `moduleSize` directly,
 * because a scan across a rotated symbol stretches all three by the same
 * factor. An absolute test would reject the pattern on any photograph held at
 * an angle, which is most of them. The absolute size still has to be in the
 * right neighbourhood, or a large smudge would qualify.
 */
function plausible(triple: RunTriple, moduleSize: number): boolean {
	const mean = (triple.runs[0] + triple.runs[1] + triple.runs[2]) / 3;
	for (const run of triple.runs) {
		if (Math.abs(run - mean) > mean * 0.6) {
			return false;
		}
	}
	return triple.size >= moduleSize * 0.5 && triple.size <= moduleSize * 2.2;
}
