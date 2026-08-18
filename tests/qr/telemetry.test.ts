import { describe, expect, it } from 'vitest';
import { BINARISED_TELEMETRY_PIXELS, decodeQrFromImageData } from '../../src/qr/decode/decoder.js';
import type { DecodeFailureReason, DecodeFrame } from '../../src/qr/decode/telemetry.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import { renderQrImageData } from '../../src/qr/encode/render.js';
import type { ImageDataLike } from '../../src/types.js';
import { blur, noise, pad, place, seededRandom } from '../helpers/image.js';

/**
 * The telemetry stream, which is API rather than debug output.
 *
 * Two shipped visual effects on the website consume these frames, so the stage
 * names, their order and the shape of each payload are a contract. The one thing
 * that may change size is the binarised bitmap, and that is capped here rather
 * than at the consumer, because a consumer turns it into an ImageData at four
 * bytes per pixel on the main thread.
 */

const PAYLOAD =
	'otpauth-migration://offline?data=CksKCs%2FSZTJhqIO%2BKYASI2FsaWNlQGV4YW1wbGUuY29tGhJhdXRoLmV4YW1wbGUudGVzdCABKAEwAgojChTxZXW8hBpXh2dAiI4YopDgCtgLhRIFQTQwNDMgASgBMAIQAhgBIAA';

function render(text: string, scale = 6): ImageDataLike {
	return renderQrImageData(encodeQr(text, { ecLevel: 'M' }), { scale, quietZone: 4 });
}

function collect(image: ImageDataLike, options = {}): DecodeFrame[] {
	const frames: DecodeFrame[] = [];
	decodeQrFromImageData(image, { ...options, onTelemetry: (frame) => frames.push(frame) });
	return frames;
}

function flat(width: number, height: number, value: number): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	data.fill(value);
	for (let i = 3; i < data.length; i += 4) {
		data[i] = 255;
	}
	return { data, width, height };
}

function reasonOf(frames: DecodeFrame[]): DecodeFailureReason | undefined {
	const last = frames[frames.length - 1];
	return last?.stage === 'failed' ? last.reason : undefined;
}

describe('telemetry stages', () => {
	it('emits source, binarised, finders, located, sampled, corrected, decoded, in order', () => {
		const stages = collect(render(PAYLOAD)).map((frame) => frame.stage);

		expect(stages[0]).toBe('source');
		expect(stages[stages.length - 1]).toBe('decoded');
		// Every stage present, and no stage before the one it depends on.
		for (const [earlier, later] of [
			['source', 'binarised'],
			['binarised', 'finders'],
			['finders', 'located'],
			['located', 'sampled'],
			['sampled', 'corrected'],
			['corrected', 'decoded'],
		] as const) {
			expect(stages, `${earlier} before ${later}`).toContain(earlier);
			expect(stages.indexOf(earlier)).toBeLessThan(stages.indexOf(later));
		}
	});

	it('ends with a failed frame carrying a reason, whatever went wrong', () => {
		for (const image of [flat(200, 200, 255), noise(flat(200, 200, 128), 127, 3)]) {
			const frames = collect(image);
			const last = frames[frames.length - 1];

			expect(last?.stage).toBe('failed');
			expect(typeof reasonOf(frames)).toBe('string');
		}
	});

	it('reports the source frame at the size it was handed, not the working size', () => {
		// The website maps every other frame back through this, so it has to stay
		// in original pixels however much the decoder reduced internally.
		const image = pad(render(PAYLOAD, 4), 60);
		const source = collect(image).find((frame) => frame.stage === 'source');

		expect(source?.stage === 'source' && [source.width, source.height]).toEqual([
			image.width,
			image.height,
		]);
	});

	it('keeps the transform at nine coefficients that rebuild the reported corners', () => {
		const located = collect(render(PAYLOAD)).find((frame) => frame.stage === 'located');
		expect(located?.stage).toBe('located');
		if (located?.stage !== 'located') {
			return;
		}

		expect(located.transform).toHaveLength(9);
		expect(located.corners).toHaveLength(4);

		const [a11, a21, a31, a12, a22, a32, a13, a23, a33] = located.transform as number[];
		const denominator = a33 as number;
		expect((a31 as number) / denominator).toBeCloseTo(located.corners[0].x, 3);
		expect((a32 as number) / denominator).toBeCloseTo(located.corners[0].y, 3);
		expect([a11, a21, a12, a22, a13, a23].every((value) => Number.isFinite(value))).toBe(true);
	});

	it('reports the sampled grid as one byte per module', () => {
		const sampled = collect(render(PAYLOAD)).find((frame) => frame.stage === 'sampled');
		expect(sampled?.stage === 'sampled' && sampled.modules.length).toBe(
			sampled?.stage === 'sampled' ? sampled.dimension ** 2 : 0,
		);
	});
});

