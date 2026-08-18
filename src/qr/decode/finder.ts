import type { Point } from '../../types.js';
import type { BitMatrix } from '../bit-matrix.js';

/**
 * Locating the three finder patterns.
 *
 * A finder pattern is a 7 by 7 bullseye whose rows and columns through the
 * centre have dark:light:dark:light:dark runs in a 1:1:3:1:1 ratio. That ratio
 * is scale-invariant and rotation-invariant, which is exactly why the format
 * chose it, and it is the whole basis of finding a code in a photograph.
 */

export interface FinderPattern {
	readonly x: number;
	readonly y: number;
	/** Estimated width of one module, in pixels. */
	readonly moduleSize: number;
	/** How many independent scan lines agreed on this centre. */
	readonly count: number;
}

export interface FinderTriple {
	readonly topLeft: FinderPattern;
	readonly topRight: FinderPattern;
	readonly bottomLeft: FinderPattern;
}

/** Do five consecutive run lengths sit close enough to 1:1:3:1:1? */
function matchesRatio(runs: readonly number[]): boolean {
	const total = runs[0]! + runs[1]! + runs[2]! + runs[3]! + runs[4]!;
	if (total < 7) {
		return false;
	}

	const moduleSize = total / 7;
	// Half a module of slack per run. Tighter than this loses genuine patterns
	// on a slightly blurred photograph; looser starts matching text.
	const tolerance = moduleSize / 2;

	return (
		Math.abs(moduleSize - runs[0]!) < tolerance &&
		Math.abs(moduleSize - runs[1]!) < tolerance &&
		Math.abs(3 * moduleSize - runs[2]!) < 3 * tolerance &&
		Math.abs(moduleSize - runs[3]!) < tolerance &&
		Math.abs(moduleSize - runs[4]!) < tolerance
	);
}

/** Centre of the middle run, in the scan direction. */
function centreOfRuns(end: number, runs: readonly number[]): number {
	return end - runs[4]! - runs[3]! - runs[2]! / 2;
}

/**
 * Find candidate finder centres.
 *
 * Scans every row for the ratio, then cross-checks each hit vertically and
 * diagonally, then clusters agreeing hits. The `count` on each result is how
 * many rows agreed, which is a decent proxy for confidence.
 */
export function findFinderPatterns(matrix: BitMatrix, limit = 32): FinderPattern[] {
	const candidates: { x: number; y: number; moduleSize: number; count: number }[] = [];

	// Skipping rows costs nothing: a finder is at least seven modules tall, so
	// several rows cross it even on a small symbol.
	const step = Math.max(1, Math.floor(matrix.height / 512));

	for (let y = 0; y < matrix.height; y += step) {
		// The five runs are dark, light, dark, light, dark, so the even indices
		// are always the dark ones. `state` is the index currently being
		// counted, and its parity is what tells the machine whether a colour
		// change opens a new run or is simply more of the same.
		//
		// Written as an explicit state machine rather than a "did the colour
		// change" loop because the phase matters: run 0 has to be dark, and a
		// loop that starts counting at the first pixel of the row puts the
		// leading light margin there instead and never matches anything.
		const runs = [0, 0, 0, 0, 0];
		let state = 0;

		const consider = (end: number): boolean => {
			if (!matchesRatio(runs)) {
				return false;
			}
			const cx = centreOfRuns(end, runs);
			const moduleSize = (runs[0]! + runs[1]! + runs[2]! + runs[3]! + runs[4]!) / 7;
			const cy = verticalCentre(matrix, Math.round(cx), y, Math.round(moduleSize * 7));
			if (cy === null || !diagonalCheck(matrix, Math.round(cx), Math.round(cy))) {
				return false;
			}
			addCandidate(candidates, cx, cy, moduleSize);
			return true;
		};

		for (let x = 0; x < matrix.width; x += 1) {
			if (matrix.get(x, y)) {
				// Dark. An odd state means the previous run was light, so this
				// opens the next one.
				if (state % 2 === 1) {
					state += 1;
				}
				runs[state] += 1;
				continue;
			}

			// Light.
			if (state % 2 === 1) {
				runs[state] += 1;
				continue;
			}

			if (state !== 4) {
				state += 1;
				runs[state] += 1;
				continue;
			}

			// A complete dark-light-dark-light-dark sequence has just ended.
			if (consider(x)) {
				runs.fill(0);
				state = 0;
			} else {
				// Slide the window along by two runs, so two finders sharing a
				// row do not hide each other and a near miss can still become a
				// hit one run later.
				runs[0] = runs[2]!;
				runs[1] = runs[3]!;
				runs[2] = runs[4]!;
				runs[3] = 1;
				runs[4] = 0;
				state = 3;
			}
		}

		// A run still open when the row ended.
		if (state === 4) {
			consider(matrix.width);
		}
	}

	return candidates
		.filter((candidate) => candidate.count >= 2)
		.sort((a, b) => b.count - a.count)
		.slice(0, limit)
		.map(({ x, y, moduleSize, count }) => ({ x, y, moduleSize, count }));
}

