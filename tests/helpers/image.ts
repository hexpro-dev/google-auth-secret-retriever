import { quadrilateralToQuadrilateral } from '../../src/qr/decode/transform.js';
import type { ImageDataLike, Point } from '../../src/types.js';

/**
 * Image degradations, so the decoder is tested against something closer to what
 * people actually upload than a clean render.
 *
 * Everything here is deterministic. A decoder test that fails one run in fifty
 * because of an unseeded random is worse than no test, because the next person
 * reruns it and moves on.
 */

export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function blank(width: number, height: number, fill = 255): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	data.fill(fill);
	for (let i = 3; i < data.length; i += 4) {
		data[i] = 255;
	}
	return { data, width, height };
}

function sample(image: ImageDataLike, x: number, y: number): number {
	const cx = Math.min(image.width - 1, Math.max(0, Math.round(x)));
	const cy = Math.min(image.height - 1, Math.max(0, Math.round(y)));
	return image.data[(cy * image.width + cx) * 4] as number;
}

function setGrey(image: ImageDataLike, x: number, y: number, value: number): void {
	const offset = (y * image.width + x) * 4;
	image.data[offset] = value;
	image.data[offset + 1] = value;
	image.data[offset + 2] = value;
	image.data[offset + 3] = 255;
}

/** Rotate by a multiple of 90 degrees. */
export function rotateQuarter(image: ImageDataLike, turns: number): ImageDataLike {
	let current = image;
	for (let i = 0; i < ((turns % 4) + 4) % 4; i += 1) {
		const out = blank(current.height, current.width);
		for (let y = 0; y < current.height; y += 1) {
			for (let x = 0; x < current.width; x += 1) {
				// (x, y) goes to (height - 1 - y, x).
				setGrey(out, current.height - 1 - y, x, sample(current, x, y));
			}
		}
		current = out;
	}
	return current;
}

/** Rotate by an arbitrary angle about the centre, on a light background. */
export function rotate(image: ImageDataLike, degrees: number): ImageDataLike {
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const size = Math.ceil(Math.hypot(image.width, image.height));
	const out = blank(size, size);

	const cx = image.width / 2;
	const cy = image.height / 2;
	const ox = size / 2;
	const oy = size / 2;

	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			// Inverse map, so every destination pixel gets a source.
			const dx = x - ox;
			const dy = y - oy;
			const sx = cos * dx + sin * dy + cx;
			const sy = -sin * dx + cos * dy + cy;
			if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
				continue;
			}
			setGrey(out, x, y, sample(image, sx, sy));
		}
	}

	return out;
}

/** Mirror horizontally, as a photo of a reflection or a front camera would. */
export function mirror(image: ImageDataLike): ImageDataLike {
	const out = blank(image.width, image.height);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			setGrey(out, image.width - 1 - x, y, sample(image, x, y));
		}
	}
	return out;
}

/** Swap dark and light, as a dark-mode screenshot does. */
export function invert(image: ImageDataLike): ImageDataLike {
	const out = blank(image.width, image.height);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			setGrey(out, x, y, 255 - sample(image, x, y));
		}
	}
	return out;
}

/**
 * A genuine projective warp, standing in for a photograph taken off-axis.
 *
 * Worth being fussy about. The obvious shortcut is to taper each row
 * horizontally by an amount depending on its height, which looks like a
 * keystone and is not one: a real perspective view foreshortens *both* axes, so
 * rows bunch up towards the far edge as well as narrowing. The shortcut version
 * is not a projective map of a plane at all, which means no eight-coefficient
 * transform can invert it and a decoder that handles real photographs perfectly
 * well still fails on it.
 *
 * So this builds the real homography, taking the destination trapezoid back to
 * the source rectangle. `strength` is how much the far edge narrows, as a
 * fraction of the width.
 */
export function perspective(image: ImageDataLike, strength: number): ImageDataLike {
	const w = image.width;
	const h = image.height;
	const out = blank(w, h);
	const inset = (w * strength) / 2;

	// The quadrilateral the image is painted into, and the rectangle it came
	// from, corner for corner: top-left, top-right, bottom-right, bottom-left.
	const transform = quadrilateralToQuadrilateral(
		[
			{ x: 0, y: 0 },
			{ x: w, y: 0 },
			{ x: w - inset, y: h },
			{ x: inset, y: h },
		],
		[
			{ x: 0, y: 0 },
			{ x: w, y: 0 },
			{ x: w, y: h },
			{ x: 0, y: h },
		],
	);

	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) {
			const source = transform.apply(x, y);
			if (source.x < 0 || source.y < 0 || source.x >= w || source.y >= h) {
				continue;
			}
			setGrey(out, x, y, sample(image, source.x, source.y));
		}
	}

	return out;
}

