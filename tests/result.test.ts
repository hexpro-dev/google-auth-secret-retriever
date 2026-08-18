import { describe, expect, it } from 'vitest';
import { Base32DecodeError } from '../src/errors.js';
import { attempt, err, ok, unwrap } from '../src/result.js';

/**
 * The two shapes a caller can pick between.
 *
 * Both are exported from the package index, so a consumer chooses whichever
 * suits their code and neither may be a trap. `attempt` is the one worth
 * dwelling on: it converts a thrown `RetrieverError` into a failed `Result`,
 * and everything else has to keep travelling. A version that caught broadly
 * would turn a typo in the caller's own callback into "this is not a valid QR
 * code", and the real fault would never be seen.
 */

describe('unwrap', () => {
	it('returns the value of a successful result', () => {
		expect(unwrap(ok(7))).toBe(7);
	});

	it('throws the error a failed result carries, not a wrapper around it', () => {
		// The error is the diagnosis. Re-wrapping it here would cost the caller
		// the code, the index and the instanceof they catch on.
		const error = new Base32DecodeError(4, 'bad character');

		try {
			unwrap(err(error));
			expect.unreachable('should have thrown');
		} catch (thrown) {
			expect(thrown).toBe(error);
		}
	});
});

describe('attempt', () => {
	it('carries a returned value through as a successful result', () => {
		expect(attempt(() => 'value')).toEqual({ ok: true, value: 'value' });
	});

	it("turns this package's own errors into a failed result", () => {
		const error = new Base32DecodeError(0, 'bad character');
		const result = attempt(() => {
			throw error;
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toBe(error);
	});

	it('lets anything that is not one of our errors keep travelling', () => {
		// A TypeError here is a bug in the caller's own function. Swallowing it
		// would report it as a failed decode, and the stack trace pointing at
		// the real line would be gone.
		expect(() =>
			attempt(() => {
				throw new TypeError('undefined is not a function');
			}),
		).toThrow(TypeError);
	});
});
