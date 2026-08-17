import { describe, expect, it, vi } from 'vitest';
import {
	type CameraDeps,
	type VideoLike,
	isCameraAvailable,
	listCameras,
	startCameraScan,
} from '../../src/dom/camera.js';
import {
	CameraInUseError,
	CameraPermissionError,
	CameraUnavailableError,
} from '../../src/errors.js';
import type { CanvasLike } from '../../src/dom/image-source.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import { renderQrImageData } from '../../src/qr/encode/render.js';
import type { ImageDataLike } from '../../src/types.js';

/**
 * The camera loop, driven by fakes.
 *
 * The behaviour worth pinning is not the decoding, which is covered elsewhere.
 * It is that failures are told apart precisely, and that every track is stopped:
 * a camera indicator still lit after someone has scrolled away is a broken
 * promise on a tool whose whole claim is privacy.
 */

const PAYLOAD =
	'otpauth-migration://offline?data=CjEKCkhlbGxvIVdvcmxkEhVhbGljZUBleGFtcGxlLmNvbSABKAEwAhACGAEgAA';

function fakeTrack(): MediaStreamTrack & { stopped: boolean } {
	return {
		stopped: false,
		stop() {
			(this as { stopped: boolean }).stopped = true;
		},
	} as unknown as MediaStreamTrack & { stopped: boolean };
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
	return {
		getTracks: () => tracks,
		getVideoTracks: () => tracks,
	} as unknown as MediaStream;
}

function fakeVideo(): VideoLike {
	return {
		srcObject: null,
		videoWidth: 200,
		videoHeight: 200,
		play: async () => undefined,
	};
}

/** A canvas that always hands back a rendered QR code. */
function scanningCanvas(image: ImageDataLike): () => CanvasLike {
	return () => ({
		width: 0,
		height: 0,
		getContext: () => ({
			drawImage: () => undefined,
			getImageData: () => image,
		}),
	});
}

function blankCanvas(): () => CanvasLike {
	const data = new Uint8ClampedArray(200 * 200 * 4);
	data.fill(255);
	return scanningCanvas({ data, width: 200, height: 200 });
}

describe('isCameraAvailable', () => {
	it('needs both a secure context and the API', () => {
		const getUserMedia = (async () => fakeStream([])) as CameraDeps['getUserMedia'];

		expect(isCameraAvailable({ isSecureContext: true, getUserMedia })).toBe(true);
		expect(isCameraAvailable({ isSecureContext: false, getUserMedia })).toBe(false);
		expect(isCameraAvailable({ isSecureContext: true })).toBe(false);
	});
});

describe('startCameraScan failure mapping', () => {
	const cases: ReadonlyArray<readonly [name: string, expected: unknown]> = [
		['NotAllowedError', CameraPermissionError],
		['SecurityError', CameraPermissionError],
		['NotFoundError', CameraUnavailableError],
		['OverconstrainedError', CameraUnavailableError],
		['NotReadableError', CameraInUseError],
		['SomethingElse', CameraUnavailableError],
	];

	it.each(cases)('maps %s to the right error', async (name, expected) => {
		// Each of these needs its own sentence in the interface. "Camera
		// failed" tells a user nothing they can act on.
		const deps: CameraDeps = {
			isSecureContext: true,
			getUserMedia: async () => {
				const error = new Error(name);
				error.name = name;
				throw error;
			},
		};

		await expect(
			startCameraScan({ video: fakeVideo(), onResult: () => undefined, deps }),
		).rejects.toBeInstanceOf(expected as never);
	});

	it('distinguishes a denied camera from a missing one', async () => {
		const make = (name: string): CameraDeps => ({
			isSecureContext: true,
			getUserMedia: async () => {
				const error = new Error(name);
				error.name = name;
				throw error;
			},
		});

		await expect(
			startCameraScan({
				video: fakeVideo(),
				onResult: () => undefined,
				deps: make('NotAllowedError'),
			}),
		).rejects.toMatchObject({ code: 'camera/permission-denied' });

		await expect(
			startCameraScan({
				video: fakeVideo(),
				onResult: () => undefined,
				deps: make('NotFoundError'),
			}),
		).rejects.toMatchObject({ code: 'camera/unavailable', reason: 'no-device' });
	});

	it('refuses an insecure context before asking for permission', async () => {
		// No point triggering a prompt that cannot succeed.
		await expect(
			startCameraScan({
				video: fakeVideo(),
				onResult: () => undefined,
				deps: { isSecureContext: false },
			}),
		).rejects.toMatchObject({ reason: 'insecure-context' });
	});
});