describe('the binarised frame', () => {
	it('declares a size that matches the bitmap it carries', () => {
		const binarised = collect(render(PAYLOAD)).find((frame) => frame.stage === 'binarised');

		expect(binarised?.stage).toBe('binarised');
		if (binarised?.stage !== 'binarised') {
			return;
		}
		expect(binarised.bits.length).toBe(binarised.width * binarised.height);
	});

	it('stays inside the pixel ceiling even for a working image at the cap', () => {
		// A four megapixel working image would otherwise hand a consumer a 4 MB
		// array to turn into a 16 MB ImageData on the main thread, for a picture
		// nobody can see the detail in.
		const wide = flat(2400, 1800, 200);
		const binarised = collect(wide).find((frame) => frame.stage === 'binarised');

		expect(binarised?.stage).toBe('binarised');
		if (binarised?.stage !== 'binarised') {
			return;
		}
		expect(wide.width * wide.height).toBeGreaterThan(BINARISED_TELEMETRY_PIXELS);
		expect(binarised.width * binarised.height).toBeLessThanOrEqual(BINARISED_TELEMETRY_PIXELS);
		expect(binarised.bits.length).toBe(binarised.width * binarised.height);
	});

	it('is not decimated when it already fits', () => {
		const image = render(PAYLOAD, 6);
		const binarised = collect(image).find((frame) => frame.stage === 'binarised');

		expect(binarised?.stage === 'binarised' && binarised.width).toBe(image.width);
	});
});

describe('failure reasons tell the truth', () => {
	it('says no-finders for a blank image', () => {
		expect(reasonOf(collect(flat(200, 200, 255)))).toBe('no-finders');
	});

	it('says partial-finders when a corner has been cropped away', () => {
		// The one diagnosis a person can act on directly, so it must survive.
		const image = render(PAYLOAD, 8);
		const cropped: ImageDataLike = {
			data: new Uint8ClampedArray(image.data.subarray(0, image.width * 4 * (image.height - 40))),
			width: image.width,
			height: image.height - 40,
		};
		const half: ImageDataLike = {
			data: new Uint8ClampedArray(
				cropped.data.subarray(0, cropped.width * 4 * Math.floor(cropped.height / 2)),
			),
			width: cropped.width,
			height: Math.floor(cropped.height / 2),
		};

		expect(reasonOf(collect(half))).toBe('partial-finders');
	});

	it('says geometry when the markers were found and no grid would fit', () => {
		// The failure the tool was actually shipping, mislabelled as a checksum
		// failure: the modules are legible, the grid is in the wrong place, and
		// "hold the camera square on" is the useful thing to say. Sixty-two degrees
		// of yaw is past what any of this can read, which is the point: the markers
		// are still found and no grid fits.
		const image = blur(place(render(PAYLOAD, 6), { yaw: 62, fill: 0.9 }).image, 1);

		expect(reasonOf(collect(image, { timeBudgetMs: 3000 }))).toBe('geometry');
	});

	it('says checksum when the grid fitted and the modules were genuinely lost', () => {
		// The other half of the same distinction. Here the finders, the timing
		// patterns and the format information are all intact, so the grid lands
		// exactly where it should and the data underneath is past repairing, which
		// is the only case where "retake the photograph" is the right advice.
		const image = render(PAYLOAD, 6);
		const random = seededRandom(7);
		const scale = 6;
		const quiet = 4;
		for (let y = Math.round((quiet + 20) * scale); y < image.height - quiet * scale; y += 1) {
			for (let x = Math.round((quiet + 20) * scale); x < image.width - quiet * scale; x += 1) {
				const value = random() < 0.5 ? 0 : 255;
				const offset = (y * image.width + x) * 4;
				image.data[offset] = value;
				image.data[offset + 1] = value;
				image.data[offset + 2] = value;
			}
		}

		expect(reasonOf(collect(image, { timeBudgetMs: 3000 }))).toBe('checksum');
	});
});
