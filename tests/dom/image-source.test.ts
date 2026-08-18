import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type CanvasContextLike,
	type CanvasLike,
	MAX_CAMERA_PIXELS,
	imageDataFromBlob,
	imageDataFromClipboard,
	imageDataFromFile,
	imageDataFromVideo,
	releaseVideoCanvas,
} from '../../src/dom/image-source.js';
import { ImageDecodeError } from '../../src/errors.js';
import { MAX_WORK_PIXELS } from '../../src/qr/decode/decoder.js';
import type { ImageDataLike } from '../../src/types.js';

/**
 * The adapter layer, exercised with hand-written fakes.
 *
 * No jsdom. Every entry point takes an injectable dependency bag precisely so
 * the interesting part (mapping browser failures onto errors a person can act
 * on) is covered by tests rather than by hope.
 *
 * The resolution policy is here rather than in the decoder tests because this is
 * where it was wrong: this layer capped the long edge at 1600, the decoder was
 * then asked for 1400, and because its own fit could only halve, every
 * photograph over 1400 pixels was decoded at 800.
 */

interface Draw {
	readonly from: [number, number];
	readonly to: [number, number];
}

/** A canvas factory that records what was drawn through it, and how. */
function recorder(): {
	create: (width: number, height: number) => CanvasLike;
	readonly draws: Draw[];
	readonly contexts: CanvasContextLike[];
	readonly options: Array<{ readonly willReadFrequently?: boolean } | undefined>;
	readonly canvases: number;
} {
	const draws: Draw[] = [];
	const contexts: CanvasContextLike[] = [];
	const options: Array<{ readonly willReadFrequently?: boolean } | undefined> = [];
	let canvases = 0;

	const create = (width: number, height: number): CanvasLike => {
		canvases += 1;
		const canvas: CanvasLike = {
			width,
			height,
			getContext: (_type, contextOptions) => {
				const context: CanvasContextLike = {
					drawImage: (source: never, _x: number, _y: number, w?: number, h?: number) => {
						const from = source as unknown as { width: number; height: number };
						draws.push({ from: [from.width, from.height], to: [w ?? 0, h ?? 0] });
					},
					getImageData: (_x: number, _y: number, w: number, h: number): ImageDataLike => {
						const data = new Uint8ClampedArray(w * h * 4);
						data.fill(255);
						return { data, width: w, height: h };
					},
				};
				contexts.push(context);
				options.push(contextOptions);
				return context;
			},
		};
		return canvas;
	};

	return {
		create,
		draws,
		contexts,
		options,
		get canvases() {
			return canvases;
		},
	};
}

function fakeCanvas(): { canvas: CanvasLike; drawn: unknown[]; lastSize: [number, number] } {
	const record = recorder();
	const canvas = record.create(0, 0);

	return {
		canvas,
		get drawn() {
			return record.draws as unknown[];
		},
		get lastSize() {
			const last = record.draws[record.draws.length - 1];
			return last ? last.to : ([0, 0] as [number, number]);
		},
	};
}

