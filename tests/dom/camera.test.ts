import { afterEach, describe, expect, it, vi } from 'vitest';
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

interface FakeTrack extends MediaStreamTrack {
	stopped: boolean;
	fire(event: string): void;
}

function fakeTrack(settings: MediaTrackSettings = { width: 1920, height: 1080 }): FakeTrack {
	const listeners = new Map<string, Set<() => void>>();

	return {
		stopped: false,
		stop() {
			(this as { stopped: boolean }).stopped = true;
		},
		getSettings: () => settings,
		addEventListener(event: string, listener: () => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
		},
		removeEventListener(event: string, listener: () => void) {
			listeners.get(event)?.delete(listener);
		},
		fire(event: string) {
			for (const listener of listeners.get(event) ?? []) {
				listener();
			}
		},
	} as unknown as FakeTrack;
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

/** Just enough of `document` for the default visibility wiring. */
function fakeDocument(): {
	visibilityState: string;
	readonly listeners: number;
	addEventListener(type: string, handler: () => void): void;
	removeEventListener(type: string, handler: () => void): void;
	fire(): void;
} {
	const handlers = new Set<() => void>();

	return {
		visibilityState: 'visible',
		get listeners() {
			return handlers.size;
		},
		addEventListener(type: string, handler: () => void) {
			if (type === 'visibilitychange') {
				handlers.add(handler);
			}
		},
		removeEventListener(_type: string, handler: () => void) {
			handlers.delete(handler);
		},
		fire() {
			for (const handler of [...handlers]) {
				handler();
			}
		},
	};
}

function blankCanvas(): () => CanvasLike {
	const data = new Uint8ClampedArray(200 * 200 * 4);
	data.fill(255);
	return scanningCanvas({ data, width: 200, height: 200 });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('isCameraAvailable', () => {
	it('needs both a secure context and the API', () => {
		const getUserMedia = (async () => fakeStream([])) as CameraDeps['getUserMedia'];

		expect(isCameraAvailable({ isSecureContext: true, getUserMedia })).toBe(true);
		expect(isCameraAvailable({ isSecureContext: false, getUserMedia })).toBe(false);
		expect(isCameraAvailable({ isSecureContext: true })).toBe(false);
	});

	it('reads the page it is running in when nothing is injected', () => {
		// What a consumer calls. Answering from injected deps only would leave the
		// real reading untested, and this is the answer a page uses to decide
		// whether to offer the camera button at all.
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: async () => fakeStream([]) },
		});
		expect(isCameraAvailable()).toBe(true);

		// A browser old enough to have no mediaDevices, which is the case the
		// button has to be hidden for.
		vi.stubGlobal('navigator', {});
		expect(isCameraAvailable()).toBe(false);
	});

	it('answers false where there is no page to ask', () => {
		// Server-side rendering, where `isSecureContext` does not exist. A camera
		// button rendered there is a button that cannot work.
		expect(isCameraAvailable()).toBe(false);
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

	it('reports the request ending when the camera will not open', async () => {
		// A caller showing a spinner on `requesting` would spin forever otherwise,
		// even though it is about to be handed the error.
		const states: string[] = [];

		await expect(
			startCameraScan({
				video: fakeVideo(),
				onResult: () => undefined,
				onStatus: (status) => states.push(status.state),
				deps: {
					isSecureContext: true,
					getUserMedia: async () => {
						const error = new Error('NotAllowedError');
						error.name = 'NotAllowedError';
						throw error;
					},
				},
			}),
		).rejects.toBeInstanceOf(CameraPermissionError);

		expect(states).toEqual(['requesting', 'stopped']);
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

describe('startCameraScan constraints', () => {
	it('asks for a full-resolution frame with soft constraints only', async () => {
		// `ideal` cannot overconstrain, so a 720p webcam simply returns 720p, while
		// the default on most engines is 640 by 480, at which a ten-account export
		// is below Nyquist however close the phone is held. `facingMode` stays a
		// bare value, which is also an ideal: `{ exact: 'environment' }` fails
		// outright on a laptop with only a front camera.
		const asked: MediaStreamConstraints[] = [];
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deps: {
				isSecureContext: true,
				getUserMedia: async (constraints) => {
					asked.push(constraints);
					return fakeStream([fakeTrack()]);
				},
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});
		handle.stop();

		const video = asked[0]?.video as Record<string, unknown>;
		expect(video.width).toEqual({ ideal: 1920 });
		expect(video.height).toEqual({ ideal: 1080 });
		expect(video.resizeMode).toBe('none');
		expect(video.facingMode).toBe('environment');
		expect(video.advanced).toEqual([{ focusMode: 'continuous' }]);
	});

	it('asks for one exact camera when a deviceId is given', async () => {
		// The point of listCameras is letting somebody pick the back camera on a
		// phone that reports three. An ideal deviceId would let the engine hand back
		// whichever camera it preferred instead, and nothing would say so.
		const asked: MediaStreamConstraints[] = [];
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deviceId: 'back-camera',
			deps: {
				isSecureContext: true,
				getUserMedia: async (constraints) => {
					asked.push(constraints);
					return fakeStream([fakeTrack()]);
				},
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});
		handle.stop();

		const video = asked[0]?.video as Record<string, unknown>;
		expect(video.deviceId).toEqual({ exact: 'back-camera' });
		expect(video.facingMode).toBeUndefined();
		expect(video.width).toEqual({ ideal: 1920 });
	});

	it('retries once, relaxed, before calling it a constraints failure', async () => {
		// Today a constraints failure reaches a caller as "no camera on this
		// device", which is both wrong and unactionable.
		let calls = 0;
		const track = fakeTrack();
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deps: {
				isSecureContext: true,
				getUserMedia: async (constraints) => {
					calls += 1;
					if (constraints.video !== true) {
						const error = new Error('OverconstrainedError');
						error.name = 'OverconstrainedError';
						throw error;
					}
					return fakeStream([track]);
				},
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});

		expect(calls).toBe(2);
		expect(handle.stopped).toBe(false);
		handle.stop();
	});

	it('gives up with a constraints error when even the relaxed ask fails', async () => {
		let calls = 0;
		await expect(
			startCameraScan({
				video: fakeVideo(),
				onResult: () => undefined,
				deps: {
					isSecureContext: true,
					getUserMedia: async () => {
						calls += 1;
						const error = new Error('OverconstrainedError');
						error.name = 'OverconstrainedError';
						throw error;
					},
				},
			}),
		).rejects.toMatchObject({ code: 'camera/unavailable', reason: 'constraints' });

		expect(calls).toBe(2);
	});

	it('reports what the camera actually gave, not what was asked for', async () => {
		// Asking for 1080p is a soft constraint, so a 640 by 480 webcam returns 640
		// by 480 and nothing says so unless this does.
		const statuses: Array<{ state: string; settings?: MediaTrackSettings }> = [];
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onStatus: (status) =>
				statuses.push(status as { state: string; settings?: MediaTrackSettings }),
			deps: {
				isSecureContext: true,
				getUserMedia: async () => fakeStream([fakeTrack({ width: 640, height: 480 })]),
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});
		handle.stop();

		expect(statuses.find((status) => status.state === 'live')?.settings).toEqual({
			width: 640,
			height: 480,
		});
	});

	it('goes live without settings where the track cannot describe itself', async () => {
		// getSettings is missing on some older engines, where calling it would throw
		// a TypeError the instant the camera came up.
		const bare = { stop: () => undefined } as unknown as MediaStreamTrack;
		const statuses: Array<{ state: string; settings?: MediaTrackSettings }> = [];

		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onStatus: (status) =>
				statuses.push(status as { state: string; settings?: MediaTrackSettings }),
			deps: {
				isSecureContext: true,
				getUserMedia: async () => fakeStream([bare]),
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});
		handle.stop();

		const live = statuses.find((status) => status.state === 'live');
		expect(live).toBeDefined();
		expect(live?.settings).toBeUndefined();
	});
});

