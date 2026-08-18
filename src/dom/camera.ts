import {
	CameraInUseError,
	CameraPermissionError,
	CameraUnavailableError,
	RetrieverError,
} from '../errors.js';
import { decodeQrFromImageData } from '../qr/decode/decoder.js';
import type { QrDecodeSuccess } from '../qr/decode/decoder.js';
import type { TelemetrySink } from '../qr/decode/telemetry.js';
import type { Result } from '../result.js';
import type { ImageDataLike } from '../types.js';
import { type CanvasLike, imageDataFromVideo, releaseVideoCanvas } from './image-source.js';

/**
 * Scanning from the camera.
 *
 * Two things here are about trust rather than about decoding. The camera is
 * never opened without a click, so the permission prompt always follows an
 * intention; and every track is stopped on unmount, on tab hide, and on
 * `stop()`, because a camera indicator still lit after someone has scrolled
 * away is a broken promise on a tool whose entire claim is privacy.
 */

export interface CameraDevice {
	readonly deviceId: string;
	readonly label: string;
}

export type CameraStatus =
	| { readonly state: 'requesting' }
	| {
			readonly state: 'live';
			readonly track: MediaStreamTrack;
			/**
			 * What the browser actually gave us.
			 *
			 * Asking for 1920 by 1080 is a soft constraint, so a 640 by 480 webcam
			 * simply returns 640 by 480 and nothing says so, and a caller that wants to
			 * explain a poor scan rate has no other way to find out.
			 *
			 * Note that it is not the best signal for that, and a caller with telemetry
			 * should prefer it: the `source` frame carries the size the decoder actually
			 * worked on, which is what decides whether a symbol can be sampled, and the
			 * `finders` frame carries the module size measured in those same pixels.
			 */
			readonly settings?: MediaTrackSettings;
	  }
	| { readonly state: 'stopped' };

export interface CameraDeps {
	readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	readonly enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
	readonly requestFrame?: (callback: () => void) => number;
	readonly cancelFrame?: (handle: number) => void;
	readonly now?: () => number;
	readonly createCanvas?: (width: number, height: number) => CanvasLike;
	readonly isSecureContext?: boolean;
	readonly addVisibilityListener?: (listener: () => void) => () => void;
}

export interface VideoLike {
	// `MediaProvider` rather than `MediaStream`, because that is what
	// HTMLVideoElement actually declares and narrowing it here would force
	// every caller into a cast.
	srcObject: MediaProvider | null;
	readonly videoWidth: number;
	readonly videoHeight: number;
	play(): Promise<void>;
}

export interface CameraScanOptions {
	readonly video: VideoLike;
	readonly facingMode?: 'environment' | 'user';
	readonly deviceId?: string;
	/** Work ceiling for one frame, in pixels. Defaults to `MAX_CAMERA_PIXELS`. */
	readonly maxPixels?: number;
	/** Per-frame decode budget. */
	readonly frameBudgetMs?: number;
	/**
	 * Fastest the loop will attempt a decode, in attempts per second.
	 *
	 * A ceiling and not a target. The gap after a decode is at least as long as
	 * that decode took, so on a device where one attempt costs more than this
	 * interval the rate falls below it and the decoder is left holding about half
	 * the time rather than all of it. That is the half the preview is painted in.
	 */
	readonly scansPerSecond?: number;
	/**
	 * Ladder rungs per frame.
	 *
	 * The camera takes the front of the ladder and nothing else, so this decides
	 * which guesses it can make at all. Five reaches both polarities at full
	 * scale, both at half scale, and the global threshold, which between them won
	 * every one of the 32 dim scenes this was tuned against. See `LADDER`.
	 */
	readonly maxAttempts?: number;
	readonly onResult: (result: Result<QrDecodeSuccess>) => void;
	readonly onStatus?: (status: CameraStatus) => void;
	readonly onTelemetry?: TelemetrySink;
	readonly deps?: CameraDeps;
}

