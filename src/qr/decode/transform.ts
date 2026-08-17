import type { Point } from '../../types.js';

/**
 * The projective transform between symbol coordinates and image coordinates.
 *
 * A photograph of a screen is a projective view of a plane, not an affine one:
 * the far edge of the code is genuinely smaller than the near edge. An affine
 * fit gets the corners right and the middle wrong, which shows up as the
 * sampling grid drifting off the modules halfway across. Eight coefficients fix
 * that exactly, for any planar target.
 */
export class PerspectiveTransform {
	constructor(
		private readonly a11: number,
		private readonly a21: number,
		private readonly a31: number,
		private readonly a12: number,
		private readonly a22: number,
		private readonly a32: number,
		private readonly a13: number,
		private readonly a23: number,
		private readonly a33: number,
	) {}

	/** The eight independent coefficients, for crossing a worker boundary. */
	get coefficients(): readonly [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	] {
		return [
			this.a11,
			this.a21,
			this.a31,
			this.a12,
			this.a22,
			this.a32,
			this.a13,
			this.a23,
			this.a33,
		];
	}

	apply(x: number, y: number): Point {
		const denominator = this.a13 * x + this.a23 * y + this.a33;
		return {
			x: (this.a11 * x + this.a21 * y + this.a31) / denominator,
			y: (this.a12 * x + this.a22 * y + this.a32) / denominator,
		};
	}

	times(other: PerspectiveTransform): PerspectiveTransform {
		return new PerspectiveTransform(
			this.a11 * other.a11 + this.a21 * other.a12 + this.a31 * other.a13,
			this.a11 * other.a21 + this.a21 * other.a22 + this.a31 * other.a23,
			this.a11 * other.a31 + this.a21 * other.a32 + this.a31 * other.a33,
			this.a12 * other.a11 + this.a22 * other.a12 + this.a32 * other.a13,
			this.a12 * other.a21 + this.a22 * other.a22 + this.a32 * other.a23,
			this.a12 * other.a31 + this.a22 * other.a32 + this.a32 * other.a33,
			this.a13 * other.a11 + this.a23 * other.a12 + this.a33 * other.a13,
			this.a13 * other.a21 + this.a23 * other.a22 + this.a33 * other.a23,
			this.a13 * other.a31 + this.a23 * other.a32 + this.a33 * other.a33,
		);
	}

	buildAdjoint(): PerspectiveTransform {
		return new PerspectiveTransform(
			this.a22 * this.a33 - this.a23 * this.a32,
			this.a23 * this.a31 - this.a21 * this.a33,
			this.a21 * this.a32 - this.a22 * this.a31,
			this.a13 * this.a32 - this.a12 * this.a33,
			this.a11 * this.a33 - this.a13 * this.a31,
			this.a12 * this.a31 - this.a11 * this.a32,
			this.a12 * this.a23 - this.a13 * this.a22,
			this.a13 * this.a21 - this.a11 * this.a23,
			this.a11 * this.a22 - this.a12 * this.a21,
		);
	}
}

/**
 * The transform taking the unit square to an arbitrary quadrilateral.
 *
 * The standard construction: solve for the two projective terms from how much
 * the quadrilateral fails to be a parallelogram, then read off the rest.
 */
function squareToQuadrilateral(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
): PerspectiveTransform {
	const dx3 = x0 - x1 + x2 - x3;
	const dy3 = y0 - y1 + y2 - y3;

	if (dx3 === 0 && dy3 === 0) {
		// A parallelogram, so the projective terms vanish and this is affine.
		return new PerspectiveTransform(x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1);
	}

	const dx1 = x1 - x2;
	const dx2 = x3 - x2;
	const dy1 = y1 - y2;
	const dy2 = y3 - y2;
	const denominator = dx1 * dy2 - dx2 * dy1;
	const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
	const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;

	return new PerspectiveTransform(
		x1 - x0 + a13 * x1,
		x3 - x0 + a23 * x3,
		x0,
		y1 - y0 + a13 * y1,
		y3 - y0 + a23 * y3,
		y0,
		a13,
		a23,
		1,
	);
}

function quadrilateralToSquare(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
): PerspectiveTransform {
	return squareToQuadrilateral(x0, y0, x1, y1, x2, y2, x3, y3).buildAdjoint();
}

/** The transform between two arbitrary quadrilaterals, via the unit square. */
export function quadrilateralToQuadrilateral(
	source: readonly [Point, Point, Point, Point],
	destination: readonly [Point, Point, Point, Point],
): PerspectiveTransform {
	const toSquare = quadrilateralToSquare(
		source[0].x,
		source[0].y,
		source[1].x,
		source[1].y,
		source[2].x,
		source[2].y,
		source[3].x,
		source[3].y,
	);
	const fromSquare = squareToQuadrilateral(
		destination[0].x,
		destination[0].y,
		destination[1].x,
		destination[1].y,
		destination[2].x,
		destination[2].y,
		destination[3].x,
		destination[3].y,
	);

	return fromSquare.times(toSquare);
}

/**
 * Build the transform from symbol coordinates to image coordinates.
 *
 * Four correspondences when an alignment pattern was found, which makes the fit
 * exact for a planar target. Three when it was not (version 1 has none, and the
 * search can fail), in which case the fourth corner is extrapolated by treating
 * the view as a parallelogram. That is exact for an affine view and good enough
 * for mild perspective, which is all a version 1 symbol is small enough to
 * suffer.
 */
export function buildSamplingTransform(
	dimension: number,
	topLeft: Point,
	topRight: Point,
	bottomLeft: Point,
	alignment: Point | null,
	alignmentSource: number,
): PerspectiveTransform {
	// Symbol-space coordinates of the three finder centres: 3.5 modules in from
	// each edge, which is the centre of a 7 by 7 pattern.
	const edge = dimension - 3.5;
	const bottomRight: Point = alignment ?? {
		x: topRight.x + bottomLeft.x - topLeft.x,
		y: topRight.y + bottomLeft.y - topLeft.y,
	};
	// The fourth correspondence, in symbol coordinates. When an alignment
	// pattern was found this is its module centre; otherwise the extrapolated
	// corner sits where the two finder edges would meet.
	const bottomRightSource: Point = alignment
		? { x: alignmentSource, y: alignmentSource }
		: { x: edge, y: edge };

	return quadrilateralToQuadrilateral(
		[{ x: 3.5, y: 3.5 }, { x: edge, y: 3.5 }, bottomRightSource, { x: 3.5, y: edge }],
		[topLeft, topRight, bottomRight, bottomLeft],
	);
}
