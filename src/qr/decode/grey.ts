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
 * Reduce to an arbitrary size by averaging each destination pixel's exact
 * source footprint.
 *
 * The alternative, and what a single-step `drawImage` gives you, is a bilinear
 * tap: two source pixels per axis however far the reduction goes. Reducing 4032
 * pixels to 1600 that way samples 4 of every 25 source pixels and throws the
 * rest away, so module edges alias at whatever phase the grid happens to catch
 * them and the binariser inherits stripes that were never in the symbol.
 */
export function downscaleArea(image: GreyImage, width: number, height: number): GreyImage {
	if (width >= image.width && height >= image.height) {
		return image;
	}

	const out = new Uint8Array(width * height);
	const stepX = image.width / width;
	const stepY = image.height / height;

	for (let y = 0; y < height; y += 1) {
		const top = y * stepY;
		const bottom = Math.min(image.height, (y + 1) * stepY);
		const firstRow = Math.floor(top);
		const lastRow = Math.ceil(bottom);

		for (let x = 0; x < width; x += 1) {
			const left = x * stepX;
			const right = Math.min(image.width, (x + 1) * stepX);
			const firstColumn = Math.floor(left);
			const lastColumn = Math.ceil(right);

			let total = 0;
			let weight = 0;
			for (let sy = firstRow; sy < lastRow; sy += 1) {
				// Partial rows and columns carry their overlap as a weight, which
				// is what keeps the result free of the periodic bias a rounded
				// footprint would leave at a non-integer ratio.
				const wy = Math.min(sy + 1, bottom) - Math.max(sy, top);
				if (wy <= 0) {
					continue;
				}
				const row = sy * image.width;
				for (let sx = firstColumn; sx < lastColumn; sx += 1) {
					const wx = Math.min(sx + 1, right) - Math.max(sx, left);
					if (wx <= 0) {
						continue;
					}
					total += (image.data[row + sx] as number) * wx * wy;
					weight += wx * wy;
				}
			}

			out[y * width + x] = weight > 0 ? Math.round(total / weight) : 0;
		}
	}

	return { data: out, width, height };
}

/**
 * Enlarge by an integer factor, interpolating.
 *
 * Nearest neighbour is the tempting choice, on the grounds that interpolation
 * invents intermediate greys along every module edge. That reasoning holds for a
 * crisp source and is wrong at the resolution this rung exists for: at three
 * pixels per module the greys are not invented, they are real data about where
 * the module edge sits, and replicating pixels throws that away. Measured at 2.5
 * pixels per module under the harsh profile, nearest scores the same as no
 * upscale at all and this scores 100%.
 */
export function upscaleSmooth(image: GreyImage, factor: number): GreyImage {
	const width = image.width * factor;
	const height = image.height * factor;
	const out = new Uint8Array(width * height);

	for (let y = 0; y < height; y += 1) {
		// Pixel centres, so the interpolation is not half a pixel out.
		const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
		const y0 = Math.floor(sourceY);
		const y1 = Math.min(image.height - 1, y0 + 1);
		const fy = sourceY - y0;

		for (let x = 0; x < width; x += 1) {
			const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
			const x0 = Math.floor(sourceX);
			const x1 = Math.min(image.width - 1, x0 + 1);
			const fx = sourceX - x0;

			const a = image.data[y0 * image.width + x0] as number;
			const b = image.data[y0 * image.width + x1] as number;
			const c = image.data[y1 * image.width + x0] as number;
			const d = image.data[y1 * image.width + x1] as number;

			out[y * width + x] = Math.round(
				a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy,
			);
		}
	}

	return { data: out, width, height };
}

/**
 * Enlarge by an integer factor with nearest-neighbour sampling.
 *
 * Kept for a caller that wants the modules left exactly as they are. The decode
 * ladder uses `upscaleSmooth` instead; see the note there.
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

/**
 * Scale the long edge down to at most `maxEdge`, landing on it.
 *
 * This used to halve repeatedly, which undershoots any cap by up to a factor of
 * two: a 1600-pixel image asked to fit 1400 came back at 800, and one extra
 * pixel of input halved the working resolution. That discontinuity was the
 * single largest resolution loss in the pipeline, because every still over the
 * cap decoded at half the resolution it had asked for.
 *
 * Whole halvings first, while the next one would still clear the cap, then one
 * area pass for the remainder. Halving is the ratio at which a box filter and a
 * bilinear tap agree exactly, so the cheap step is also the accurate one.
 */
