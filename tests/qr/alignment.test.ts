import { describe, expect, it } from 'vitest';
import { binariseHybrid } from '../../src/qr/decode/binarise.js';
import { toGrey } from '../../src/qr/decode/grey.js';
import { findAlignmentCandidates } from '../../src/qr/decode/sample.js';
import {
	buildSamplingTransform,
	quadrilateralToQuadrilateral,
} from '../../src/qr/decode/transform.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import { renderQrImageData } from '../../src/qr/encode/render.js';
import { ALIGNMENT_CENTRES } from '../../src/qr/tables.js';
import type { Point } from '../../src/types.js';
import { syntheticExport } from '../helpers/build-payload.js';
import { place } from '../helpers/image.js';

/**
 * Which bottom-right alignment pattern the search picks, and why.
 *
 * This is the fix for the failure the tool was actually shipping: a photograph
 * held at an angle, three finder patterns located precisely, and "too many
 * unreadable modules for error correction to repair" on a symbol whose modules
 * were perfectly legible. The fourth correspondence was landing on an ordinary
 * dark data module that happened to sit nearer a prediction which is known to be
 * wrong, and that drags the whole sampling grid off the symbol.
 *
 * Every scene here is built from a known homography, so the true position of the
 * pattern is arithmetic rather than a guess, and the tests can say "it found the
 * right one" instead of "it decoded, somehow".
 */

const QUIET = 4;

interface Scene {
	readonly candidates: ReturnType<typeof findAlignmentCandidates>;
	readonly trueAlignment: Point;
	readonly modulePx: number;
	readonly dimension: number;
	readonly version: number;
}

/**
 * Photograph a synthetic export and run the alignment search over it.
 *
 * The three finder centres are taken from the known homography rather than from
 * the finder scan, so the only thing under test is the alignment search: the
 * prediction it is handed is exactly the affine one the decoder would build from
 * perfect finders, which is off by several modules at the far corner and is the
 * whole reason the window has to be wide.
 */
function scene(accounts: number, tilt: { yaw?: number; pitch?: number; roll?: number }): Scene {
	const symbol = encodeQr(syntheticExport(accounts), { ecLevel: 'M' });
	const dimension = symbol.moduleCount;
	const scale = 8;
	const rendered = renderQrImageData(symbol, { scale, quietZone: QUIET });

	const placed = place(rendered, { ...tilt, fill: 0.8, background: 236 });
	const toScene = quadrilateralToQuadrilateral(
		[
			{ x: 0, y: 0 },
			{ x: rendered.width - 1, y: 0 },
			{ x: rendered.width - 1, y: rendered.height - 1 },
			{ x: 0, y: rendered.height - 1 },
		],
		placed.quad,
	);

	// Module `index` spans scale pixels, so its centre sits half a module in,
	// less half a pixel because coordinates here are pixel indices.
	const centreOf = (x: number, y: number): Point =>
		toScene.apply((QUIET + x) * scale + (scale - 1) / 2, (QUIET + y) * scale + (scale - 1) / 2);

	const topLeft = centreOf(3, 3);
	const topRight = centreOf(dimension - 4, 3);
	const bottomLeft = centreOf(3, dimension - 4);

	const centres = ALIGNMENT_CENTRES[symbol.version - 1] as readonly number[];
	const last = centres[centres.length - 1] as number;
	const trueAlignment = centreOf(last, last);

	const matrix = binariseHybrid(toGrey(placed.image));
	const initial = buildSamplingTransform(dimension, topLeft, topRight, bottomLeft, null, 0);

	return {
		candidates: findAlignmentCandidates(matrix, initial, symbol.version, dimension, { limit: 64 }),
		trueAlignment,
		modulePx: Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y) / (dimension - 7),
		dimension,
		version: symbol.version,
	};
}

function offBy(point: Point, truth: Point, modulePx: number): number {
	return Math.hypot(point.x - truth.x, point.y - truth.y) / modulePx;
}