/** A separable box blur, standing in for being slightly out of focus. */
export function blur(image: ImageDataLike, radius: number): ImageDataLike {
	const pass = (source: ImageDataLike, horizontal: boolean): ImageDataLike => {
		const out = blank(source.width, source.height);
		for (let y = 0; y < source.height; y += 1) {
			for (let x = 0; x < source.width; x += 1) {
				let total = 0;
				let count = 0;
				for (let d = -radius; d <= radius; d += 1) {
					const nx = horizontal ? x + d : x;
					const ny = horizontal ? y : y + d;
					if (nx < 0 || ny < 0 || nx >= source.width || ny >= source.height) {
						continue;
					}
					total += sample(source, nx, ny);
					count += 1;
				}
				setGrey(out, x, y, Math.round(total / count));
			}
		}
		return out;
	};

	return pass(pass(image, true), false);
}

/** Additive noise from a seeded generator. */
export function noise(image: ImageDataLike, amount: number, seed = 1): ImageDataLike {
	const random = seededRandom(seed);
	const out = blank(image.width, image.height);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			const value = sample(image, x, y) + (random() * 2 - 1) * amount;
			setGrey(out, x, y, Math.min(255, Math.max(0, Math.round(value))));
		}
	}
	return out;
}

/** A soft bright ellipse, standing in for a reflection on a screen. */
export function glare(image: ImageDataLike, strength = 160): ImageDataLike {
	const out = blank(image.width, image.height);
	const cx = image.width * 0.35;
	const cy = image.height * 0.3;
	const rx = image.width * 0.3;
	const ry = image.height * 0.22;

	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
			const boost = d < 1 ? strength * (1 - d) ** 2 : 0;
			setGrey(out, x, y, Math.min(255, Math.round(sample(image, x, y) + boost)));
		}
	}

	return out;
}

/** A linear brightness ramp, which a single global threshold cannot handle. */
export function gradient(image: ImageDataLike, amount = 90): ImageDataLike {
	const out = blank(image.width, image.height);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			const shift = ((x / image.width + y / image.height) / 2 - 0.5) * amount;
			setGrey(out, x, y, Math.min(255, Math.max(0, Math.round(sample(image, x, y) + shift))));
		}
	}
	return out;
}

/** Bilinear sample, so a warp does not alias its own module grid away. */
function sampleSmooth(image: ImageDataLike, x: number, y: number): number {
	const cx = Math.min(image.width - 1, Math.max(0, x));
	const cy = Math.min(image.height - 1, Math.max(0, y));
	const x0 = Math.floor(cx);
	const y0 = Math.floor(cy);
	const x1 = Math.min(image.width - 1, x0 + 1);
	const y1 = Math.min(image.height - 1, y0 + 1);
	const fx = cx - x0;
	const fy = cy - y0;

	const at = (px: number, py: number) => image.data[(py * image.width + px) * 4] as number;
	return (
		at(x0, y0) * (1 - fx) * (1 - fy) +
		at(x1, y0) * fx * (1 - fy) +
		at(x0, y1) * (1 - fx) * fy +
		at(x1, y1) * fx * fy
	);
}

export interface Placement {
	readonly image: ImageDataLike;
	/**
	 * Where the source image's own corners landed, clockwise from the top-left.
	 *
	 * Returned so a test can compute the true position of any module through the
	 * same homography the scene was built with, which is the only way to check
	 * that the decoder found the right pattern rather than a lucky one.
	 */
	readonly quad: readonly [Point, Point, Point, Point];
}

export interface PlaceOptions {
	/** Rotation about the vertical axis, in degrees. */
	readonly yaw?: number;
	/** Rotation about the horizontal axis, in degrees. */
	readonly pitch?: number;
	/** Rotation in the image plane, in degrees. */
	readonly roll?: number;
	/** Fraction of the shorter canvas edge the placement spans. */
	readonly fill?: number;
	readonly width?: number;
	readonly height?: number;
	readonly background?: number;
	/**
	 * Camera distance, in half-widths of the subject.
	 *
	 * Eight by default, which is a 7 cm phone screen photographed from 30 cm.
	 * Lower numbers are a wider lens held closer, and the projective distortion
	 * grows quickly: at three, the far corner of a version 27 symbol lands
	 * twenty-five modules from where an affine fit predicts.
	 */
	readonly distance?: number;
}

/**
 * Photograph a flat image from an angle.
 *
 * A real pinhole projection of a plane, not a keystone. The distinction matters:
 * tapering each row horizontally by an amount that depends on its height looks
 * like perspective and is not a projective map of a plane at all, so no
 * eight-coefficient transform can invert it and a decoder that handles genuine
 * photographs perfectly well fails on it.
 */