export function fitWithin(image: GreyImage, maxEdge: number): GreyImage {
	const longest = Math.max(image.width, image.height);
	if (longest <= maxEdge) {
		return image;
	}

	const scale = maxEdge / longest;
	return resampleDown(
		image,
		Math.max(1, Math.round(image.width * scale)),
		Math.max(1, Math.round(image.height * scale)),
	);
}

/** Reduce to at most `maxPixels`, keeping the aspect ratio. */
export function fitPixels(image: GreyImage, maxPixels: number): GreyImage {
	const pixels = image.width * image.height;
	if (pixels <= maxPixels) {
		return image;
	}

	// Floored rather than rounded, so the result is never a pixel over the cap.
	const scale = Math.sqrt(maxPixels / pixels);
	return resampleDown(
		image,
		Math.max(1, Math.floor(image.width * scale)),
		Math.max(1, Math.floor(image.height * scale)),
	);
}

export interface WorkLimits {
	/** Preferred: every stage is linear in area, nothing is linear in long edge. */
	readonly maxPixels?: number;
	/** Fallback for a caller that genuinely knows its input. Discouraged. */
	readonly maxEdge?: number;
}

/** Reduce to the working size, by area when the caller allows it. */
export function fitToWork(image: GreyImage, limits: WorkLimits): GreyImage {
	if (limits.maxPixels !== undefined) {
		return fitPixels(image, limits.maxPixels);
	}
	if (limits.maxEdge !== undefined) {
		return fitWithin(image, limits.maxEdge);
	}
	return image;
}

function resampleDown(image: GreyImage, width: number, height: number): GreyImage {
	let current = image;
	// Halve while a halving would still overshoot the target, then finish with one
	// area resample. Named rather than inlined because `a >> 1 >= b` is correct (a
	// shift binds tighter than a comparison) and reads as though it might not be.
	for (;;) {
		const halfWidth = current.width >> 1;
		const halfHeight = current.height >> 1;
		if (halfWidth < width || halfHeight < height) {
			break;
		}
		current = downscaleHalf(current);
	}
	return current.width === width && current.height === height
		? current
		: downscaleArea(current, width, height);
}

/**
 * Whether the image looks like light-on-dark.
 *
 * Sampled from the corners rather than the whole frame, because a QR code is
 * supposed to sit inside a light quiet zone, and the corners are the part of
 * the picture least likely to be the code itself. Used only to decide which
 * polarity the decode ladder tries first; both are tried either way.
 *
 * The comparison is against the picture's own light and dark levels rather than
 * a fixed brightness, which is what makes a dim capture come out right: a photo
 * taken in poor light has every level scaled down, so a light surround at 63
 * used to read as dark and flipped the guess for the whole ladder.
 *
 * One case this cannot get right, and no global rule can: a correctly polarised
 * code held over a genuinely dark surface. The corners then are dark and the
 * quiet zone around the symbol is light, and telling those apart needs the
 * symbol located first. The cost is one rung, which is why this stays a cheap
 * guess rather than becoming a stage.
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

	// The fifth and ninety-fifth percentiles stand in for "dark" and "light" in
	// this picture. A third of the way up from dark, rather than halfway, because
	// a mid-grey surround is common and is not an inverted symbol.
	const histogram = new Uint32Array(256);
	for (let i = 0; i < data.length; i += 1) {
		histogram[data[i] as number] += 1;
	}
	const dark = percentile(histogram, data.length, 0.05);
	const light = percentile(histogram, data.length, 0.95);

	return median < dark + (light - dark) * 0.35;
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
	const target = total * fraction;
	let seen = 0;
	for (let value = 0; value < histogram.length; value += 1) {
		seen += histogram[value] as number;
		if (seen >= target) {
			return value;
		}
	}
	return histogram.length - 1;
}
