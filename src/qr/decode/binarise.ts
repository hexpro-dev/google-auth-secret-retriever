import { BitMatrix } from '../bit-matrix.js';
import type { GreyImage } from './grey.js';

/**
 * Deciding which pixels are dark.
 *
 * The hardest and least glamorous part of reading a QR code from a photograph.
 * A screenshot is trivial; a phone photo of a laptop screen has a brightness
 * gradient across it, a specular highlight somewhere, and a colour cast, and a
 * single global threshold will shred it.
 *
 * Three strategies, tried in order by the decode ladder rather than chosen
 * cleverly. Cheap and wrong is fine when the next rung is a few milliseconds
 * away, and the ladder reports which rung worked, which is genuinely useful
 * when somebody says "it does not work on my phone".
 */

const BLOCK = 8;
const MIN_DYNAMIC_RANGE = 24;

/**
 * Global threshold by Otsu's method: the split that minimises the variance
 * within the two resulting groups.
 *
 * Excellent on screenshots and synthetic images, which have two clean peaks.
 * Useless on anything with a gradient, which is why it is not the first rung.
 */
export function otsuThreshold(image: GreyImage): number {
	const histogram = new Uint32Array(256);
	for (let i = 0; i < image.data.length; i += 1) {
		histogram[image.data[i] as number] += 1;
	}

	const total = image.data.length;
	let sum = 0;
	for (let i = 0; i < 256; i += 1) {
		sum += i * (histogram[i] as number);
	}

	let sumBackground = 0;
	let weightBackground = 0;
	let best = 0;
	let bestVariance = -1;

	for (let t = 0; t < 256; t += 1) {
		weightBackground += histogram[t] as number;
		if (weightBackground === 0) {
			continue;
		}
		const weightForeground = total - weightBackground;
		if (weightForeground === 0) {
			break;
		}

		sumBackground += t * (histogram[t] as number);
		const meanBackground = sumBackground / weightBackground;
		const meanForeground = (sum - sumBackground) / weightForeground;
		const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

		if (variance > bestVariance) {
			bestVariance = variance;
			best = t;
		}
	}

	return best;
}

export function binariseOtsu(image: GreyImage): BitMatrix {
	const threshold = otsuThreshold(image);
	const matrix = new BitMatrix(image.width, image.height);

	for (let i = 0; i < image.data.length; i += 1) {
		matrix.bits[i] = (image.data[i] as number) <= threshold ? 1 : 0;
	}

	return matrix;
}

/**
 * Local thresholding on an 8 by 8 grid, smoothed across neighbouring blocks.
 *
 * The workhorse, and the reason phone photos work at all. Two details do the
 * heavy lifting. A block whose dynamic range is tiny is judged to be flat, and
 * takes the average of its already-computed neighbours rather than inventing a
 * threshold in the middle of a uniform area, which would otherwise shred a
 * solid quiet zone into noise. And each block's threshold is averaged over its
 * 3 by 3 neighbourhood, so block boundaries do not print themselves onto the
 * result.
 */