describe('startCameraScan lifecycle', () => {
	function harness(canvas: () => CanvasLike, options: { decodeCostMs?: number } = {}) {
		const track = fakeTrack();
		const frames: Array<() => void> = [];
		let clock = 0;
		let decodes = 0;

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
			/**
			 * Charge a decode to the clock, so pacing can be tested.
			 *
			 * The sink fires once per decode, from inside it, which is the only hook
			 * that can make a fake decode cost fake time.
			 */
			onTelemetry: (frame: { stage: string }) => {
				if (frame.stage === 'source') {
					decodes += 1;
					clock += options.decodeCostMs ?? 0;
				}
			},
			get decodes() {
				return decodes;
			},
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

	it('wires itself to the page visibility event when no listener is injected', async () => {
		// The path a consumer gets, since nobody injects this. Coming back to the
		// tab fires the same event as leaving it, so a listener that stopped on
		// every change would kill the scan the moment it was looked at.
		const doc = fakeDocument();
		vi.stubGlobal('document', doc);
		const { track, deps } = harness(blankCanvas());

		const handle = await startCameraScan({ video: fakeVideo(), onResult: () => undefined, deps });
		expect(doc.listeners).toBe(1);

		doc.fire();
		expect(track.stopped).toBe(false);

		doc.visibilityState = 'hidden';
		doc.fire();
		expect(track.stopped).toBe(true);
		expect(handle.stopped).toBe(true);

		// And the listener goes with it, rather than outliving the scan on a page
		// that opens the camera more than once.
		expect(doc.listeners).toBe(0);
	});

	it('rides out the first frames, before the video has dimensions', async () => {
		// play() resolves before the first frame arrives, so videoWidth is 0 for a
		// beat. Letting that end the scan would break the camera on exactly the
		// devices that take longest to hand a frame over.
		const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel: 'M' }), { scale: 4 });
		const { deps, tick } = harness(scanningCanvas(image));
		const onResult = vi.fn();
		const video = { srcObject: null, videoWidth: 0, videoHeight: 0, play: async () => undefined };

		const handle = await startCameraScan({ video, onResult, deps });
		tick();
		expect(onResult).not.toHaveBeenCalled();

		video.videoWidth = 200;
		video.videoHeight = 200;
		tick();
		handle.stop();

		expect(onResult).toHaveBeenCalled();
	});

	it('keeps scanning when the browser refuses to autoplay the preview', async () => {
		// Autoplay refusal leaves the stream live and the track running, and the
		// caller's markup carries `playsinline muted`. Failing here would turn a
		// cosmetic refusal into no scan at all.
		const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel: 'M' }), { scale: 4 });
		const { deps, tick } = harness(scanningCanvas(image));
		const onResult = vi.fn();
		const video: VideoLike = {
			srcObject: null,
			videoWidth: 200,
			videoHeight: 200,
			play: async () => {
				const error = new Error('NotAllowedError');
				error.name = 'NotAllowedError';
				throw error;
			},
		};

		const handle = await startCameraScan({ video, onResult, deps });
		tick();
		handle.stop();

		expect(onResult).toHaveBeenCalled();
	});

	it('ignores a frame that was already scheduled when stop ran', async () => {
		// stop cancels the pending frame, but the callback can already be in flight.
		// Without the guard it grabs another frame off a camera that is meant to be
		// off, and re-arms the loop behind stop's back.
		const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel: 'M' }), { scale: 4 });
		const { deps, tick } = harness(scanningCanvas(image));
		const onResult = vi.fn();

		const handle = await startCameraScan({ video: fakeVideo(), onResult, deps });
		handle.stop();
		tick();
		tick();

		expect(onResult).not.toHaveBeenCalled();
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

	it('stops when the track ends under it', async () => {
		// Unplug a webcam, or let another application seize the camera, and the
		// stream dies while videoWidth may stay non-zero. Without this the loop
		// keeps decoding one frozen frame and the interface keeps saying "looking".
		const { track, deps } = harness(blankCanvas());
		const handle = await startCameraScan({ video: fakeVideo(), onResult: () => undefined, deps });

		track.fire('ended');
		expect(handle.stopped).toBe(true);
		expect(track.stopped).toBe(true);
	});

	/**
	 * Two starts in flight at once, the second winning, the first settling later.
	 *
	 * A re-render or a double tap does exactly this. The returned pair is
	 * `[superseded, live]` in the order a caller receives them, which is the wrong
	 * way round for anything that keeps one handle.
	 */
	async function racedStarts(options: { onStatus?: (state: string) => void } = {}) {
		const first = fakeTrack();
		const second = fakeTrack();
		let release = (): void => undefined;

		const slow = startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onStatus: (status) => options.onStatus?.(status.state),
			deps: {
				isSecureContext: true,
				getUserMedia: () =>
					new Promise((resolve) => {
						release = () => resolve(fakeStream([first]));
					}),
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});

		const live = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deps: {
				isSecureContext: true,
				getUserMedia: async () => fakeStream([second]),
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});

		release();
		const superseded = await slow;

		return { first, second, superseded, live };
	}

	it('stops a stream that arrives after a later scan has superseded it', async () => {
		// A re-render or a double tap opens the camera twice. The first stream then
		// resolves with no handle in anybody's hands, and the indicator stays lit.
		const { first, second, superseded, live } = await racedStarts();

		expect(first.stopped).toBe(true);
		expect(superseded.stopped).toBe(true);
		expect(second.stopped).toBe(false);
		live.stop();
	});

	it('marks a superseded start rather than passing off a dead handle as live', async () => {
		// The failure this prevents: a caller keeps one handle, the superseded start
		// settles second, its no-op handle overwrites the live one, and from then on
		// nothing can stop the camera. The indicator stays lit for the life of the
		// page on a tool whose whole claim is that nothing leaves the device.
		const { second, superseded, live } = await racedStarts();

		expect(superseded.superseded).toBe(true);
		expect(live.superseded).toBe(false);

		// What a caller that respects the flag does, and what happens if it does not.
		expect(superseded.stopped).toBe(true);
		superseded.stop();
		expect(second.stopped).toBe(false);

		live.stop();
		expect(second.stopped).toBe(true);
	});

	it('marks a start superseded during the play() await, not only during getUserMedia', async () => {
		// The window this closes. The loser passes the generation check after
		// getUserMedia, then waits on play() while a later start wins. It used to come
		// back reporting `superseded: false` alongside the real winner, so two streams
		// were open, both handles claimed to be the live one, and whichever a caller
		// stored last left the other running with nothing able to stop it.
		const first = fakeTrack();
		const second = fakeTrack();
		let releasePlay = (): void => undefined;

		const stalling: VideoLike = {
			srcObject: null,
			videoWidth: 200,
			videoHeight: 200,
			play: () =>
				new Promise((resolve) => {
					releasePlay = () => resolve();
				}),
		};

		const slow = startCameraScan({
			video: stalling,
			onResult: () => undefined,
			deps: {
				isSecureContext: true,
				getUserMedia: async () => fakeStream([first]),
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});

		// Let the first start clear getUserMedia and settle inside play().
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
		expect(stalling.srcObject).not.toBe(null);

		const live = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deps: {
				isSecureContext: true,
				getUserMedia: async () => fakeStream([second]),
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});

		releasePlay();
		const superseded = await slow;

		expect(superseded.superseded).toBe(true);
		expect(first.stopped).toBe(true);
		expect(second.stopped).toBe(false);
		// And it does not leave its own dead stream attached to the element.
		expect(stalling.srcObject).toBe(null);

		// Its stop is inert too, so a caller that stores the loser and calls stop on
		// it cannot take the winner's camera down instead.
		superseded.stop();
		expect(second.stopped).toBe(false);

		live.stop();
		expect(second.stopped).toBe(true);
	});

	it('emits no status from the superseded start', async () => {
		// The status is what tells a caller the camera went live. A `stopped` from
		// the loser would arrive after the winner's `live` and describe a camera that
		// is running.
		const states: string[] = [];
		const { live } = await racedStarts({ onStatus: (state) => states.push(state) });

		expect(states).toEqual(['requesting']);
		live.stop();
	});
});

