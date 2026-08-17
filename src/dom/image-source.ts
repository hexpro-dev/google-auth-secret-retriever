import { ImageDecodeError } from '../errors.js';
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
	getContext(type: '2d'): CanvasContextLike | null;
}

export interface CanvasContextLike {
	drawImage(source: never, x: number, y: number, width?: number, height?: number): void;
	getImageData(x: number, y: number, width: number, height: number): ImageDataLike;
}

export interface ImageLike {
	readonly width: number;
	readonly height: number;
}

/**
 * Anything over this on the long edge is downscaled before decoding.
 *
 * An iPad screenshot is 2732 pixels wide and a modern phone camera is far more.
 * QR decoding gains nothing from that resolution and pays for it linearly at
 * every stage, so the cap is a straight win. The decoder applies its own cap
 * too; this one keeps the canvas allocation down as well.
 */
const MAX_EDGE = 1600;

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

function scaleFor(width: number, height: number): number {
	const longest = Math.max(width, height);
	return longest > MAX_EDGE ? MAX_EDGE / longest : 1;
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

	const scale = scaleFor(source.width, source.height);
	const width = Math.max(1, Math.round(source.width * scale));
	const height = Math.max(1, Math.round(source.height * scale));

	const canvas = createCanvas(width, height);
	canvas.width = width;
	canvas.height = height;

	const context = canvas.getContext('2d');
	if (context === null) {
		throw new ImageDecodeError(blob.type);
	}

	context.drawImage(source as never, 0, 0, width, height);
	return context.getImageData(0, 0, width, height);
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

/** Read the current frame of a playing video, downscaled for decoding. */
export function imageDataFromVideo(
	video: { videoWidth: number; videoHeight: number },
	deps: ImageDecodeDeps = {},
	maxEdge = 720,
): ImageDataLike {
	const { videoWidth, videoHeight } = video;
	if (videoWidth === 0 || videoHeight === 0) {
		throw new ImageDecodeError('video');
	}

	const longest = Math.max(videoWidth, videoHeight);
	const scale = longest > maxEdge ? maxEdge / longest : 1;
	const width = Math.max(1, Math.round(videoWidth * scale));
	const height = Math.max(1, Math.round(videoHeight * scale));

	const canvas = (deps.createCanvas ?? defaultCanvas)(width, height);
	canvas.width = width;
	canvas.height = height;

	const context = canvas.getContext('2d');
	if (context === null) {
		throw new ImageDecodeError('video');
	}

	context.drawImage(video as never, 0, 0, width, height);
	return context.getImageData(0, 0, width, height);
}
