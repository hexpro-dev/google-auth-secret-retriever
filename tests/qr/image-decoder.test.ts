import { describe, expect, it } from 'vitest';
import { decodeQrFromImageData } from '../../src/qr/decode/decoder.js';
import type { DecodeFrame } from '../../src/qr/decode/telemetry.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import { renderQrImageData } from '../../src/qr/encode/render.js';
import type { ImageDataLike } from '../../src/types.js';
import { expectErr, expectOk } from '../helpers/expect-result.js';
import {
	blur,
	glare,
	gradient,
	invert,
	mirror,
	noise,
	pad,
	perspective,
	rotate,
	rotateQuarter,
} from '../helpers/image.js';

/**
 * The image pipeline, tested against degraded renders rather than clean ones.
 *
 * A decoder that only reads its own pristine output is not evidence of
 * anything: the hard part of this job is a photograph of a phone screen, not a
 * bitmap. So every case here damages the image in a way a real upload plausibly
 * would, and all of it is deterministic.
 */

const PAYLOAD =
	'otpauth-migration://offline?data=CksKCs%2FSZTJhqIO%2BKYASI2FsaWNlQGV4YW1wbGUuY29tGhJhdXRoLmV4YW1wbGUudGVzdCABKAEwAgojChTxZXW8hBpXh2dAiI4YopDgCtgLhRIFQTQwNDMgASgBMAIQAhgBIAA';

function render(text: string, scale = 6): ImageDataLike {
	return renderQrImageData(encodeQr(text, { ecLevel: 'M' }), { scale, quietZone: 4 });
}

describe('decodeQrFromImageData on clean renders', () => {
	it('reads a plain symbol', () => {
		const result = expectOk(decodeQrFromImageData(render(PAYLOAD)));

		expect(result.text).toBe(PAYLOAD);
		expect(result.errorsCorrected).toBe(0);
		// The first rung should be enough for something this clean.
		expect(result.attempt.attempt).toBe(1);
	});

	it.each([2, 3, 4, 6, 8, 12])('reads a symbol at %i pixels per module', (scale) => {
		expect(expectOk(decodeQrFromImageData(render(PAYLOAD, scale))).text).toBe(PAYLOAD);
	});

	it('reads every error-correction level', () => {
		for (const ecLevel of ['L', 'M', 'Q', 'H'] as const) {
			const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel }), { scale: 6 });
			const result = expectOk(decodeQrFromImageData(image));

			expect(result.text, ecLevel).toBe(PAYLOAD);
			expect(result.ecLevel).toBe(ecLevel);
		}
	});

	it('reads a range of versions', () => {
		for (const length of [8, 40, 120, 300, 700]) {
			const text = 'A1b2C3d4'.repeat(Math.ceil(length / 8)).slice(0, length);
			const image = renderQrImageData(encodeQr(text, { ecLevel: 'M' }), { scale: 5 });

			expect(expectOk(decodeQrFromImageData(image)).text, `length ${length}`).toBe(text);
		}
	});

	it('reads a symbol sitting in a much larger screenshot', () => {
		const image = pad(render(PAYLOAD, 5), 300);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});
});

