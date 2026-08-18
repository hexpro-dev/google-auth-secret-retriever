import { ImageDecodeError } from '../errors.js';
import { MAX_WORK_PIXELS } from '../qr/decode/decoder.js';
import type { ImageDataLike } from '../types.js';

/**
 * Getting pixels out of the browser.
 *
 * Every entry point takes an injectable dependency bag. That is not ceremony:
 * it is what lets the whole adapter layer be exercised in Node with hand-written
 * fakes, so the error mapping is covered by tests rather than by hoping.
 */

export interface ImageDecodeDeps {
	readonly createImageBitmap?: typeof createImageBitmap;
	readonly createCanvas?: (width: number, height: number) => CanvasLike;
	readonly loadImageElement?: (blob: Blob) => Promise<ImageLike>;
}

/** The slice of a canvas this code uses, so a fake needs no more than this. */
export interface CanvasLike {
	width: number;
	height: number;
	getContext(
		type: '2d',
		options?: { readonly willReadFrequently?: boolean },
	): CanvasContextLike | null;
}

export interface CanvasContextLike {
	drawImage(source: never, x: number, y: number, width?: number, height?: number): void;
	getImageData(x: number, y: number, width: number, height: number): ImageDataLike;
	/**
	 * Both set on every context this module draws through.
	 *
	 * Optional only so a hand-written fake need not carry them. The default in a
	 * real browser is `'low'`, which in Chrome is a single bilinear tap per
	 * destination pixel whatever the ratio, so a 4032 to 1600 reduction samples
	 * 4 of every 25 source pixels and aliases the module grid.
	 */
	imageSmoothingEnabled?: boolean;
	imageSmoothingQuality?: 'low' | 'medium' | 'high';
}

export interface ImageLike {
	readonly width: number;
	readonly height: number;
}

/**
 * Work ceiling for a still image, in pixels rather than in long edge.
 *
 * The same number the decoder uses, so the two caps cannot interact: the pair of
 * them undershooting each other by a factor of two is what made every photograph
 * over 1400 pixels decode at 800.
 */
const MAX_STILL_PIXELS = MAX_WORK_PIXELS;

/**
 * The most any one `drawImage` may reduce by.
 *
 * Halving is the ratio at which a bilinear tap and a box average agree exactly,
 * which makes stepping correct whether or not the quality hint was honoured.
 */
const MAX_STEP = 2;

function defaultCanvas(width: number, height: number): CanvasLike {
	if (typeof OffscreenCanvas !== 'undefined') {
		return new OffscreenCanvas(width, height) as unknown as CanvasLike;
	}
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas as unknown as CanvasLike;
	}
	throw new ImageDecodeError('', undefined);
}

function loadViaElement(blob: Blob): Promise<ImageLike> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new ImageDecodeError(blob.type));
		};
		image.src = url;
	});
}