describe('startCameraScan lifecycle', () => {
	function harness(canvas: () => CanvasLike) {
		const track = fakeTrack();
		const frames: Array<() => void> = [];
		let clock = 0;

		const deps: CameraDeps = {
			isSecureContext: true,
			getUserMedia: async () => fakeStream([track]),
			requestFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
			cancelFrame: () => undefined,
			now: () => clock,
			createCanvas: canvas,
		};

		return {
			track,
			deps,
			tick(byMs = 200) {
				clock += byMs;
				const pending = frames.splice(0, frames.length);
				for (const frame of pending) {
					frame();
				}
			},
		};
	}

	it('reports status as it starts and stops', async () => {
		const { deps, tick } = harness(blankCanvas());
		const statuses: string[] = [];

		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onStatus: (status) => statuses.push(status.state),
			deps,
		});

		tick();
		handle.stop();

		expect(statuses).toEqual(['requesting', 'live', 'stopped']);
	});

	it('stops every track, which is what turns the indicator off', async () => {
		const { track, deps } = harness(blankCanvas());

		const handle = await startCameraScan({ video: fakeVideo(), onResult: () => undefined, deps });
		expect(track.stopped).toBe(false);

		handle.stop();
		expect(track.stopped).toBe(true);
		expect(handle.stopped).toBe(true);
	});

	it('clears the video source on stop', async () => {
		const { deps } = harness(blankCanvas());
		const video = fakeVideo();

		const handle = await startCameraScan({ video, onResult: () => undefined, deps });
		expect(video.srcObject).not.toBeNull();

		handle.stop();
		expect(video.srcObject).toBeNull();
	});

	it('is safe to stop twice', async () => {
		const { deps } = harness(blankCanvas());
		const handle = await startCameraScan({ video: fakeVideo(), onResult: () => undefined, deps });

		handle.stop();
		expect(() => handle.stop()).not.toThrow();
	});

	it('stops when the tab is hidden', async () => {
		// Leaving the camera running behind a hidden tab is exactly the kind of
		// thing that makes a privacy claim ring hollow.
		const { track, deps } = harness(blankCanvas());
		let hide = (): void => undefined;

		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deps: {
				...deps,
				addVisibilityListener: (listener) => {
					hide = listener;
					return () => undefined;
				},
			},
		});

		hide();
		expect(track.stopped).toBe(true);
		expect(handle.stopped).toBe(true);
	});

	it('does not report frames that contain nothing', async () => {
		// This fires many times a second. A consumer re-rendering on "no code
		// here" would spend its whole budget on a message that says no.
		const { deps, tick } = harness(blankCanvas());
		const onResult = vi.fn();

		const handle = await startCameraScan({ video: fakeVideo(), onResult, deps });
		tick();
		tick();
		handle.stop();

		expect(onResult).not.toHaveBeenCalled();
	});

	it('reports a decoded code', async () => {
		const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel: 'M' }), { scale: 4 });
		const { deps, tick } = harness(scanningCanvas(image));
		const onResult = vi.fn();

		const handle = await startCameraScan({ video: fakeVideo(), onResult, deps });
		tick();
		handle.stop();

		expect(onResult).toHaveBeenCalled();
		const result = onResult.mock.calls[0]?.[0] as { ok: boolean; value: { text: string } };
		expect(result.ok).toBe(true);
		expect(result.value.text).toBe(PAYLOAD);
	});

	it('throttles decoding rather than running on every frame', async () => {
		const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel: 'M' }), { scale: 4 });
		const { deps, tick } = harness(scanningCanvas(image));
		const onResult = vi.fn();

		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult,
			scansPerSecond: 4,
			deps,
		});

		// Three frames only 10 ms apart: well inside one 250 ms interval.
		tick(10);
		tick(10);
		tick(10);
		handle.stop();

		expect(onResult.mock.calls.length).toBeLessThanOrEqual(1);
	});
});

describe('listCameras', () => {
	it('returns only video inputs', async () => {
		const devices = await listCameras({
			enumerateDevices: async () =>
				[
					{ kind: 'videoinput', deviceId: 'a', label: 'Back' },
					{ kind: 'audioinput', deviceId: 'b', label: 'Mic' },
					{ kind: 'videoinput', deviceId: 'c', label: 'Front' },
				] as MediaDeviceInfo[],
		});

		expect(devices).toEqual([
			{ deviceId: 'a', label: 'Back' },
			{ deviceId: 'c', label: 'Front' },
		]);
	});

	it('returns nothing when the API is absent rather than throwing', async () => {
		expect(await listCameras({})).toEqual([]);
	});
});
