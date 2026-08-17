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
}

/**
 * Find the bottom-right alignment pattern.
 *
 * Searches a window around where the three-finder fit predicts it should be.
 * Returning null is an ordinary outcome, not a failure: version 1 has no
 * alignment pattern at all, and the caller falls back to extrapolating the
 * fourth corner from the three finders.
 */
export function findAlignmentPattern(
	image: BitMatrix,
	transform: PerspectiveTransform,
	version: number,
	dimension: number,
): AlignmentMatch | null {
	const centres = ALIGNMENT_CENTRES[version - 1] as readonly number[];
	if (centres.length === 0) {
		return null;
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
		return null;
	}

	// The search window has to cover how wrong the prediction can be, not how
	// big the pattern is. When only three finders are known the fourth corner
	// is extrapolated as if the view were affine, and on a genuine perspective
	// view that extrapolation is off by a good fraction of a symbol width at
	// the far corner. A window sized to a few modules finds the pattern on a
	// flat scan and misses it on exactly the photographs it exists to rescue.
	const radius = Math.max(
		4,
		Math.round(Math.min(oneModule * 6 + dimension * oneModule * 0.12, 160)),
	);
	const found = searchAlignment(
		image,
		Math.round(expected.x),
		Math.round(expected.y),
		radius,
		oneModule,
	);

	return found === null ? null : { point: found, source: centre + 0.5 };
}

/**
 * Search a window for the alignment pattern, keeping the best match.
 *
 * The check matters more than the search. An alignment pattern is a 5 by 5
 * bullseye, so a line through its centre crosses light, dark, light in equal
 * one-module runs, and it does so along both axes.
 *
 * The tempting weaker test is "an isolated dark module about the right size",
 * and it is badly wrong. A great many modules in a symbol look like that, so
 * with a prediction that is a few dozen pixels out (which is exactly the case
 * on a perspective view, since the first fit is affine) the search locks onto
 * an ordinary data module, the refit drags the whole grid off the symbol, and
 * every module after it samples as noise. That failure is invisible from the
 * outside: three finders located, a confident-looking fit, and a payload that
 * decodes as nothing at all.
 *
 * Candidates are collected across the whole window and the one nearest the
 * prediction wins, rather than taking the first hit of an outward spiral.
 */
function searchAlignment(
	image: BitMatrix,
	cx: number,
	cy: number,
	radius: number,
	moduleSize: number,
): Point | null {
	let best: { point: Point; distance: number } | null = null;

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

			const horizontal = alignmentRunCentre(image, x, y, 1, 0, moduleSize);
			if (horizontal === null) {
				continue;
			}
			const vertical = alignmentRunCentre(image, x, y, 0, 1, moduleSize);
			if (vertical === null) {
				continue;
			}

			const point = { x: horizontal, y: vertical };
			const distance = Math.hypot(point.x - cx, point.y - cy);
			if (best === null || distance < best.distance) {
				best = { point, distance };
			}
		}
	}

	return best?.point ?? null;
}

/**
 * Centre of a light-dark-light run through a point, along one axis.
 *
 * Returns the centre coordinate, or null when the three runs are not all about
 * one module wide.
 */
function alignmentRunCentre(
	image: BitMatrix,
	x: number,
	y: number,
	dx: number,
	dy: number,
	moduleSize: number,
): number | null {
	// Walk out from the starting pixel, measuring the rest of the centre module
	// and the light ring beyond it. The outer dark ring is deliberately not
	// measured: it touches ordinary data modules more often than not, so its
	// run merges with them and its width says nothing.
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

			if (centre > moduleSize * 3 || light > moduleSize * 3) {
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

	// Three runs: light, dark centre, light. All should be one module wide.
	const runs = [back.light, back.centre + 1 + forward.centre, forward.light];
	const mean = (runs[0]! + runs[1]! + runs[2]!) / 3;

	// Compared to each other rather than to `moduleSize` directly, because a
	// scan across a rotated symbol stretches all three runs by the same factor.
	// An absolute test would reject the pattern on any photograph held at an
	// angle, which is most of them.
	for (const run of runs) {
		if (Math.abs(run - mean) > mean * 0.6) {
			return null;
		}
	}

	// The absolute size still has to be in the right neighbourhood, or a large
	// smudge would qualify. Generous enough to cover the axis stretch.
	if (mean < moduleSize * 0.5 || mean > moduleSize * 2.2) {
		return null;
	}

	// The centre module runs from x - back.centre to x + forward.centre, so its
	// midpoint is offset from the starting pixel by half the difference.
	const origin = dx !== 0 ? x : y;
	return origin + (forward.centre - back.centre) / 2;
}
