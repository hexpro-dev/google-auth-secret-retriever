import { describe, expect, it, vi } from 'vitest';
import {
	type CanvasLike,
	imageDataFromBlob,
	imageDataFromClipboard,
	imageDataFromVideo,
} from '../../src/dom/image-source.js';
import { ImageDecodeError } from '../../src/errors.js';
import type { ImageDataLike } from '../../src/types.js';

/**
 * The adapter layer, exercised with hand-written fakes.
 *
 * No jsdom. Every entry point takes an injectable dependency bag precisely so
 * the interesting part (mapping browser failures onto errors a person can act
 * on) is covered by tests rather than by hope.
 */

function fakeCanvas(): { canvas: CanvasLike; drawn: unknown[]; lastSize: [number, number] } {
	const drawn: unknown[] = [];
	let lastSize: [number, number] = [0, 0];

	const canvas: CanvasLike = {
		width: 0,
		height: 0,
		getContext: () => ({
			drawImage: (source: never, _x: number, _y: number, width?: number, height?: number) => {
				drawn.push(source);
				lastSize = [width ?? 0, height ?? 0];
			},
			getImageData: (_x: number, _y: number, width: number, height: number): ImageDataLike => {
				const data = new Uint8ClampedArray(width * height * 4);
				data.fill(255);
				return { data, width, height };
			},
		}),
	};

	return {
		canvas,
		drawn,
		get lastSize() {
			return lastSize;
		},
	};
}

function fakeBlob(type = 'image/png'): Blob {
	return { type, size: 10 } as Blob;
}

describe('imageDataFromBlob', () => {
	it('decodes through createImageBitmap and a canvas', async () => {
		const fake = fakeCanvas();
		const result = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: (async () => ({
				width: 100,
				height: 60,
			})) as unknown as typeof createImageBitmap,
			createCanvas: () => fake.canvas,
		});

		expect(result.width).toBe(100);
		expect(result.height).toBe(60);
	});

	it('falls back to an image element when createImageBitmap is absent', async () => {
		// Older Safari. The fallback exists so the tool still works there.
		const fake = fakeCanvas();
		const loadImageElement = vi.fn(async () => ({ width: 40, height: 40 }));

		const result = await imageDataFromBlob(fakeBlob(), {
			createCanvas: () => fake.canvas,
			loadImageElement,
		});

		expect(loadImageElement).toHaveBeenCalledOnce();
		expect(result.width).toBe(40);
	});

	it('downscales anything with a very long edge', async () => {
		// An iPad screenshot is 2732 wide and a phone camera is far more. QR
		// decoding gains nothing from that and pays for it at every stage.
		const fake = fakeCanvas();
		const result = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: (async () => ({
				width: 4000,
				height: 3000,
			})) as unknown as typeof createImageBitmap,
			createCanvas: () => fake.canvas,
		});

		expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1600);
		// Aspect ratio preserved.
		expect(result.width / result.height).toBeCloseTo(4000 / 3000, 2);
	});

	it('leaves a modest image at its own size', async () => {
		const fake = fakeCanvas();
		const result = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: (async () => ({
				width: 800,
				height: 600,
			})) as unknown as typeof createImageBitmap,
			createCanvas: () => fake.canvas,
		});

		expect([result.width, result.height]).toEqual([800, 600]);
	});

	it('rejects SVG rather than rasterising it', async () => {
		// It renders at whatever size the browser feels like, and it can carry
		// script. Neither belongs anywhere near this.
		await expect(imageDataFromBlob(fakeBlob('image/svg+xml'))).rejects.toBeInstanceOf(
			ImageDecodeError,
		);
	});

	it('maps a decode failure onto ImageDecodeError carrying the type', async () => {
		// The common real case is HEIC: iPhone photos are HEIC and no browser
		// but Safari opens one, so the message needs to say that specifically.
		try {
			await imageDataFromBlob(fakeBlob('image/heic'), {
				createImageBitmap: (async () => {
					throw new Error('unsupported');
				}) as unknown as typeof createImageBitmap,
			});
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(ImageDecodeError);
			expect((error as ImageDecodeError).mime).toBe('image/heic');
			expect((error as ImageDecodeError).message).toContain('HEIC');
		}
	});

	it('rejects a zero-sized image', async () => {
		await expect(
			imageDataFromBlob(fakeBlob(), {
				createImageBitmap: (async () => ({
					width: 0,
					height: 0,
				})) as unknown as typeof createImageBitmap,
				createCanvas: () => fakeCanvas().canvas,
			}),
		).rejects.toBeInstanceOf(ImageDecodeError);
	});

	it('rejects when no 2d context is available', async () => {
		const canvas: CanvasLike = { width: 0, height: 0, getContext: () => null };

		await expect(
			imageDataFromBlob(fakeBlob(), {
				createImageBitmap: (async () => ({
					width: 10,
					height: 10,
				})) as unknown as typeof createImageBitmap,
				createCanvas: () => canvas,
			}),
		).rejects.toBeInstanceOf(ImageDecodeError);
	});
});

describe('imageDataFromClipboard', () => {
	const deps = {
		createImageBitmap: (async () => ({
			width: 20,
			height: 20,
		})) as unknown as typeof createImageBitmap,
		createCanvas: () => fakeCanvas().canvas,
	};

	it('reads an image from clipboard files', async () => {
		// The path most people use: screenshot to clipboard, then paste.
		const event = { clipboardData: { files: [fakeBlob() as File] } };

		expect(await imageDataFromClipboard(event, deps)).not.toBeNull();
	});

	it('reads an image from clipboard items when files are absent', async () => {
		const event = {
			clipboardData: {
				items: [
					{ kind: 'string', type: 'text/plain', getAsFile: () => null },
					{ kind: 'file', type: 'image/png', getAsFile: () => fakeBlob() as File },
				] as unknown as ArrayLike<DataTransferItem>,
			},
		};

		expect(await imageDataFromClipboard(event, deps)).not.toBeNull();
	});

	it('returns null for a paste with no image, which is not an error', async () => {
		// People paste text into this too.
		expect(await imageDataFromClipboard({ clipboardData: { files: [] } }, deps)).toBeNull();
		expect(await imageDataFromClipboard({ clipboardData: null }, deps)).toBeNull();
	});

	it('ignores non-image files', async () => {
		const event = { clipboardData: { files: [{ type: 'application/pdf' } as File] } };

		expect(await imageDataFromClipboard(event, deps)).toBeNull();
	});
});

describe('imageDataFromVideo', () => {
	it('downscales a camera frame to the decode size', async () => {
		const fake = fakeCanvas();
		const result = imageDataFromVideo(
			{ videoWidth: 1280, videoHeight: 720 },
			{ createCanvas: () => fake.canvas },
			720,
		);

		expect(Math.max(result.width, result.height)).toBe(720);
	});

	it('rejects a video that has no dimensions yet', () => {
		// Normal for the first frames after play() resolves.
		expect(() => imageDataFromVideo({ videoWidth: 0, videoHeight: 0 })).toThrow(ImageDecodeError);
	});
});