describe('startCameraScan pacing', () => {
	function pacing(decodeCostMs: number) {
		const blank = new Uint8ClampedArray(200 * 200 * 4);
		blank.fill(255);
		const canvas = scanningCanvas({ data: blank, width: 200, height: 200 });
		const frames: Array<() => void> = [];
		let clock = 0;
		let decodes = 0;

		const deps: CameraDeps = {
			isSecureContext: true,
			getUserMedia: async () => fakeStream([fakeTrack()]),
			requestFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
			cancelFrame: () => undefined,
			now: () => clock,
			createCanvas: canvas,
		};

		return {
			deps,
			onTelemetry: (frame: { stage: string }) => {
				if (frame.stage === 'source') {
					decodes += 1;
					clock += decodeCostMs;
				}
			},
			get decodes() {
				return decodes;
			},
			/** Decodes per second of simulated time, which is the thing that matters. */
			get rate() {
				return decodes / (clock / 1000);
			},
			/**
			 * Fraction of simulated time spent inside a decode.
			 *
			 * The number the preview lives or dies by. A fixed idle interval bounds
			 * the wrong thing: it bounds the gap, so as decodes get slower the
			 * decoder's share of the thread climbs towards one.
			 */
			get occupancy() {
				return (decodes * decodeCostMs) / clock;
			},
			/** One animation frame, at a display refresh of 60 Hz. */
			frame() {
				clock += 16;
				const pending = frames.splice(0, frames.length);
				for (const callback of pending) {
					callback();
				}
			},
		};
	}

	it('leaves a slow device about half its thread', async () => {
		// The gap after a decode is at least as long as the decode was, so a device
		// that takes 300 ms an attempt gets 300 ms to paint in. A fixed 67 ms gap
		// would have left it 18% of the thread and the preview visibly stutters
		// there, on exactly the devices this work is for.
		const rig = pacing(300);
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onTelemetry: rig.onTelemetry,
			deps: rig.deps,
		});

		for (let i = 0; i < 120; i += 1) {
			rig.frame();
		}
		handle.stop();

		expect(rig.occupancy).toBeLessThan(0.55);
		// And it must still be trying: half of 300 ms is 1.67 attempts a second.
		expect(rig.rate).toBeGreaterThan(1.4);
		expect(rig.rate).toBeLessThan(1.9);
	});

	it('caps occupancy however slow the device is', async () => {
		// The property, not one example of it. A phone three to five times slower
		// than this machine used to hand the decoder 85 to 91% of the thread; the
		// bound has to hold across that whole range rather than at one decode cost.
		for (const cost of [50, 100, 200, 400, 800]) {
			const rig = pacing(cost);
			const handle = await startCameraScan({
				video: fakeVideo(),
				onResult: () => undefined,
				onTelemetry: rig.onTelemetry,
				deps: rig.deps,
			});

			for (let i = 0; i < 200; i += 1) {
				rig.frame();
			}
			handle.stop();

			expect(rig.occupancy).toBeLessThan(0.55);
			expect(rig.decodes).toBeGreaterThan(0);
		}
	});

	it('caps a fast decode at the requested rate', async () => {
		const rig = pacing(1);
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onTelemetry: rig.onTelemetry,
			scansPerSecond: 10,
			deps: rig.deps,
		});

		for (let i = 0; i < 120; i += 1) {
			rig.frame();
		}
		handle.stop();

		expect(rig.rate).toBeLessThan(11);
		expect(rig.rate).toBeGreaterThan(8);
	});

	it('never latches off', async () => {
		// A frame-counted decay could stall the loop for hundreds of milliseconds
		// after one slow decode, and at 30 Hz it stalled for twice as long. The
		// proportional gap is bounded in both directions: half a second of work per
		// attempt still leaves about one attempt a second, and the rate must not sag
		// over time, which a decay would make it do.
		const rig = pacing(500);
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onTelemetry: rig.onTelemetry,
			deps: rig.deps,
		});

		for (let i = 0; i < 200; i += 1) {
			rig.frame();
		}
		handle.stop();

		expect(rig.decodes).toBeGreaterThan(4);
		expect(rig.rate).toBeGreaterThan(0.9);
	});

	it('spends five rungs on a frame by default', async () => {
		// What the camera can reach is what the camera can read. Five is both
		// polarities at full scale, both at half scale, and the global threshold:
		// measured on 32 dim scenes, those five won all 32 where the old front four
		// won 9. The upscale rung is last now, because it won none of them and costs
		// five to twelve times as much as any of these.
		const rig = pacing(0);
		const rungs: number[] = [];
		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onTelemetry: (frame) => {
				rig.onTelemetry(frame);
				if (frame.stage === 'finders') {
					rungs.push(1);
				}
			},
			deps: rig.deps,
		});

		rig.frame();
		handle.stop();

		expect(rig.decodes).toBe(1);
		expect(rungs).toHaveLength(5);
	});

	it('gives a frame a budget a slow device can finish a rung inside', async () => {
		// 250 ms, sized for a phone three to five times slower than this machine,
		// where the five cheap rungs cost 120 to 200 ms rather than 34. A 200 ms
		// frame still gets its rungs; a 300 ms one is over budget before the first.
		const slow = pacing(200);
		const reached: number[] = [];
		const first = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onTelemetry: (frame) => {
				slow.onTelemetry(frame);
				if (frame.stage === 'finders') {
					reached.push(1);
				}
			},
			deps: slow.deps,
		});
		slow.frame();
		first.stop();

		const overrun = pacing(300);
		const rungs: number[] = [];
		const second = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			onTelemetry: (frame) => {
				overrun.onTelemetry(frame);
				if (frame.stage === 'finders') {
					rungs.push(1);
				}
			},
			deps: overrun.deps,
		});
		overrun.frame();
		second.stop();

		expect(reached.length).toBeGreaterThan(0);
		expect(rungs).toHaveLength(0);
	});
});

