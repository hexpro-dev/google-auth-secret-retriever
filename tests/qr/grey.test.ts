import { describe, expect, it } from 'vitest';
import {
	type GreyImage,
	downscaleArea,
	fitPixels,
	fitToWork,
	fitWithin,
	looksInverted,
	upscaleSmooth,
} from '../../src/qr/decode/grey.js';

/**
 * The resolution policy.
 *
 * Every one of these is a bug that shipped. `fitWithin` only ever halved, so it
 * undershot its own cap by up to a factor of two and one extra pixel of input
 * could halve the working resolution; the site then asked for 1400 on an image
 * the adapter had already capped at 1600, and every photograph over 1400 pixels
 * decoded at 800. The polarity guess compared brightness against a fixed number,
 * so a picture taken in poor light, where every level is scaled down, read as a
 * dark-mode screenshot and spent the whole ladder on the wrong polarity.
 */

function grey(width: number, height: number, fill: (x: number, y: number) => number): GreyImage {
	const data = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			data[y * width + x] = fill(x, y);
		}
	}
	return { data, width, height };
}

function flat(width: number, height: number, value: number): GreyImage {
	return grey(width, height, () => value);
}

function at(image: GreyImage, x: number, y: number): number {
	return image.data[y * image.width + x] as number;
}

describe('fitWithin', () => {
	it.each([
		[1400, 1400],
		[1401, 1400],
		[1601, 1400],
		[4032, 1400],
		[721, 720],
		[3000, 720],
	])('reduces a %i-pixel long edge to its cap, not past it', (from, cap) => {
		const fitted = fitWithin(flat(from, Math.round(from * 0.75), 128), cap);

		expect(Math.max(fitted.width, fitted.height)).toBe(Math.min(from, cap));
	});

	it('leaves an image already inside the cap exactly as it is', () => {
		const image = flat(800, 600, 200);
		expect(fitWithin(image, 1600)).toBe(image);
	});

	it('is monotonic in input size', () => {
		// The shipped version failed this at every power-of-two boundary: 1400
		// came back at 1400 and 1401 came back at 700, so a larger photograph gave
		// a smaller working image.
		let previous = 0;
		for (let long = 1000; long <= 3200; long += 97) {
			const fitted = fitWithin(flat(long, Math.round(long * 0.6), 90), 1400);
			const pixels = fitted.width * fitted.height;
			expect(pixels, `long edge ${long}`).toBeGreaterThanOrEqual(previous - 1);
			previous = pixels;
		}
	});

	it('keeps the aspect ratio', () => {
		const fitted = fitWithin(flat(4000, 3000, 128), 1600);
		expect(fitted.width / fitted.height).toBeCloseTo(4 / 3, 2);
	});
});

describe('fitPixels and fitToWork', () => {
	it('caps by area rather than by long edge', () => {
		// The point of the area cap: a panorama and a photograph with the same long
		// edge are not the same amount of work, and every stage is linear in area.
		const panorama = fitPixels(flat(4032, 1000, 128), 1_000_000);
		const photo = fitPixels(flat(4032, 3024, 128), 1_000_000);

		expect(panorama.width * panorama.height).toBeLessThanOrEqual(1_000_000);
		expect(photo.width * photo.height).toBeLessThanOrEqual(1_000_000);
		expect(panorama.width).toBeGreaterThan(photo.width);
	});

	it('never enlarges', () => {
		const image = flat(400, 300, 128);
		expect(fitPixels(image, 4_000_000)).toBe(image);
	});

	it('prefers the area limit when both are given', () => {
		const fitted = fitToWork(flat(4000, 3000, 128), { maxPixels: 1_000_000, maxEdge: 200 });
		expect(fitted.width * fitted.height).toBeGreaterThan(900_000);
	});

	it('falls back to the long edge, and to nothing at all', () => {
		expect(Math.max(...sizeOf(fitToWork(flat(4000, 3000, 128), { maxEdge: 1000 })))).toBe(1000);
		const image = flat(4000, 3000, 128);
		expect(fitToWork(image, {})).toBe(image);
	});
});

function sizeOf(image: GreyImage): [number, number] {
	return [image.width, image.height];
}

