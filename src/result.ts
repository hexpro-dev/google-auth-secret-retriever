import { RetrieverError } from './errors.js';

/**
 * The outcome of an operation that is expected to fail sometimes.
 *
 * The split in this package is deliberate and worth knowing: pure parsers
 * throw, and attempt-shaped operations return a `Result`. Deciding whether a
 * camera frame contains a QR code is attempt-shaped and happens thirty times a
 * second, so it must not allocate a stack trace to say no. Decoding base32 that
 * has already been established as base32 is not, so it throws.
 */
export type Result<T, E = RetrieverError> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

/** Throws the contained error, for callers that would rather use try/catch. */
export function unwrap<T>(result: Result<T, RetrieverError>): T {
	if (result.ok) {
		return result.value;
	}
	throw result.error;
}

/** Runs `fn`, converting a thrown `RetrieverError` into a failed `Result`. */
export function attempt<T>(fn: () => T): Result<T, RetrieverError> {
	try {
		return ok(fn());
	} catch (cause) {
		if (cause instanceof RetrieverError) {
			return err(cause);
		}
		throw cause;
	}
}