describe('startCameraScan without injected dependencies', () => {
	it("opens the camera through the page's own mediaDevices", async () => {
		// Every other test here injects getUserMedia. A consumer injects nothing, so
		// this is the only cover on the path they actually take.
		const track = fakeTrack();
		const asked: MediaStreamConstraints[] = [];
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: async (constraints: MediaStreamConstraints) => {
					asked.push(constraints);
					return fakeStream([track]);
				},
			},
		});

		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult: () => undefined,
			deps: {
				requestFrame: () => 1,
				cancelFrame: () => undefined,
				createCanvas: blankCanvas(),
			},
		});
		handle.stop();

		expect(asked).toHaveLength(1);
		expect(track.stopped).toBe(true);
	});

	it("schedules on the page's own animation frames, and cancels the one it left", async () => {
		// The production path: no deps at all. The cancel is the point. A handle
		// left uncancelled is a pump that runs once more against a camera that has
		// already been stopped.
		const track = fakeTrack();
		const pumps: Array<() => void> = [];
		const cancelled: number[] = [];
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: async () => fakeStream([track]) },
		});
		vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
			pumps.push(callback);
			return pumps.length;
		});
		vi.stubGlobal('cancelAnimationFrame', (id: number) => {
			cancelled.push(id);
		});

		const handle = await startCameraScan({ video: fakeVideo(), onResult: () => undefined });
		expect(pumps).toHaveLength(1);

		handle.stop();
		expect(cancelled).toEqual([1]);
		expect(track.stopped).toBe(true);
	});

	it('says so plainly when the browser has no camera API at all', async () => {
		// A secure context on a browser too old for mediaDevices. The guard is here
		// as well as in isCameraAvailable, because a caller may not have asked.
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {});

		await expect(
			startCameraScan({ video: fakeVideo(), onResult: () => undefined }),
		).rejects.toMatchObject({ code: 'camera/unavailable', reason: 'no-api' });
	});

	it('drives the loop on a timer where there is no requestAnimationFrame', async () => {
		// A worker has none, and neither does a page that starts a scan before its
		// first paint. Real timers here, because the fallback and the default clock
		// are the things under test. Stop then has to cancel the pending timer: a
		// loop still grabbing frames after stop is the leak this file exists for.
		const image = renderQrImageData(encodeQr(PAYLOAD, { ecLevel: 'M' }), { scale: 4 });
		const track = fakeTrack();
		const onResult = vi.fn();

		const handle = await startCameraScan({
			video: fakeVideo(),
			onResult,
			deps: {
				isSecureContext: true,
				getUserMedia: async () => fakeStream([track]),
				createCanvas: scanningCanvas(image),
			},
		});

		for (let i = 0; i < 50 && onResult.mock.calls.length === 0; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		handle.stop();
		const decoded = onResult.mock.calls.length;

		expect(decoded).toBeGreaterThan(0);
		expect(track.stopped).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(onResult.mock.calls.length).toBe(decoded);
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

	it("enumerates through the page's own mediaDevices when nothing is injected", async () => {
		vi.stubGlobal('navigator', {
			mediaDevices: {
				enumerateDevices: async () =>
					[
						{ kind: 'videoinput', deviceId: 'a', label: 'Back' },
						{ kind: 'audiooutput', deviceId: 'b', label: 'Speaker' },
					] as MediaDeviceInfo[],
			},
		});

		expect(await listCameras()).toEqual([{ deviceId: 'a', label: 'Back' }]);
	});

	it('returns nothing when the API is absent rather than throwing', async () => {
		expect(await listCameras({})).toEqual([]);
	});
});
