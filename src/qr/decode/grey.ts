import type { ImageDataLike } from '../../types.js';

/** A single-channel image. One byte per pixel, 0 dark to 255 light. */
export interface GreyImage {
	readonly data: Uint8Array;
	readonly width: number;
	readonly height: number;
}

/**
 * RGBA to luma, ITU-R BT.601 weights in fixed point.
 *
 * Integer arithmetic rather than floating point because this runs over every
 * pixel of a camera frame thirty times a second, and the difference between the
 * two is invisible after binarisation anyway.
 */
export function toGrey(image: ImageDataLike): GreyImage {
	const { data, width, height } = image;
	const out = new Uint8Array(width * height);

	for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
		const r = data[p] as number;
		const g = data[p + 1] as number;
		const b = data[p + 2] as number;
		// 0.299, 0.587, 0.114 scaled by 1024.
		out[i] = (r * 306 + g * 601 + b * 117) >> 10;
	}

	return { data: out, width, height };
}

/**
 * Halve the resolution with a 2x2 box filter.
 *
 * Two jobs at once: it brings a 4000-pixel phone photo into the range the
 * finder scan is tuned for, and the averaging suppresses sensor noise, which is
 * usually what defeats binarisation on a dim capture.
 */
export function downscaleHalf(image: GreyImage): GreyImage {
	const width = Math.max(1, image.width >> 1);
	const height = Math.max(1, image.height >> 1);
	const out = new Uint8Array(width * height);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const sx = x * 2;
			const sy = y * 2;
			const a = image.data[sy * image.width + sx] as number;
			const b = image.data[sy * image.width + Math.min(sx + 1, image.width - 1)] as number;
			const c = image.data[Math.min(sy + 1, image.height - 1) * image.width + sx] as number;
			const d = image.data[
				Math.min(sy + 1, image.height - 1) * image.width + Math.min(sx + 1, image.width - 1)
			] as number;
			out[y * width + x] = (a + b + c + d) >> 2;
		}
	}

	return { data: out, width, height };
}

/**
 * Enlarge by an integer factor with nearest-neighbour sampling.
 *
 * Nearest rather than bilinear on purpose. Interpolation invents intermediate
 * greys along every module edge, and the binariser then has to guess which side
 * they belong to. Nearest keeps the two populations separate, which is the only
 * thing that matters here.
 */
export function upscaleNearest(image: GreyImage, factor: number): GreyImage {
	const width = image.width * factor;
	const height = image.height * factor;
	const out = new Uint8Array(width * height);

	for (let y = 0; y < height; y += 1) {
		const sy = Math.floor(y / factor);
		for (let x = 0; x < width; x += 1) {
			out[y * width + x] = image.data[sy * image.width + Math.floor(x / factor)] as number;
		}
	}

	return { data: out, width, height };
}

/** Scale the long edge down to at most `maxEdge`, by whole halvings. */
export function fitWithin(image: GreyImage, maxEdge: number): GreyImage {
	let current = image;
	while (
		Math.max(current.width, current.height) > maxEdge &&
		current.width > 32 &&
		current.height > 32
	) {
		current = downscaleHalf(current);
	}
	return current;
}

/**
 * Whether the image looks like light-on-dark.
 *
 * Sampled from the corners rather than the whole frame, because a QR code is
 * supposed to sit inside a light quiet zone, and the corners are the part of
 * the picture least likely to be the code itself. Used only to decide which
 * polarity the decode ladder tries first; both are tried either way.
 */
export function looksInverted(image: GreyImage): boolean {
	const { data, width, height } = image;
	const patch = Math.max(2, Math.min(width, height) >> 4);
	const samples: number[] = [];

	for (const [ox, oy] of [
		[0, 0],
		[width - patch, 0],
		[0, height - patch],
		[width - patch, height - patch],
	] as const) {
		let total = 0;
		let count = 0;
		for (let y = oy; y < oy + patch; y += 1) {
			for (let x = ox; x < ox + patch; x += 1) {
				total += data[y * width + x] as number;
				count += 1;
			}
		}
		samples.push(total / count);
	}

	samples.sort((a, b) => a - b);
	const median = (samples[1]! + samples[2]!) / 2;
	return median < 96;
}