describe('decodeQrFromImageData on degraded images', () => {
	it.each([1, 2, 3])('reads a symbol rotated by %i quarter turns', (turns) => {
		// Rotation is handled by the geometry of finder ordering, not as a
		// special case, so all four orientations go through one code path.
		const image = rotateQuarter(render(PAYLOAD), turns);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it.each([5, 12, 33, 47])('reads a symbol rotated by %i degrees', (degrees) => {
		const image = rotate(pad(render(PAYLOAD, 8), 40), degrees);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a mirrored symbol', () => {
		// A photo of a reflection, or a front-facing camera.
		const image = mirror(render(PAYLOAD));
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a dark-mode screenshot', () => {
		const image = invert(render(PAYLOAD));
		const result = expectOk(decodeQrFromImageData(image));

		expect(result.text).toBe(PAYLOAD);
		expect(result.attempt.inverted).toBe(true);
	});

	it('reads a symbol under a brightness gradient', () => {
		// The case a single global threshold cannot handle, and the reason the
		// first rung is a local binariser.
		const image = gradient(render(PAYLOAD, 8), 110);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a slightly out-of-focus symbol', () => {
		const image = blur(render(PAYLOAD, 8), 2);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a noisy capture', () => {
		const image = noise(render(PAYLOAD, 8), 45, 7);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a symbol photographed off-axis', () => {
		const image = perspective(pad(render(PAYLOAD, 8), 30), 0.22);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a symbol with glare across it', () => {
		const image = glare(render(PAYLOAD, 8), 120);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});

	it('reads a photograph with several problems at once', () => {
		// Roughly what a hurried photo of a laptop screen looks like.
		const image = noise(
			blur(gradient(perspective(pad(render(PAYLOAD, 9), 40), 0.15), 70), 1),
			20,
			11,
		);
		expect(expectOk(decodeQrFromImageData(image)).text).toBe(PAYLOAD);
	});
});

describe('decodeQrFromImageData failures', () => {
	function flat(width: number, height: number, value: number): ImageDataLike {
		const data = new Uint8ClampedArray(width * height * 4);
		data.fill(value);
		for (let i = 3; i < data.length; i += 4) {
			data[i] = 255;
		}
		return { data, width, height };
	}

	it('reports no QR code for a blank white image', () => {
		expect(expectErr(decodeQrFromImageData(flat(200, 200, 255))).code).toBe('qr/not-found');
	});

	it('reports no QR code for a blank black image', () => {
		expect(expectErr(decodeQrFromImageData(flat(200, 200, 0))).code).toBe('qr/not-found');
	});

	it('reports no QR code for random noise', () => {
		const image = noise(flat(200, 200, 128), 127, 3);
		expect(expectErr(decodeQrFromImageData(image)).code).toBe('qr/not-found');
	});

	it('returns a Result rather than throwing', () => {
		expect(() => decodeQrFromImageData(flat(64, 64, 200))).not.toThrow();
	});

	it('stops when the time budget is spent', () => {
		// A frozen clock that jumps past the budget on its second reading.
		let calls = 0;
		const now = () => (calls++ === 0 ? 0 : 10_000);
		const image = noise(flat(300, 300, 128), 127, 5);

		const result = decodeQrFromImageData(image, { now, timeBudgetMs: 50 });
		expect(result.ok).toBe(false);
	});
});

describe('decode telemetry', () => {
	it('emits the pipeline stages in order for a successful decode', () => {
		const frames: DecodeFrame[] = [];
		decodeQrFromImageData(render(PAYLOAD), { onTelemetry: (frame) => frames.push(frame) });

		const stages = frames.map((frame) => frame.stage);
		expect(stages[0]).toBe('source');
		expect(stages).toContain('binarised');
		expect(stages).toContain('finders');
		expect(stages).toContain('located');
		expect(stages).toContain('sampled');
		expect(stages).toContain('corrected');
		expect(stages[stages.length - 1]).toBe('decoded');
	});

	it('reports the three finder patterns with their positions', () => {
		const frames: DecodeFrame[] = [];
		decodeQrFromImageData(render(PAYLOAD), { onTelemetry: (frame) => frames.push(frame) });

		const finders = frames.find((frame) => frame.stage === 'finders');
		expect(finders).toBeDefined();
		expect(finders!.stage === 'finders' && finders!.patterns.length).toBe(3);
	});

	it('reports a transform that can be reconstructed by a consumer', () => {
		// The contract the website's overlay depends on: the coefficients cross
		// a worker boundary as numbers and rebuild into the same mapping.
		const frames: DecodeFrame[] = [];
		decodeQrFromImageData(render(PAYLOAD), { onTelemetry: (frame) => frames.push(frame) });

		const located = frames.find((frame) => frame.stage === 'located');
		expect(located).toBeDefined();
		if (located?.stage !== 'located') {
			return;
		}

		expect(located.transform).toHaveLength(9);
		expect(located.corners).toHaveLength(4);
		expect(located.dimension).toBeGreaterThanOrEqual(21);

		const [a11, a21, a31, a12, a22, a32, a13, a23, a33] = located.transform as number[];
		const applyAt = (x: number, y: number) => {
			const d = a13! * x + a23! * y + a33!;
			return { x: (a11! * x + a21! * y + a31!) / d, y: (a12! * x + a22! * y + a32!) / d };
		};

		// The reconstructed mapping should place the symbol's origin at the
		// first reported corner.
		const origin = applyAt(0, 0);
		expect(origin.x).toBeCloseTo(located.corners[0].x, 3);
		expect(origin.y).toBeCloseTo(located.corners[0].y, 3);
	});

	it('reports where it stopped when a decode fails', () => {
		const frames: DecodeFrame[] = [];
		const data = new Uint8ClampedArray(200 * 200 * 4);
		data.fill(255);
		decodeQrFromImageData(
			{ data, width: 200, height: 200 },
			{ onTelemetry: (frame) => frames.push(frame) },
		);

		const last = frames[frames.length - 1];
		expect(last?.stage).toBe('failed');
		expect(last?.stage === 'failed' && last.reason).toBe('no-finders');
	});
});