export function place(image: ImageDataLike, options: PlaceOptions = {}): Placement {
	const width = options.width ?? Math.round(Math.max(image.width, image.height) * 1.6);
	const height = options.height ?? width;
	const fill = options.fill ?? 0.7;
	const yaw = ((options.yaw ?? 0) * Math.PI) / 180;
	const pitch = ((options.pitch ?? 0) * Math.PI) / 180;
	const roll = ((options.roll ?? 0) * Math.PI) / 180;

	// The source rectangle in plane coordinates, longest edge spanning 2.
	const longest = Math.max(image.width, image.height);
	const halfX = image.width / longest;
	const halfY = image.height / longest;
	const corners: ReadonlyArray<readonly [number, number]> = [
		[-halfX, -halfY],
		[halfX, -halfY],
		[halfX, halfY],
		[-halfX, halfY],
	];

	const distance = options.distance ?? 8;
	const projected = corners.map(([x0, y0]) => {
		const rx = x0 * Math.cos(roll) - y0 * Math.sin(roll);
		const ry = x0 * Math.sin(roll) + y0 * Math.cos(roll);
		// Yaw about the vertical axis, then pitch about the horizontal one.
		const x1 = rx * Math.cos(yaw);
		const z1 = -rx * Math.sin(yaw);
		const y2 = ry * Math.cos(pitch) - z1 * Math.sin(pitch);
		const z2 = ry * Math.sin(pitch) + z1 * Math.cos(pitch);
		const depth = distance + z2;
		return { x: x1 / depth, y: y2 / depth };
	});

	const minX = Math.min(...projected.map((p) => p.x));
	const maxX = Math.max(...projected.map((p) => p.x));
	const minY = Math.min(...projected.map((p) => p.y));
	const maxY = Math.max(...projected.map((p) => p.y));
	const scale = (Math.min(width, height) * fill) / Math.max(maxX - minX, maxY - minY);

	const onCanvas = (p: { x: number; y: number }): Point => ({
		x: width / 2 + (p.x - (minX + maxX) / 2) * scale,
		y: height / 2 + (p.y - (minY + maxY) / 2) * scale,
	});
	const quad: readonly [Point, Point, Point, Point] = [
		onCanvas(projected[0] as { x: number; y: number }),
		onCanvas(projected[1] as { x: number; y: number }),
		onCanvas(projected[2] as { x: number; y: number }),
		onCanvas(projected[3] as { x: number; y: number }),
	];

	return { image: warpInto(image, quad, width, height, options.background ?? 255), quad };
}

/** Paint an image into an arbitrary quadrilateral on a flat canvas. */
export function warpInto(
	image: ImageDataLike,
	quad: readonly [Point, Point, Point, Point],
	width: number,
	height: number,
	background = 255,
): ImageDataLike {
	const out = blank(width, height, background);
	const toSource = quadrilateralToQuadrilateral(quad, [
		{ x: 0, y: 0 },
		{ x: image.width - 1, y: 0 },
		{ x: image.width - 1, y: image.height - 1 },
		{ x: 0, y: image.height - 1 },
	]);

	const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x))));
	const maxX = Math.min(width - 1, Math.ceil(Math.max(...quad.map((p) => p.x))));
	const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))));
	const maxY = Math.min(height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))));

	for (let y = minY; y <= maxY; y += 1) {
		for (let x = minX; x <= maxX; x += 1) {
			const source = toSource.apply(x, y);
			if (
				source.x < -0.5 ||
				source.y < -0.5 ||
				source.x > image.width - 0.5 ||
				source.y > image.height - 0.5
			) {
				continue;
			}
			setGrey(out, x, y, Math.round(sampleSmooth(image, source.x, source.y)));
		}
	}

	return out;
}

/**
 * Reduce by a fractional factor, averaging the whole footprint.
 *
 * For building a symbol at a non-integer number of pixels per module, which is
 * what a screenshot scaled by a browser or a photograph at arm's length gives
 * you, and where the sampling floor actually sits.
 */
export function shrink(image: ImageDataLike, factor: number): ImageDataLike {
	const width = Math.max(1, Math.floor(image.width / factor));
	const height = Math.max(1, Math.floor(image.height / factor));
	const out = blank(width, height);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let total = 0;
			let count = 0;
			for (
				let sy = Math.floor(y * factor);
				sy < Math.min(image.height, (y + 1) * factor);
				sy += 1
			) {
				for (
					let sx = Math.floor(x * factor);
					sx < Math.min(image.width, (x + 1) * factor);
					sx += 1
				) {
					total += sample(image, sx, sy);
					count += 1;
				}
			}
			setGrey(out, x, y, Math.round(total / Math.max(1, count)));
		}
	}

	return out;
}

/** Scale every level down, as a photograph taken in poor light does. */
export function dim(image: ImageDataLike, gain: number, lift = 0): ImageDataLike {
	const out = blank(image.width, image.height);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			setGrey(out, x, y, Math.min(255, Math.round(sample(image, x, y) * gain + lift)));
		}
	}
	return out;
}

/** Paste onto a larger canvas, as a screenshot of a whole screen would. */
export function pad(image: ImageDataLike, margin: number, background = 255): ImageDataLike {
	const out = blank(image.width + margin * 2, image.height + margin * 2, background);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			setGrey(out, x + margin, y + margin, sample(image, x, y));
		}
	}
	return out;
}