describe('downscaleArea', () => {
	it('leaves a constant field constant', () => {
		const reduced = downscaleArea(flat(100, 100, 173), 37, 37);

		expect(reduced.width).toBe(37);
		for (let i = 0; i < reduced.data.length; i += 1) {
			expect(reduced.data[i]).toBe(173);
		}
	});

	it('averages the whole footprint of each destination pixel', () => {
		// A bilinear tap would sample two source pixels per axis whatever the
		// ratio, so a 4x reduction of a ramp would return source values rather
		// than averages of them, and detail finer than the new pitch would alias.
		const ramp = grey(8, 1, (x) => x * 20);
		const reduced = downscaleArea(ramp, 2, 1);

		expect(at(reduced, 0, 0)).toBe((0 + 20 + 40 + 60) / 4);
		expect(at(reduced, 1, 0)).toBe((80 + 100 + 120 + 140) / 4);
	});

	it('handles a non-integer ratio by weighting partial pixels', () => {
		const ramp = grey(3, 1, (x) => x * 30);
		const reduced = downscaleArea(ramp, 2, 1);

		// Destination 0 covers source [0, 1.5): one whole pixel and half of the
		// next, so 0 and 30 weighted 1 to 0.5.
		expect(at(reduced, 0, 0)).toBe(Math.round((0 * 1 + 30 * 0.5) / 1.5));
		expect(at(reduced, 1, 0)).toBe(Math.round((30 * 0.5 + 60 * 1) / 1.5));
	});

	it('never enlarges', () => {
		const image = flat(10, 10, 5);
		expect(downscaleArea(image, 20, 20)).toBe(image);
	});

	it('does not lose the last row of an odd-sized image', () => {
		const image = grey(9, 9, (_x, y) => (y === 8 ? 255 : 0));
		const reduced = downscaleArea(image, 3, 3);

		// The bottom third of the source is rows 6, 7 and 8, one of which is
		// white, so the bottom row of the result must not be black.
		expect(at(reduced, 0, 2)).toBeGreaterThan(0);
	});
});

describe('upscaleSmooth', () => {
	it('interpolates rather than replicating', () => {
		const image = grey(2, 1, (x) => (x === 0 ? 0 : 200));
		const doubled = upscaleSmooth(image, 2);

		expect([doubled.width, doubled.height]).toEqual([4, 2]);
		// The two middle samples sit a quarter and three quarters of the way
		// across, so they must land strictly between the two source values. A
		// nearest-neighbour upscale returns 0, 0, 200, 200 and throws away exactly
		// the information about where the module edge sits that this rung exists
		// to recover.
		expect(at(doubled, 1, 0)).toBeGreaterThan(0);
		expect(at(doubled, 1, 0)).toBeLessThan(200);
		expect(at(doubled, 2, 0)).toBeGreaterThan(at(doubled, 1, 0));
	});

	it('multiplies the size by exactly the factor', () => {
		const doubled = upscaleSmooth(flat(37, 21, 100), 2);
		expect([doubled.width, doubled.height]).toEqual([74, 42]);
	});

	it('leaves a constant field constant', () => {
		const doubled = upscaleSmooth(flat(16, 16, 88), 2);
		for (let i = 0; i < doubled.data.length; i += 1) {
			expect(doubled.data[i]).toBe(88);
		}
	});
});

describe('looksInverted', () => {
	/** A symbol-ish middle on a surround, which is what the corners sample. */
	function scene(surround: number, dark: number, light: number): GreyImage {
		return grey(160, 160, (x, y) => {
			if (x < 40 || y < 40 || x >= 120 || y >= 120) {
				return surround;
			}
			return ((x >> 3) + (y >> 3)) % 2 === 0 ? dark : light;
		});
	}

	it('reads a light surround as not inverted', () => {
		expect(looksInverted(scene(240, 10, 245))).toBe(false);
	});

	it('reads a genuine dark-mode render as inverted', () => {
		expect(looksInverted(scene(25, 25, 230))).toBe(true);
	});

	it('does not flip on a capture taken in poor light', () => {
		// Gain 0.3 with a lift of 18 over a mid-grey surround: everything is
		// scaled down together, so the surround lands at 63 and the light modules
		// at 87. The absolute test this replaced compared against a fixed 96 and
		// called it inverted, which cost every rung of the ladder the wrong
		// polarity on exactly the photographs that needed the most help.
		const dim = scene(63, 18, 87);

		expect(looksInverted(dim)).toBe(false);
		// The corner brightness really is under the old threshold, so this is the
		// case that used to be wrong rather than a case that never arose.
		expect(at(dim, 4, 4)).toBeLessThan(96);
	});

	it('reads a mid-grey surround as not inverted', () => {
		expect(looksInverted(scene(150, 20, 250))).toBe(false);
	});
});