export interface CameraScanHandle {
	stop(): void;
	readonly stopped: boolean;
	/**
	 * True when a later `startCameraScan` won the race and this one opened nothing.
	 *
	 * Two starts in the same second (a re-render, a double tap) both reach
	 * getUserMedia. The later one owns the camera; whichever settles second, this
	 * one hands back a handle that is already `stopped` and whose `stop` does
	 * nothing, because its own stream has been stopped for it.
	 *
	 * A caller that keeps one handle must not overwrite a live handle with a
	 * superseded one. Doing so leaves the camera running with nothing able to stop
	 * it, and the indicator lit for the life of the page. Check this before
	 * storing:
	 *
	 * ```ts
	 * const handle = await startCameraScan(options);
	 * if (handle.superseded) return;
	 * current = handle;
	 * ```
	 *
	 * A superseded start also emits no status, so a `'live'` status is always a
	 * camera that is genuinely live and a `'stopped'` one is always the camera that
	 * had been live stopping.
	 */
	readonly superseded: boolean;
}

/** Whether opening a camera is even possible here, before asking for one. */
export function isCameraAvailable(deps: CameraDeps = {}): boolean {
	const secure =
		deps.isSecureContext ?? (typeof isSecureContext === 'boolean' ? isSecureContext : false);
	const hasApi =
		deps.getUserMedia !== undefined ||
		(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined);
	return secure && hasApi;
}

/**
 * What we ask the camera for.
 *
 * `ideal` is a soft constraint and cannot raise OverconstrainedError, so a 720p
 * webcam simply returns 1280 by 720 and a phone gives 1080p. Asking for it at
 * all matters: the default on most engines is 640 by 480, at which a ten-account
 * export is below Nyquist however close the phone is held.
 *
 * `facingMode` stays a bare value, which is an ideal: `{ exact: 'environment' }`
 * fails outright on a laptop with only a front camera. `resizeMode: 'none'` is a
 * hint, ignored where unknown, and that is the right failure mode: without it an
 * engine may satisfy the ideal by scaling a native frame down before we see a
 * pixel. `focusMode` goes in `advanced`, which is best-effort and never fails the
 * request, where the basic set would reject a camera that supports the
 * constraint but not that value.
 *
 * Deliberately no torch. It is Chrome on Android only, and the subject is a
 * self-illuminated screen, so it would add glare rather than light.
 */
function frameConstraints(options: CameraScanOptions): MediaTrackConstraints {
	if (options.deviceId !== undefined) {
		return { deviceId: { exact: options.deviceId }, ...IDEAL_FRAME };
	}
	return { facingMode: options.facingMode ?? 'environment', ...IDEAL_FRAME };
}

// `resizeMode` and `focusMode` are real constraints that the DOM typings do not
// carry, hence the cast. Both are hints here, so an engine that ignores them
// costs nothing.
const IDEAL_FRAME: MediaTrackConstraints = {
	width: { ideal: 1920 },
	height: { ideal: 1080 },
	...({
		resizeMode: 'none',
		advanced: [{ focusMode: 'continuous' }],
	} as unknown as MediaTrackConstraints),
};

/** Map a getUserMedia rejection onto something a person can act on. */
function mapCameraError(cause: unknown): RetrieverError {
	const name = (cause as { name?: string } | null)?.name;

	switch (name) {
		case 'NotAllowedError':
		case 'SecurityError':
		case 'PermissionDeniedError':
			return new CameraPermissionError({ cause });
		case 'NotFoundError':
		case 'DevicesNotFoundError':
			return new CameraUnavailableError('no-device', { cause });
		case 'OverconstrainedError':
		case 'ConstraintNotSatisfiedError':
			return new CameraUnavailableError('constraints', { cause });
		case 'NotReadableError':
		case 'TrackStartError':
			return new CameraInUseError({ cause });
		default:
			return new CameraUnavailableError('no-api', { cause });
	}
}

