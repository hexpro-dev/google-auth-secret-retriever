import type { Point } from '../../types.js';

/**
 * What the decoder saw, as it saw it.
 *
 * A first-class part of the API rather than debug output. A user interface that
 * can show the finder patterns locking on and the sampling grid lying across a
 * photograph in perspective is not decoration: when a decode fails, the stage
 * it stopped at *is* the diagnosis. Two reticles locked and one still hunting
 * means the crop cut off a corner, and no spinner can say that.
 *
 * All coordinates are in source-image pixels, so a consumer maps them through
 * whatever transform it used to display the image.
 */

export interface TelemetryFinder {
	readonly x: number;
	readonly y: number;
	readonly moduleSize: number;
	/** How many scan lines agreed on this centre. */
	readonly confidence: number;
}

export type DecodeFailureReason =
	'no-finders' | 'partial-finders' | 'no-extract' | 'checksum' | 'unsupported' | 'empty';

export type DecodeFrame =
	| { readonly stage: 'source'; readonly width: number; readonly height: number }
	| {
			readonly stage: 'binarised';
			readonly width: number;
			readonly height: number;
			/** One byte per pixel, 1 dark and 0 light. */
			readonly bits: Uint8Array;
	  }
	| { readonly stage: 'finders'; readonly patterns: readonly TelemetryFinder[] }
	| {
			readonly stage: 'located';
			readonly corners: readonly [Point, Point, Point, Point];
			readonly dimension: number;
			readonly alignment: Point | null;
			/**
			 * The nine coefficients of the symbol-to-image transform.
			 *
			 * Sent as numbers rather than as a callable, so this can cross a
			 * worker boundary. A consumer reconstructs the mapping as
			 * `(a11*x + a21*y + a31) / (a13*x + a23*y + a33)` and likewise for y.
			 */
			readonly transform: readonly number[];
	  }
	| {
			readonly stage: 'sampled';
			readonly dimension: number;
			/** `dimension * dimension` bytes, 1 dark and 0 light. */
			readonly modules: Uint8Array;
	  }
	| {
			readonly stage: 'corrected';
			readonly version: number;
			readonly ecLevel: string;
			readonly blocks: number;
			readonly errorsCorrected: number;
	  }
	| { readonly stage: 'decoded'; readonly text: string; readonly ms: number }
	| { readonly stage: 'failed'; readonly reason: DecodeFailureReason; readonly ms: number };

export type TelemetrySink = (frame: DecodeFrame) => void;
