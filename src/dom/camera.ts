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
import { type CanvasLike, imageDataFromVideo } from './image-source.js';

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
	| { readonly state: 'live'; readonly track: MediaStreamTrack }
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
	srcObject: MediaStream | null;
	readonly videoWidth: number;
	readonly videoHeight: number;
	play(): Promise<void>;
}

export interface CameraScanOptions {
	readonly video: VideoLike;
	readonly facingMode?: 'environment' | 'user';
	readonly deviceId?: string;
	/** Long edge of the frame handed to the decoder. */
	readonly maxEdge?: number;
	/** Per-frame decode budget. Frames are skipped rather than overrunning it. */
	readonly frameBudgetMs?: number;
	/** Decode attempts per second. Not every frame; the preview must stay smooth. */
	readonly scansPerSecond?: number;
	readonly onResult: (result: Result<QrDecodeSuccess>) => void;
	readonly onStatus?: (status: CameraStatus) => void;
	readonly onTelemetry?: TelemetrySink;
	readonly deps?: CameraDeps;
}

export interface CameraScanHandle {
	stop(): void;
	readonly stopped: boolean;
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

	let stream: MediaStream;
	try {
		stream = await getUserMedia({
			video:
				options.deviceId !== undefined
					? { deviceId: { exact: options.deviceId } }
					: { facingMode: options.facingMode ?? 'environment', width: { ideal: 1280 } },
			audio: false,
		});
	} catch (cause) {
		options.onStatus?.({ state: 'stopped' });
		throw mapCameraError(cause);
	}

	options.video.srcObject = stream;
	try {
		await options.video.play();
	} catch {
		// Autoplay refusal. The stream is live either way, and the caller's
		// markup carries `playsinline muted`, so this is not worth failing on.
	}

	const track = stream.getVideoTracks()[0];
	options.onStatus?.(track ? { state: 'live', track } : { state: 'stopped' });

	let stopped = false;
	let handle: number | null = null;
	let lastScan = 0;
	let lastDuration = 0;

	const interval = 1000 / (options.scansPerSecond ?? 8);
	const budget = options.frameBudgetMs ?? 35;

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
		removeVisibility?.();
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

	const pump = (): void => {
		if (stopped) {
			return;
		}
		handle = requestFrame(pump);

		const time = now();
		// Skip entirely if the last decode overran its budget, so the preview
		// never stutters on a slow device.
		if (time - lastScan < interval || lastDuration > budget * 2) {
			lastDuration = Math.max(0, lastDuration - budget / 4);
			return;
		}
		lastScan = time;

		let frame: ImageDataLike;
		try {
			frame = imageDataFromVideo(
				options.video,
				{ createCanvas: deps.createCanvas },
				options.maxEdge ?? 720,
			);
		} catch {
			// The video has no dimensions yet, which is normal for the first
			// frames after play() resolves.
			return;
		}

		const started = now();
		const result = decodeQrFromImageData(frame, {
			timeBudgetMs: budget,
			maxAttempts: 2,
			now: deps.now,
			onTelemetry: options.onTelemetry,
		});
		lastDuration = now() - started;

		// Only successes are delivered. "Nothing in this frame" happens many
		// times a second and is not news; a consumer re-rendering on it would
		// spend its whole budget on a message that says no.
		if (result.ok) {
			options.onResult(result);
		}
	};

	handle = requestFrame(pump);

	return {
		stop,
		get stopped() {
			return stopped;
		},
	};
}