export function binariseHybrid(image: GreyImage): BitMatrix {
	const { width, height, data } = image;
	const blocksX = Math.max(1, Math.ceil(width / BLOCK));
	const blocksY = Math.max(1, Math.ceil(height / BLOCK));

	if (width < BLOCK * 3 || height < BLOCK * 3) {
		// Too small for the local statistics to mean anything.
		return binariseOtsu(image);
	}

	const thresholds = new Int32Array(blocksX * blocksY);

	for (let by = 0; by < blocksY; by += 1) {
		for (let bx = 0; bx < blocksX; bx += 1) {
			const x0 = bx * BLOCK;
			const y0 = by * BLOCK;
			const x1 = Math.min(x0 + BLOCK, width);
			const y1 = Math.min(y0 + BLOCK, height);

			let min = 255;
			let max = 0;
			let sum = 0;
			let count = 0;

			for (let y = y0; y < y1; y += 1) {
				for (let x = x0; x < x1; x += 1) {
					const value = data[y * width + x] as number;
					sum += value;
					count += 1;
					if (value < min) {
						min = value;
					}
					if (value > max) {
						max = value;
					}
				}
			}

			let threshold: number;
			if (max - min > MIN_DYNAMIC_RANGE) {
				threshold = (min + max) >> 1;
			} else if (bx === 0 && by === 0) {
				// Nothing computed yet to borrow from. Bias dark so a uniformly
				// light corner does not come out solid black.
				threshold = min >> 1;
			} else {
				// Flat block: inherit from the neighbours already computed,
				// which is what stops a plain quiet zone becoming noise.
				const left = bx > 0 ? (thresholds[by * blocksX + bx - 1] as number) : 0;
				const above = by > 0 ? (thresholds[(by - 1) * blocksX + bx] as number) : 0;
				const aboveLeft =
					bx > 0 && by > 0 ? (thresholds[(by - 1) * blocksX + bx - 1] as number) : 0;
				const divisor = (bx > 0 ? 1 : 0) + (by > 0 ? 1 : 0) + (bx > 0 && by > 0 ? 2 : 0);
				threshold =
					divisor > 0 ? Math.round((left + above + 2 * aboveLeft) / divisor) : sum / count;
			}

			thresholds[by * blocksX + bx] = threshold;
		}
	}

	const matrix = new BitMatrix(width, height);

	for (let by = 0; by < blocksY; by += 1) {
		for (let bx = 0; bx < blocksX; bx += 1) {
			// Average over the 3x3 block neighbourhood, clamped at the edges,
			// so thresholds vary smoothly instead of in visible steps.
			let total = 0;
			let count = 0;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					const nx = bx + dx;
					const ny = by + dy;
					if (nx >= 0 && ny >= 0 && nx < blocksX && ny < blocksY) {
						total += thresholds[ny * blocksX + nx] as number;
						count += 1;
					}
				}
			}
			const threshold = total / count;

			const x0 = bx * BLOCK;
			const y0 = by * BLOCK;
			const x1 = Math.min(x0 + BLOCK, width);
			const y1 = Math.min(y0 + BLOCK, height);

			for (let y = y0; y < y1; y += 1) {
				for (let x = x0; x < x1; x += 1) {
					matrix.bits[y * width + x] = (data[y * width + x] as number) <= threshold ? 1 : 0;
				}
			}
		}
	}

	return matrix;
}

/**
 * Sauvola thresholding: a windowed mean adjusted by the local standard
 * deviation.
 *
 * Slow, and the right answer for glare. A specular highlight destroys the local
 * mean but leaves the local variance intact, so a rule that leans on variance
 * keeps reading modules where a mean-based one gives up. Computed over integral
 * images so the window size costs nothing.
 */
export function binariseSauvola(image: GreyImage, window = 31, k = 0.2): BitMatrix {
	const { width, height, data } = image;
	const radius = Math.max(1, window >> 1);

	// Integral images of the values and their squares, one row and column of
	// padding so the window arithmetic needs no bounds checks.
	const sums = new Float64Array((width + 1) * (height + 1));
	const squares = new Float64Array((width + 1) * (height + 1));

	for (let y = 0; y < height; y += 1) {
		let rowSum = 0;
		let rowSquare = 0;
		for (let x = 0; x < width; x += 1) {
			const value = data[y * width + x] as number;
			rowSum += value;
			rowSquare += value * value;
			sums[(y + 1) * (width + 1) + x + 1] = (sums[y * (width + 1) + x + 1] as number) + rowSum;
			squares[(y + 1) * (width + 1) + x + 1] =
				(squares[y * (width + 1) + x + 1] as number) + rowSquare;
		}
	}

	const areaSum = (x0: number, y0: number, x1: number, y1: number, table: Float64Array): number =>
		(table[y1 * (width + 1) + x1] as number) -
		(table[y0 * (width + 1) + x1] as number) -
		(table[y1 * (width + 1) + x0] as number) +
		(table[y0 * (width + 1) + x0] as number);

	const matrix = new BitMatrix(width, height);

	for (let y = 0; y < height; y += 1) {
		const y0 = Math.max(0, y - radius);
		const y1 = Math.min(height, y + radius + 1);

		for (let x = 0; x < width; x += 1) {
			const x0 = Math.max(0, x - radius);
			const x1 = Math.min(width, x + radius + 1);
			const count = (x1 - x0) * (y1 - y0);

			const total = areaSum(x0, y0, x1, y1, sums);
			const totalSquares = areaSum(x0, y0, x1, y1, squares);
			const mean = total / count;
			const variance = Math.max(0, totalSquares / count - mean * mean);
			const deviation = Math.sqrt(variance);

			// R = 128, the standard choice for 8-bit input.
			const threshold = mean * (1 + k * (deviation / 128 - 1));
			matrix.bits[y * width + x] = (data[y * width + x] as number) <= threshold ? 1 : 0;
		}
	}

	return matrix;
}