/** Target size for a source of this size, capped by area and never enlarged. */
function targetSize(width: number, height: number, maxPixels: number): [number, number] {
	const pixels = width * height;
	if (pixels <= maxPixels) {
		return [width, height];
	}
	const scale = Math.sqrt(maxPixels / pixels);
	return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

function context(canvas: CanvasLike, mime: string): CanvasContextLike {
	const found = canvas.getContext('2d');
	if (found === null) {
		throw new ImageDecodeError(mime);
	}
	found.imageSmoothingEnabled = true;
	found.imageSmoothingQuality = 'high';
	return found;
}

/**
 * The sizes a reduction passes through, none of them more than 2x down.
 *
 * The last entry is always the target, and a reduction of 2x or less is one
 * entry, so nothing here changes what a modest reduction does.
 */
function reductionSteps(
	sourceWidth: number,
	sourceHeight: number,
	width: number,
	height: number,
): Array<readonly [number, number]> {
	const steps: Array<readonly [number, number]> = [];
	let currentWidth = sourceWidth;
	let currentHeight = sourceHeight;

	for (;;) {
		const stepWidth = Math.max(width, Math.round(currentWidth / MAX_STEP));
		const stepHeight = Math.max(height, Math.round(currentHeight / MAX_STEP));
		if (stepWidth <= width && stepHeight <= height) {
			steps.push([width, height]);
			return steps;
		}
		steps.push([stepWidth, stepHeight]);
		currentWidth = stepWidth;
		currentHeight = stepHeight;
	}
}

/**
 * Draw a source down to a target size in steps of at most 2x.
 *
 * One `drawImage` from 4032 to 1600 discards most of the source whatever the
 * quality hint says, and what it keeps is whichever pixels the destination grid
 * happened to land on, which is how a screen-door pattern becomes stripes the
 * binariser then has to survive. Halving repeatedly averages instead.
 */
function drawStepped(
	source: ImageLike,
	width: number,
	height: number,
	createCanvas: (width: number, height: number) => CanvasLike,
	mime: string,
): ImageDataLike {
	let current: ImageLike = source;

	const steps = reductionSteps(source.width, source.height, width, height);
	let last: { context: CanvasContextLike; width: number; height: number } | null = null;

	for (const [stepWidth, stepHeight] of steps) {
		const canvas = createCanvas(stepWidth, stepHeight);
		canvas.width = stepWidth;
		canvas.height = stepHeight;
		const ctx = context(canvas, mime);
		ctx.drawImage(current as never, 0, 0, stepWidth, stepHeight);
		current = canvas;
		last = { context: ctx, width: stepWidth, height: stepHeight };
	}

	if (last === null) {
		throw new ImageDecodeError(mime);
	}
	return last.context.getImageData(0, 0, last.width, last.height);
}

export async function imageDataFromBlob(
	blob: Blob,
	deps: ImageDecodeDeps = {},
): Promise<ImageDataLike> {
	// SVG is rejected rather than rasterised. It renders at whatever size the
	// browser feels like, and it can carry script.
	if (blob.type === 'image/svg+xml') {
		throw new ImageDecodeError(blob.type);
	}

	const createBitmap =
		deps.createImageBitmap ??
		(typeof createImageBitmap === 'function' ? createImageBitmap : undefined);
	const createCanvas = deps.createCanvas ?? defaultCanvas;

	let source: ImageLike;
	try {
		source = createBitmap
			? ((await createBitmap(blob)) as unknown as ImageLike)
			: await (deps.loadImageElement ?? loadViaElement)(blob);
	} catch (cause) {
		// HEIC is the common case here: iPhone photos are HEIC and no browser
		// except Safari will open one. The error names the type so the message
		// can say something useful.
		throw new ImageDecodeError(blob.type, { cause });
	}

	if (source.width === 0 || source.height === 0) {
		throw new ImageDecodeError(blob.type);
	}

	const [width, height] = targetSize(source.width, source.height, MAX_STILL_PIXELS);
	return drawStepped(source, width, height, createCanvas, blob.type);
}

export async function imageDataFromFile(
	file: File,
	deps: ImageDecodeDeps = {},
): Promise<ImageDataLike> {
	return imageDataFromBlob(file, deps);
}

/**
 * Pull an image out of a paste.
 *
 * The path most people will actually use, because the natural way to get an
 * export QR onto a computer is to screenshot it to the clipboard. Returns null
 * when the paste held no image, which is an ordinary outcome rather than an
 * error: people paste text into this too.
 */
export async function imageDataFromClipboard(
	event: { clipboardData: { files?: ArrayLike<File>; items?: ArrayLike<DataTransferItem> } | null },
	deps: ImageDecodeDeps = {},
): Promise<ImageDataLike | null> {
	const data = event.clipboardData;
	if (data === null) {
		return null;
	}

	const files = data.files;
	if (files) {
		for (let i = 0; i < files.length; i += 1) {
			const file = files[i] as File;
			if (file.type.startsWith('image/')) {
				return imageDataFromBlob(file, deps);
			}
		}
	}

	const items = data.items;
	if (items) {
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i] as DataTransferItem;
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file !== null) {
					return imageDataFromBlob(file, deps);
				}
			}
		}
	}

	return null;
}

/**
 * Work ceiling for a live camera frame.
 *
 * A 1080p frame is 2.07 megapixels and has to pass through untouched, because
 * reducing it is exactly what this policy exists to stop: a 1280 by 720 stream
 * used to arrive at the decoder as 720 by 405, where a ten-account export sits
 * at 1.8 pixels per module, below Nyquist at every sensor size, so no better
 * camera could help. 2.1 is that number with nothing to spare, deliberately: a
 * 4K frame is still reduced, and reduced to 1080p rather than to 720p.
 */