/** Refine the vertical centre of a candidate by walking its runs. */
function verticalCentre(
	matrix: BitMatrix,
	cx: number,
	cy: number,
	maxCount: number,
): number | null {
	if (cx < 0 || cx >= matrix.width || !matrix.get(cx, cy)) {
		return null;
	}

	const runs = [0, 0, 0, 0, 0];
	let y = cy;
	while (y >= 0 && matrix.get(cx, y)) {
		runs[2] += 1;
		y -= 1;
	}
	while (y >= 0 && !matrix.get(cx, y) && runs[1] < maxCount) {
		runs[1] += 1;
		y -= 1;
	}
	while (y >= 0 && matrix.get(cx, y) && runs[0] < maxCount) {
		runs[0] += 1;
		y -= 1;
	}

	y = cy + 1;
	while (y < matrix.height && matrix.get(cx, y)) {
		runs[2] += 1;
		y += 1;
	}
	while (y < matrix.height && !matrix.get(cx, y) && runs[3] < maxCount) {
		runs[3] += 1;
		y += 1;
	}
	while (y < matrix.height && matrix.get(cx, y) && runs[4] < maxCount) {
		runs[4] += 1;
		y += 1;
	}

	if (!matchesRatio(runs)) {
		return null;
	}

	return centreOfRuns(y, runs);
}

/** A real bullseye also shows the ratio along both diagonals. */
function diagonalCheck(matrix: BitMatrix, cx: number, cy: number): boolean {
	for (const [dx, dy] of [
		[1, 1],
		[1, -1],
	] as const) {
		const runs = [0, 0, 0, 0, 0];

		let x = cx;
		let y = cy;
		while (x >= 0 && y >= 0 && x < matrix.width && y < matrix.height && matrix.get(x, y)) {
			runs[2] += 1;
			x -= dx;
			y -= dy;
		}
		while (x >= 0 && y >= 0 && x < matrix.width && y < matrix.height && !matrix.get(x, y)) {
			runs[1] += 1;
			x -= dx;
			y -= dy;
		}
		while (x >= 0 && y >= 0 && x < matrix.width && y < matrix.height && matrix.get(x, y)) {
			runs[0] += 1;
			x -= dx;
			y -= dy;
		}

		x = cx + dx;
		y = cy + dy;
		while (x >= 0 && y >= 0 && x < matrix.width && y < matrix.height && matrix.get(x, y)) {
			runs[2] += 1;
			x += dx;
			y += dy;
		}
		while (x >= 0 && y >= 0 && x < matrix.width && y < matrix.height && !matrix.get(x, y)) {
			runs[3] += 1;
			x += dx;
			y += dy;
		}
		while (x >= 0 && y >= 0 && x < matrix.width && y < matrix.height && matrix.get(x, y)) {
			runs[4] += 1;
			x += dx;
			y += dy;
		}

		if (!matchesRatio(runs)) {
			return false;
		}
	}

	return true;
}

function addCandidate(
	candidates: { x: number; y: number; moduleSize: number; count: number }[],
	x: number,
	y: number,
	moduleSize: number,
): void {
	for (const candidate of candidates) {
		const distance = Math.hypot(candidate.x - x, candidate.y - y);
		if (
			distance < candidate.moduleSize * 2 &&
			Math.abs(candidate.moduleSize - moduleSize) < moduleSize * 0.5
		) {
			// Running mean, so repeated sightings pull the centre to sub-pixel
			// accuracy rather than the first one winning.
			const total = candidate.count + 1;
			candidate.x = (candidate.x * candidate.count + x) / total;
			candidate.y = (candidate.y * candidate.count + y) / total;
			candidate.moduleSize = (candidate.moduleSize * candidate.count + moduleSize) / total;
			candidate.count = total;
			return;
		}
	}

	candidates.push({ x, y, moduleSize, count: 1 });
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Distance from `from` to the far edge of the black-white-black run heading
 * towards `to`, or null if the run does not complete.
 *
 * Starting at a finder centre, that run is the middle 1.5 modules of the core,
 * then 1 light, then 1 dark: three and a half modules.
 */
function runTowards(matrix: BitMatrix, from: Point, to: Point): number | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) {
		return null;
	}

	const stepX = dx / length;
	const stepY = dy / length;
	// 0: still in the centre core. 1: crossed into the light ring.
	// 2: crossed into the outer dark ring.
	let state = 0;

	for (let travelled = 0; travelled <= length; travelled += 0.5) {
		const x = Math.round(from.x + stepX * travelled);
		const y = Math.round(from.y + stepY * travelled);
		if (x < 0 || y < 0 || x >= matrix.width || y >= matrix.height) {
			return null;
		}

		const dark = matrix.get(x, y);
		if (state === 0 && !dark) {
			state = 1;
		} else if (state === 1 && dark) {
			state = 2;
		} else if (state === 2 && !dark) {
			return travelled;
		}
	}

	return null;
}