export async function listCameras(deps: CameraDeps = {}): Promise<CameraDevice[]> {
	const enumerate =
		deps.enumerateDevices ??
		(typeof navigator !== 'undefined' && navigator.mediaDevices
			? () => navigator.mediaDevices.enumerateDevices()
			: undefined);

	if (enumerate === undefined) {
		return [];
	}

	const devices = await enumerate();
	return devices
		.filter((device) => device.kind === 'videoinput')
		.map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/** Bumped per call, so a superseded stream is stopped rather than leaked. */
let generation = 0;

export async function startCameraScan(options: CameraScanOptions): Promise<CameraScanHandle> {
	const deps = options.deps ?? {};
	const now = deps.now ?? (() => Date.now());
	const requestFrame =
		deps.requestFrame ??
		(typeof requestAnimationFrame === 'function'
			? requestAnimationFrame
			: (callback: () => void) => setTimeout(callback, 16) as unknown as number);
	const cancelFrame =
		deps.cancelFrame ??
		(typeof cancelAnimationFrame === 'function'
			? cancelAnimationFrame
			: (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

	const secure =
		deps.isSecureContext ?? (typeof isSecureContext === 'boolean' ? isSecureContext : false);
	if (!secure && deps.getUserMedia === undefined) {
		throw new CameraUnavailableError('insecure-context');
	}

	const getUserMedia =
		deps.getUserMedia ??
		(typeof navigator !== 'undefined' && navigator.mediaDevices
			? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
			: undefined);

	if (getUserMedia === undefined) {
		throw new CameraUnavailableError('no-api');
	}

	options.onStatus?.({ state: 'requesting' });

	// getUserMedia can take a second or more, and a caller that starts twice in
	// that window (a re-render, a double tap) would otherwise leak the first
	// camera: its stream resolves with no handle in anybody's hands and the
	// indicator light stays on. The later call wins and the earlier one hands
	// back a handle marked `superseded`, rather than an error to display.
	const mine = ++generation;

	let stream: MediaStream;
	try {
		stream = await openStream(getUserMedia, options);
	} catch (cause) {
		options.onStatus?.({ state: 'stopped' });
		throw mapCameraError(cause);
	}

	if (mine !== generation) {
		for (const t of stream.getTracks()) {
			t.stop();
		}
		// Deliberately no status. The status is what tells a caller the camera went
		// live or stopped, and this stream never went live: a `'stopped'` here would
		// arrive after the winner's `'live'` and describe a camera that is running.
		// The handle says what happened instead, and it says it before anybody can
		// store it. See `CameraScanHandle.superseded`.
		return { stop: () => undefined, stopped: true, superseded: true };
	}

	let stopped = false;
	options.video.srcObject = stream;
	try {
		await options.video.play();
	} catch {
		// Autoplay refusal. The stream is live either way, and the caller's
		// markup carries `playsinline muted`, so this is not worth failing on.
	}

	// Checked again, because `play()` is a second await and a later start can arrive
	// inside it. Without this the loser passes the check above, waits on `play()`,
	// and comes back claiming to be the winner alongside the real one: two open
	// streams, both handles reporting `superseded: false`, and whichever a caller
	// stores last leaves the other running with nothing able to stop it. That is the
	// exact failure `superseded` exists to prevent, so leaving one window open would
	// make the contract a promise rather than a guarantee.
	if (mine !== generation) {
		for (const t of stream.getTracks()) {
			t.stop();
		}
		// The winner owns the element by now, so this one must not leave a dead
		// stream attached to it.
		if (options.video.srcObject === stream) {
			options.video.srcObject = null;
		}
		return { stop: () => undefined, stopped: true, superseded: true };
	}

	const track = stream.getVideoTracks()[0];

	let handle: number | null = null;
	// When the last decode *finished*. Negative infinity so the first frame after
	// the stream opens is decoded rather than waited out.
	let lastFinished = Number.NEGATIVE_INFINITY;
	// What the last decode cost, which is what the next gap is measured against.
	let lastDuration = 0;
	// Filled in below and run by `stop`. A list rather than a variable per
	// listener, so nothing `stop` touches can be declared after it.
	const teardown: Array<() => void> = [];

	const interval = 1000 / (options.scansPerSecond ?? 15);
	// Five rungs, because that is what the reordered ladder needs to offer both
	// polarities at both cheap scales plus the global threshold, and those five won
	// every one of the 32 dim scenes and 371 of the 408 corpus cases through the
	// camera chain. They cost 34 ms on a blank 1080p frame here.
	//
	// The budget is not sized for this machine, where those five finish in well
	// under 140 ms. It is sized for a phone three to five times slower, where the
	// same five cost 120 to 200 ms and a 140 ms budget would cut the ladder off in
	// the middle of the rungs that do the reading. It costs a fast device nothing:
	// the ladder stops when it runs out of rungs, not when it runs out of budget.
	// Corpus pass rate, mean per-frame cost and blank-frame cost are identical at
	// 140 and at 250.
	const budget = options.frameBudgetMs ?? 250;
	const maxAttempts = options.maxAttempts ?? 5;

	const stop = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (handle !== null) {
			cancelFrame(handle);
			handle = null;
		}
		// Stopping every track is what actually turns the indicator off.
		for (const t of stream.getTracks()) {
			t.stop();
		}
		options.video.srcObject = null;
		// The frame canvas is 8 MB at 1080p and nothing needs it, or the reduction
		// steps behind it, once the camera is closed.
		releaseVideoCanvas();
		for (const undo of teardown) {
			undo();
		}
		options.onStatus?.({ state: 'stopped' });
	};

	const addVisibility =
		deps.addVisibilityListener ??
		(typeof document !== 'undefined'
			? (listener: () => void) => {
					const handler = () => {
						if (document.visibilityState === 'hidden') {
							listener();
						}
					};
					document.addEventListener('visibilitychange', handler);
					return () => document.removeEventListener('visibilitychange', handler);
				}
			: undefined);

	const removeVisibility = addVisibility?.(stop);
	if (removeVisibility !== undefined) {
		teardown.push(removeVisibility);
	}

	// Unplug a webcam, or let another application seize the camera, and the
	// stream dies while `videoWidth` may stay non-zero. Without this the loop
	// keeps decoding one frozen frame and the interface keeps saying "looking".
	if (track !== undefined && typeof track.addEventListener === 'function') {
		track.addEventListener('ended', stop);
		teardown.push(() => track.removeEventListener('ended', stop));
	}

	const pump = (): void => {
		if (stopped) {
			return;
		}
		handle = requestFrame(pump);

		// Measured from when the last decode finished rather than from when it
		// started, and the gap is at least as long as the decode that preceded it.
		// A fixed interval bounds idle time, which is not the thing that has to be
		// bounded: at 67 ms of idle a 140 ms decode holds the thread for 68% of the
		// time, and a phone three to five times slower holds it for 85 to 91%, at
		// which the preview visibly stutters on exactly the devices this is for.
		// Proportional idle caps occupancy near half however slow the device is, and
		// the half the decoder is not using is the half the preview is painted in.
		//
		// The guard before this one counted animation frames and decayed by a
		// quarter budget per frame, which turned one 300 ms decode into 750 ms of
		// dead time and tied the recovery rate to the display refresh rather than to
		// the work. This is bounded in both directions instead.
		if (now() - lastFinished < Math.max(interval, lastDuration)) {
			return;
		}

		// The grab is charged to the frame as well as the decode. Copying a 1080p
		// frame off the video and reading it back is real work on the same thread the
		// preview paints on, and a device slow enough for occupancy to matter is slow
		// at that too.
		const startedAt = now();

		let frame: ImageDataLike;
		try {
			frame = imageDataFromVideo(
				options.video,
				{ createCanvas: deps.createCanvas },
				options.maxPixels,
			);
		} catch {
			// The video has no dimensions yet, which is normal for the first
			// frames after play() resolves.
			return;
		}

		const result = decodeQrFromImageData(frame, {
			timeBudgetMs: budget,
			maxAttempts,
			now: deps.now,
			onTelemetry: options.onTelemetry,
		});
		lastFinished = now();
		lastDuration = lastFinished - startedAt;

		// Only successes are delivered. "Nothing in this frame" happens many
		// times a second and is not news; a consumer re-rendering on it would
		// spend its whole budget on a message that says no.
		if (result.ok) {
			options.onResult(result);
		}
	};

	options.onStatus?.(
		track ? { state: 'live', track, settings: readSettings(track) } : { state: 'stopped' },
	);

	handle = requestFrame(pump);

	return {
		stop,
		get stopped() {
			return stopped;
		},
		superseded: false,
	};
}

/**
 * Ask for the good frame, then settle for whatever the camera will give.
 *
 * `ideal` cannot overconstrain, but `deviceId: { exact: ... }` can, and so can a
 * constraint an engine simply refuses to parse. One relaxed retry is the
 * difference between "no camera on this device" and a working scan.
 */
async function openStream(
	getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
	options: CameraScanOptions,
): Promise<MediaStream> {
	try {
		return await getUserMedia({ video: frameConstraints(options), audio: false });
	} catch (cause) {
		const name = (cause as { name?: string } | null)?.name;
		if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError') {
			throw cause;
		}
		return getUserMedia({ video: true, audio: false });
	}
}

function readSettings(track: MediaStreamTrack): MediaTrackSettings | undefined {
	return typeof track.getSettings === 'function' ? track.getSettings() : undefined;
}