describe('findAlignmentCandidates ranks by pattern quality', () => {
	// Two, five and ten accounts, which come out as versions 11, 18 and 27: the
	// range a real export covers, and the sizes where the prediction error at the
	// far corner grows from four modules to ten.
	it.each([
		[2, 25, 0],
		[2, 0, 25],
		[5, 25, 10],
		[10, 20, 10],
		[10, 0, 25],
	])(
		'puts the true pattern first for a %i-account export at yaw %i pitch %i',
		(accounts, yaw, pitch) => {
			const found = scene(accounts, { yaw, pitch });

			expect(found.candidates.length).toBeGreaterThan(0);
			expect(
				offBy(found.candidates[0]!.point, found.trueAlignment, found.modulePx),
				`version ${found.version}, ${found.candidates.length} candidates`,
			).toBeLessThan(0.6);
		},
	);

	it('finds it in a rotated scan, where every run is stretched', () => {
		// The run comparison is relative for exactly this reason: an absolute test
		// against the module size rejects the pattern on any photograph held at an
		// angle, which is most of them.
		const found = scene(5, { roll: 40 });

		expect(offBy(found.candidates[0]!.point, found.trueAlignment, found.modulePx)).toBeLessThan(
			0.6,
		);
	});

	it('prefers the pattern to data modules sitting nearer the prediction', () => {
		// The bug this fixes, stated as a measurement. The affine prediction is
		// several modules out at the far corner of a large symbol, the window has
		// to be wide enough to cover that, and inside a window that wide there are
		// dozens of isolated dark data modules closer to it than the pattern.
		const found = scene(10, { yaw: 20, pitch: 10 });
		const truth = found.candidates.findIndex(
			(candidate) => offBy(candidate.point, found.trueAlignment, found.modulePx) < 0.6,
		);

		expect(truth).toBe(0);

		const nearer = found.candidates.filter(
			(candidate) => candidate.offset < (found.candidates[truth] as { offset: number }).offset,
		);
		expect(nearer.length).toBeGreaterThan(0);

		// And the shipped ordering, distance from the prediction alone, would have
		// put the right answer outside the three hypotheses the decoder tries.
		const byDistance = [...found.candidates].sort((a, b) => a.offset - b.offset);
		const rankByDistance = byDistance.findIndex(
			(candidate) => offBy(candidate.point, found.trueAlignment, found.modulePx) < 0.6,
		);
		expect(rankByDistance).toBeGreaterThan(2);
	});

	it('scores the true pattern close to a perfect bullseye', () => {
		const found = scene(5, { yaw: 20, pitch: 10 });
		const best = found.candidates[0]!;

		// Zero is a flawless light-dark-light triple in all four directions. The
		// gap between this and the best false positive is what the ranking rests
		// on, so it is worth pinning that it is a gap and not a coin toss.
		expect(best.score).toBeLessThan(0.2);
		const others = found.candidates.filter(
			(candidate) => offBy(candidate.point, found.trueAlignment, found.modulePx) >= 0.6,
		);
		expect(Math.min(...others.map((candidate) => candidate.score))).toBeGreaterThan(best.score);
	});

	it('returns nothing for a version with no alignment pattern', () => {
		// Version 1 has none at all, and that is an ordinary outcome rather than a
		// failure: the caller extrapolates the fourth corner from the finders.
		const symbol = encodeQr('HELLO', { ecLevel: 'L' });
		expect(symbol.version).toBe(1);

		const rendered = renderQrImageData(symbol, { scale: 6, quietZone: QUIET });
		const matrix = binariseHybrid(toGrey(rendered));
		const size = symbol.moduleCount;
		const at = (x: number, y: number): Point => ({
			x: (QUIET + x) * 6 + 2.5,
			y: (QUIET + y) * 6 + 2.5,
		});
		const initial = buildSamplingTransform(
			size,
			at(3, 3),
			at(size - 4, 3),
			at(3, size - 4),
			null,
			0,
		);

		expect(findAlignmentCandidates(matrix, initial, 1, size)).toEqual([]);
	});
});