export const MAX_CAMERA_PIXELS = 2_100_000;

/**
 * The canvases one video frame passes through, reused while the size holds.
 *
 * Eight fresh OffscreenCanvas allocations a second is pure garbage, and it is
 * garbage created on the thread that also has to paint the preview. The frame
 * size does not change while a stream is open, so the chain is built once.
 *
 * Almost always one canvas. A frame needs an intermediate only when the reduction
 * is more than 2x, which the camera ceiling does not ask for below 8K: 4K is
 * 3840 to 1932, a ratio of 1.99. See the note in `imageDataFromVideo`.
 */
let videoChain: {
	readonly create: (width: number, height: number) => CanvasLike;
	readonly sourceWidth: number;
	readonly sourceHeight: number;
	readonly steps: ReadonlyArray<{
		readonly canvas: CanvasLike;
		readonly context: CanvasContextLike;
		readonly width: number;
		readonly height: number;
	}>;
} | null = null;

/**
 * Read the current frame of a playing video, reduced for decoding.
 *
 * The reduction is stepped, for the reason `drawStepped` gives, and it is the same
 * `reductionSteps` chain the still path uses. Measured, that changes nothing for
 * every camera anyone has: at 2.1 megapixels the cap asks for 1.00x from 1080p,
 * 1.33x from 1440p and 1.99x from 4K, all of which are one step, so the draw is
 * the same single draw it always was. Above 4K it is two steps, and there it
 * matters: on an 8K frame of a screen with a visible pixel grid, one tap left the
 * symbol readable only at ladder rung 3 where the stepped chain read it at rung 1.
 * Paying for that with an extra canvas only on the frames that need one keeps the
 * common path exactly as cheap as before.
 */
export function imageDataFromVideo(
	video: { videoWidth: number; videoHeight: number },
	deps: ImageDecodeDeps = {},
	maxPixels = MAX_CAMERA_PIXELS,
): ImageDataLike {
	const { videoWidth, videoHeight } = video;
	if (videoWidth === 0 || videoHeight === 0) {
		throw new ImageDecodeError('video');
	}

	const [width, height] = targetSize(videoWidth, videoHeight, maxPixels);

	const create = deps.createCanvas ?? defaultCanvas;
	let cached = videoChain;
	const last = cached === null ? undefined : cached.steps[cached.steps.length - 1];
	// Keyed on the factory as well as the sizes: two scans with different canvas
	// sources must not hand each other their pixels.
	if (
		cached === null ||
		last === undefined ||
		cached.create !== create ||
		cached.sourceWidth !== videoWidth ||
		cached.sourceHeight !== videoHeight ||
		last.width !== width ||
		last.height !== height
	) {
		const steps = reductionSteps(videoWidth, videoHeight, width, height).map(
			([stepWidth, stepHeight]) => {
				const canvas = create(stepWidth, stepHeight);
				canvas.width = stepWidth;
				canvas.height = stepHeight;
				// `willReadFrequently` matters more than it looks: without it the engine
				// may keep the canvas GPU-backed, and then every getImageData is a
				// readback stall inside the per-frame budget.
				const found = canvas.getContext('2d', { willReadFrequently: true });
				if (found === null) {
					throw new ImageDecodeError('video');
				}
				found.imageSmoothingEnabled = true;
				found.imageSmoothingQuality = 'high';
				return { canvas, context: found, width: stepWidth, height: stepHeight };
			},
		);
		cached = { create, sourceWidth: videoWidth, sourceHeight: videoHeight, steps };
		videoChain = cached;
	}

	let source: unknown = video;
	for (const step of cached.steps) {
		step.context.drawImage(source as never, 0, 0, step.width, step.height);
		source = step.canvas;
	}

	const final = cached.steps[cached.steps.length - 1];
	if (final === undefined) {
		throw new ImageDecodeError('video');
	}
	return final.context.getImageData(0, 0, final.width, final.height);
}

/** Drop the reused frame canvases. For tests, and for a caller shutting down. */
export function releaseVideoCanvas(): void {
	videoChain = null;
}
