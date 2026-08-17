import { expect } from 'vitest';
import type { Result } from '../../src/result.js';

/**
 * Narrow a failed `Result` to its error, failing the test if it succeeded.
 *
 * Exists so tests do not reach for a cast. A cast would keep compiling after
 * `parseMigrationUri` started succeeding on input it should reject, and the
 * assertion would then be checking a property of `undefined`.
 */
export function expectErr<T, E>(result: Result<T, E>): E {
	if (result.ok) {
		expect.unreachable('expected a failed Result, got a successful one');
	}
	return result.error;
}

/** The mirror of `expectErr`, for symmetry at call sites that need both. */
export function expectOk<T, E>(result: Result<T, E>): T {
	if (!result.ok) {
		expect.unreachable(`expected a successful Result, got: ${String(result.error)}`);
	}
	return result.value;
}