function bitmap(width: number, height: number): typeof createImageBitmap {
	return (async () => ({ width, height })) as unknown as typeof createImageBitmap;
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

	it('caps the work by area rather than by long edge', async () => {
		// A 4032 by 1000 panorama and a 4032 by 3024 photograph have the same long
		// edge and four times the difference in work, and every stage of decoding
		// is linear in area. Capping the long edge prices them the same.
		const panorama = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: bitmap(4032, 1000),
			createCanvas: recorder().create,
		});
		const photo = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: bitmap(4032, 3024),
			createCanvas: recorder().create,
		});

		expect(panorama.width * panorama.height).toBeLessThanOrEqual(MAX_WORK_PIXELS);
		expect(photo.width * photo.height).toBeLessThanOrEqual(MAX_WORK_PIXELS);
		// Both arrive at the ceiling, so the panorama keeps its long edge and the
		// photograph loses two thirds of its own.
		expect(panorama.width).toBeGreaterThan(photo.width * 1.5);
		expect(photo.width / photo.height).toBeCloseTo(4032 / 3024, 2);
	});

	it('reduces in steps of at most two, never in one jump', async () => {
		// One drawImage from 4032 to 1600 keeps whichever pixels the destination
		// grid landed on, whatever the quality hint claims, which is how a screen
		// door pattern becomes stripes the binariser then has to survive.
		const record = recorder();
		await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: bitmap(8000, 6000),
			createCanvas: record.create,
		});

		expect(record.draws.length).toBeGreaterThan(1);
		for (const draw of record.draws) {
			expect(draw.from[0] / draw.to[0], JSON.stringify(draw)).toBeLessThanOrEqual(2.001);
			expect(draw.from[1] / draw.to[1], JSON.stringify(draw)).toBeLessThanOrEqual(2.001);
		}
	});

	it('asks for the good resampler on every context it draws through', async () => {
		// The default is 'low', which in Chrome is a single bilinear tap per
		// destination pixel however far the reduction goes.
		const record = recorder();
		await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: bitmap(4000, 3000),
			createCanvas: record.create,
		});

		expect(record.contexts.length).toBeGreaterThan(0);
		for (const context of record.contexts) {
			expect(context.imageSmoothingEnabled).toBe(true);
			expect(context.imageSmoothingQuality).toBe('high');
		}
	});

	it('leaves a modest image at its own size', async () => {
		const result = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: bitmap(800, 600),
			createCanvas: recorder().create,
		});

		expect([result.width, result.height]).toEqual([800, 600]);
	});

	it('never enlarges a small screenshot', async () => {
		const result = await imageDataFromBlob(fakeBlob(), {
			createImageBitmap: bitmap(300, 220),
			createCanvas: recorder().create,
		});

		expect([result.width, result.height]).toEqual([300, 220]);
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

describe('imageDataFromFile', () => {
	it('decodes a chosen file the same way as a pasted one', async () => {
		const file = { type: 'image/png', size: 10, name: 'export.png' } as unknown as File;

		const result = await imageDataFromFile(file, {
			createImageBitmap: bitmap(50, 40),
			createCanvas: recorder().create,
		});

		expect([result.width, result.height]).toEqual([50, 40]);
	});

	it('rejects an SVG chosen from the file dialog', async () => {
		// `accept` on a file input is a hint rather than a rule, so the refusal has
		// to live here as well as on the paste path.
		const file = { type: 'image/svg+xml', size: 10, name: 'code.svg' } as unknown as File;

		await expect(imageDataFromFile(file)).rejects.toBeInstanceOf(ImageDecodeError);
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

	it('ignores an item that hands back no file', async () => {
		// Browsers do this: an item can advertise a type and then produce nothing.
		const event = {
			clipboardData: {
				items: [
					{ kind: 'file', type: 'image/png', getAsFile: () => null },
				] as unknown as ArrayLike<DataTransferItem>,
			},
		};

		expect(await imageDataFromClipboard(event, deps)).toBeNull();
	});

	it('ignores non-image files', async () => {
		const event = { clipboardData: { files: [{ type: 'application/pdf' } as File] } };

		expect(await imageDataFromClipboard(event, deps)).toBeNull();
	});
});

describe('imageDataFromVideo', () => {
	it('passes a 1080p frame through untouched', () => {
		// This is the whole policy. A 1280 by 720 stream used to arrive at the
		// decoder as 720 by 405, where a ten-account export sits at 1.8 pixels per
		// module: below Nyquist at every sensor size, so no better camera helped.
		releaseVideoCanvas();
		const result = imageDataFromVideo(
			{ videoWidth: 1920, videoHeight: 1080 },
			{ createCanvas: recorder().create },
		);

		expect([result.width, result.height]).toEqual([1920, 1080]);
	});

	it('reduces a 4K frame to the camera ceiling, and no further', () => {
		releaseVideoCanvas();
		const result = imageDataFromVideo(
			{ videoWidth: 3840, videoHeight: 2160 },
			{ createCanvas: recorder().create },
		);

		expect(result.width * result.height).toBeLessThanOrEqual(MAX_CAMERA_PIXELS);
		// 1080p rather than 720p, which is what the old long-edge cap gave it.
		expect(result.height).toBeGreaterThan(1000);
	});

	it('reuses one canvas while the size holds', () => {
		// Eight fresh OffscreenCanvas allocations a second is pure garbage, made on
		// the thread that also has to paint the preview.
		releaseVideoCanvas();
		const record = recorder();
		const video = { videoWidth: 1280, videoHeight: 720 };

		imageDataFromVideo(video, { createCanvas: record.create });
		imageDataFromVideo(video, { createCanvas: record.create });
		imageDataFromVideo(video, { createCanvas: record.create });

		expect(record.canvases).toBe(1);
		expect(record.draws).toHaveLength(3);
	});

	it('takes one draw for every frame a camera actually produces', () => {
		// The camera ceiling asks for 1.00x from 1080p, 1.33x from 1440p and 1.99x
		// from 4K, all of which a single bilinear tap gets right, so the stepped
		// chain must not add a canvas or a draw to any of them.
		for (const [width, height] of [
			[1280, 720],
			[1920, 1080],
			[2560, 1440],
			[3840, 2160],
		] as const) {
			releaseVideoCanvas();
			const record = recorder();
			imageDataFromVideo(
				{ videoWidth: width, videoHeight: height },
				{ createCanvas: record.create },
			);

			expect(record.canvases, `${width}x${height}`).toBe(1);
			expect(record.draws, `${width}x${height}`).toHaveLength(1);
		}
	});

	it('steps an above-4K frame rather than throwing three quarters of it away', () => {
		// An 8K frame is a 3.98x reduction, where one tap keeps 4 pixels of every 16
		// and the phase it keeps them at is whatever the destination grid landed on.
		// Measured on an 8K capture of a screen with a visible pixel grid, that left
		// the symbol readable only at ladder rung 3 where stepping read it at rung 1.
		releaseVideoCanvas();
		const record = recorder();
		const result = imageDataFromVideo(
			{ videoWidth: 7680, videoHeight: 4320 },
			{ createCanvas: record.create },
		);

		expect(record.canvases).toBe(2);
		expect(record.draws).toHaveLength(2);
		for (const draw of record.draws.slice(1)) {
			expect(draw.from[0] / draw.to[0], JSON.stringify(draw)).toBeLessThanOrEqual(2.001);
		}
		expect(result.width * result.height).toBeLessThanOrEqual(MAX_CAMERA_PIXELS);
	});

	it('reuses the whole chain while the frame size holds', () => {
		releaseVideoCanvas();
		const record = recorder();
		const video = { videoWidth: 7680, videoHeight: 4320 };

		imageDataFromVideo(video, { createCanvas: record.create });
		imageDataFromVideo(video, { createCanvas: record.create });
		imageDataFromVideo(video, { createCanvas: record.create });

		expect(record.canvases).toBe(2);
		expect(record.draws).toHaveLength(6);
	});

	it('asks for a canvas it can read back from cheaply', () => {
		// Without this the engine may keep the canvas GPU-backed, and then every
		// getImageData is a readback stall inside the per-frame budget.
		releaseVideoCanvas();
		const record = recorder();
		imageDataFromVideo({ videoWidth: 1280, videoHeight: 720 }, { createCanvas: record.create });

		expect(record.options[0]?.willReadFrequently).toBe(true);
	});

	it('rejects a frame when the canvas gives back no 2d context', () => {
		// A page that has run out of canvas memory hands back null, and the frame
		// loop has to raise the library's error rather than a TypeError.
		releaseVideoCanvas();
		const canvas: CanvasLike = { width: 0, height: 0, getContext: () => null };

		expect(() =>
			imageDataFromVideo({ videoWidth: 640, videoHeight: 480 }, { createCanvas: () => canvas }),
		).toThrow(ImageDecodeError);
	});

	it('rejects a video that has no dimensions yet', () => {
		// Normal for the first frames after play() resolves.
		expect(() => imageDataFromVideo({ videoWidth: 0, videoHeight: 0 })).toThrow(ImageDecodeError);
	});
});

describe('default browser wiring', () => {
	// Every other suite in this file injects fakes. These are the defaults, which
	// is what a consumer who passes no deps runs, and nothing else covers them.

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		releaseVideoCanvas();
	});

	function stubContext(): CanvasContextLike {
		return {
			drawImage: () => undefined,
			getImageData: (_x: number, _y: number, width: number, height: number): ImageDataLike => ({
				data: new Uint8ClampedArray(width * height * 4),
				width,
				height,
			}),
		};
	}

	/** Stand in for the page's OffscreenCanvas, recording the sizes asked for. */
	function stubOffscreenCanvas(sizes: Array<[number, number]>): void {
		vi.stubGlobal(
			'OffscreenCanvas',
			class {
				width: number;
				height: number;

				constructor(width: number, height: number) {
					sizes.push([width, height]);
					this.width = width;
					this.height = height;
				}

				getContext(): CanvasContextLike {
					return stubContext();
				}
			},
		);
	}

	/** An image element that settles on the next microtask. */
	function stubImage(options: { fails: boolean }): unknown {
		return class {
			width = 30;
			height = 20;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;

			set src(_value: string) {
				queueMicrotask(() => {
					if (options.fails) {
						this.onerror?.();
					} else {
						this.onload?.();
					}
				});
			}
		};
	}

	it('draws on an OffscreenCanvas where the page has one', () => {
		releaseVideoCanvas();
		const sizes: Array<[number, number]> = [];
		stubOffscreenCanvas(sizes);

		const result = imageDataFromVideo({ videoWidth: 1280, videoHeight: 720 });

		expect(sizes).toEqual([[1280, 720]]);
		expect([result.width, result.height]).toEqual([1280, 720]);
	});

	it('falls back to a canvas element, at the size of the frame', () => {
		// A canvas element is 300 by 150 until something says otherwise, and a frame
		// drawn on one at that size arrives as a corner of itself.
		releaseVideoCanvas();
		const tags: string[] = [];
		const created: CanvasLike[] = [];
		vi.stubGlobal('document', {
			createElement: (tag: string) => {
				tags.push(tag);
				const canvas: CanvasLike = { width: 0, height: 0, getContext: () => stubContext() };
				created.push(canvas);
				return canvas;
			},
		});

		imageDataFromVideo({ videoWidth: 800, videoHeight: 600 });

		expect(tags).toEqual(['canvas']);
		expect([created[0]?.width, created[0]?.height]).toEqual([800, 600]);
	});

	it('raises ImageDecodeError where there is no canvas at all', () => {
		// A worker without OffscreenCanvas, or a server render. The library's own
		// error, because that is the one a caller is catching.
		releaseVideoCanvas();

		expect(() => imageDataFromVideo({ videoWidth: 100, videoHeight: 100 })).toThrow(
			ImageDecodeError,
		);
	});

	it("decodes a blob through the page's own createImageBitmap", async () => {
		stubOffscreenCanvas([]);
		vi.stubGlobal('createImageBitmap', async () => ({ width: 64, height: 48 }));

		const result = await imageDataFromBlob(fakeBlob());

		expect([result.width, result.height]).toEqual([64, 48]);
	});

	it('loads through an image element where createImageBitmap is missing', async () => {
		// Older Safari. The revoke is the part worth pinning: without it the blob
		// stays alive for the life of the document, once per pasted screenshot.
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		vi.stubGlobal('Image', stubImage({ fails: false }));

		const result = await imageDataFromBlob(fakeBlob(), { createCanvas: recorder().create });

		expect([result.width, result.height]).toEqual([30, 20]);
		expect(revoke).toHaveBeenCalledWith('blob:stub');
	});

	it('revokes the object URL when the image will not load either', async () => {
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		vi.stubGlobal('Image', stubImage({ fails: true }));

		const failure = imageDataFromBlob(fakeBlob('image/heic'));

		await expect(failure).rejects.toBeInstanceOf(ImageDecodeError);
		await expect(failure).rejects.toMatchObject({ mime: 'image/heic' });
		expect(revoke).toHaveBeenCalledWith('blob:stub');
	});
});