/**
 * Module size measured along the axis joining two finder centres.
 *
 * This exists because the row-scan estimate is not rotation-invariant. A
 * horizontal scan across a finder rotated by an angle measures every run
 * stretched by 1/cos of that angle, so at 33 degrees an 8-pixel module reads as
 * 9.5. That inflated figure then divides the finder-to-finder distance and the
 * symbol comes out several versions too small, which fails in a thoroughly
 * confusing way: the patterns were all found, and the decode still collapses.
 *
 * Measuring along the connecting axis removes the angle from the problem
 * entirely, because that axis is the one the module count is actually counted
 * along.
 */
export function moduleSizeAcross(matrix: BitMatrix, a: Point, b: Point): number | null {
	// Both ends of the axis, not just one. The estimate used to come from the
	// top-left finder alone, and on a keystone view the far finder is genuinely a
	// different size: on a 12 per cent keystone the two ends disagree by 3.7 per
	// cent, which is a whole version step of dimension error on a large symbol
	// and eats the tolerance `candidateDimensions` exists to provide.
	const here = moduleSizeBetween(matrix, a, b);
	const there = moduleSizeBetween(matrix, b, a);
	if (here === null) {
		return there;
	}
	return there === null ? here : (here + there) / 2;
}

export function moduleSizeBetween(matrix: BitMatrix, a: Point, b: Point): number | null {
	const forward = runTowards(matrix, a, b);
	if (forward === null) {
		return null;
	}

	// The same run in the opposite direction, so the estimate straddles the
	// whole seven-module width of the pattern rather than half of it.
	const opposite = { x: a.x - (b.x - a.x), y: a.y - (b.y - a.y) };
	const backward = runTowards(matrix, a, opposite);
	if (backward === null) {
		// One side ran out of image. Half the pattern is still an estimate.
		return forward / 3.5;
	}

	return (forward + backward) / 7;
}

/**
 * Assign three centres to corners.
 *
 * Purely geometric, which is what makes rotation free rather than a special
 * case: the corner not touching the longest side is the top-left, because the
 * three finders form a right-angled isosceles triangle and that corner is the
 * right angle. Which of the other two is the top-right then follows from the
 * sign of the cross product.
 *
 * Note what this cannot tell you. The cross product's sign only says which of
 * the two remaining centres was listed first, and swapping them flips it, so it
 * is not a mirror test. Mirroring is genuinely invisible to the finder
 * geometry: a reflected symbol has three finders in exactly the same L. It is
 * detected after sampling instead, where a mirrored symbol is simply the
 * transpose of a readable one.
 */
export function orderFinders(patterns: readonly FinderPattern[]): FinderTriple | null {
	if (patterns.length < 3) {
		return null;
	}

	const [a, b, c] = patterns as [FinderPattern, FinderPattern, FinderPattern];
	const ab = distance(a, b);
	const bc = distance(b, c);
	const ca = distance(c, a);

	// The corner not touching the longest side is the right angle.
	let corner: FinderPattern;
	let first: FinderPattern;
	let second: FinderPattern;
	if (bc >= ab && bc >= ca) {
		corner = a;
		first = b;
		second = c;
	} else if (ca >= ab && ca >= bc) {
		corner = b;
		first = a;
		second = c;
	} else {
		corner = c;
		first = a;
		second = b;
	}

	// Image coordinates have y growing downward, so for the ordering
	// (top-left, top-right, bottom-left) the cross product of the two edges
	// leaving the corner is positive. If it came out negative we simply picked
	// the two in the other order, so swap them.
	const cross =
		(first.x - corner.x) * (second.y - corner.y) - (first.y - corner.y) * (second.x - corner.x);
	const [topRight, bottomLeft] = cross > 0 ? [first, second] : [second, first];

	return { topLeft: corner, topRight, bottomLeft };
}

/**
 * Every ordered triple worth trying, best first.
 *
 * More than three candidates survive on a busy photograph, so rather than
 * guessing, the ladder tries the plausible combinations. Ranked by how close
 * their module sizes agree, since three parts of one symbol are all the same
 * size and three unrelated blobs generally are not.
 */
export function candidateTriples(patterns: readonly FinderPattern[], limit = 8): FinderTriple[] {
	const out: { triple: FinderTriple; score: number }[] = [];

	for (let i = 0; i < patterns.length; i += 1) {
		for (let j = i + 1; j < patterns.length; j += 1) {
			for (let k = j + 1; k < patterns.length; k += 1) {
				const trio = [patterns[i]!, patterns[j]!, patterns[k]!];
				const sizes = trio.map((p) => p.moduleSize);
				const mean = (sizes[0]! + sizes[1]! + sizes[2]!) / 3;
				const spread = Math.max(...sizes) - Math.min(...sizes);
				if (spread > mean * 0.7) {
					continue;
				}

				const triple = orderFinders(trio);
				if (triple === null) {
					continue;
				}

				// Prefer tight module-size agreement and strong sightings.
				const score = spread / mean - trio.reduce((sum, p) => sum + p.count, 0) / 100;
				out.push({ triple, score });
			}
		}
	}

	return out
		.sort((a, b) => a.score - b.score)
		.slice(0, limit)
		.map(({ triple }) => triple);
}
