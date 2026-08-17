import { quadrilateralToQuadrilateral } from '../../src/qr/decode/transform.js';
import type { ImageDataLike } from '../../src/types.js';

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

/** Paste onto a larger light canvas, as a screenshot of a whole screen would. */
export function pad(image: ImageDataLike, margin: number): ImageDataLike {
	const out = blank(image.width + margin * 2, image.height + margin * 2);
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			setGrey(out, x + margin, y + margin, sample(image, x, y));
		}
	}
	return out;
}
