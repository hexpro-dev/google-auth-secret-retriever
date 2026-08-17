import { decodeBase64Loose } from '../encoding/base64.js';
import { Base64DecodeError, NotMigrationUriError, RetrieverError } from '../errors.js';
import { parseMigrationPayload } from '../protobuf/migration-payload.js';
import { type Result, err, ok } from '../result.js';
import type { MigrationScan } from '../types.js';
import { toAccounts } from './accounts.js';

/**
 * Pulling the payload out of an `otpauth-migration://` URI.
 *
 * Read the comment on `extractMigrationData` before touching this file. The
 * obvious implementation is wrong in a way that is very hard to notice.
 */

const MIGRATION_SCHEME = /^otpauth-migration:/i;
const SINGLE_ACCOUNT_SCHEME = /^otpauth:\/\//i;

/**
 * Matches base64 with either alphabet, optional padding, and nothing else.
 * Used to recognise a payload someone pasted without the URI around it.
 */
const BARE_BASE64 = /^[A-Za-z0-9+/\-_]+={0,2}$/;

/**
 * Extract the raw `data` parameter.
 *
 * Deliberately a regex and `decodeURIComponent`, not `URL` and
 * `URLSearchParams`. URLSearchParams applies application/x-www-form-urlencoded
 * decoding, which turns a literal '+' into a space. The payload is standard
 * base64 and contains '+', so form-decoding it produces either a base64 error
 * or, worse, a valid-looking payload with the wrong bits in it and therefore a
 * secret that silently generates codes which never work.
 *
 * Google's own QR codes percent-encode the '+' as %2B and would survive
 * URLSearchParams. A literal '+' is legal in a query string too, and turns up
 * whenever the URI has been relayed by another tool or pasted by hand, so both
 * have to work. `decodeURIComponent` is correct for both: it leaves a literal
 * '+' alone and still resolves %2B.
 *
 * There is a regression test named "the plus-sign hazard" in
 * tests/encoding/base64.test.ts. Do not simplify past it.
 */
export function extractMigrationData(uri: string): string {
	const match = /[?&]data=([^&#]*)/.exec(uri);
	if (match === null || match[1] === undefined || match[1] === '') {
		throw new Base64DecodeError(0, 'the link has no data to decode');
	}

	try {
		return decodeURIComponent(match[1]);
	} catch {
		// A stray '%' that is not a valid escape. Common in hand-typed input.
		throw new Base64DecodeError(0, 'the link contains a broken escape sequence');
	}
}

/**
 * Parse anything a user might arrive with into a scan.
 *
 * Accepts, in order: a migration URI in any of its shapes, and a bare base64
 * payload for people who already extracted one with another tool. Rejects a
 * single-account `otpauth://` URI with a distinct error carrying the text, so
 * the caller can offer to read it anyway rather than saying "not supported".
 */
export function parseMigrationUri(text: string): Result<MigrationScan> {
	const trimmed = text.trim();

	if (trimmed === '') {
		return err(new NotMigrationUriError('plain-text', trimmed));
	}

	if (SINGLE_ACCOUNT_SCHEME.test(trimmed)) {
		return err(new NotMigrationUriError('single-account-uri', trimmed));
	}

	let data: string;
	if (MIGRATION_SCHEME.test(trimmed)) {
		try {
			data = extractMigrationData(trimmed);
		} catch (error) {
			return err(error as RetrieverError);
		}
	} else if (trimmed.includes('://') || trimmed.startsWith('http')) {
		return err(new NotMigrationUriError('other-uri', trimmed));
	} else if (BARE_BASE64.test(trimmed)) {
		// Somebody pasted just the payload. Accepting it costs nothing and
		// serves everyone who got this far with zbarimg and a shell.
		data = trimmed;
	} else {
		return err(new NotMigrationUriError('plain-text', trimmed));
	}

	try {
		const payloadBytes = decodeBase64Loose(data);
		const payload = parseMigrationPayload(payloadBytes);

		return ok({
			uri: trimmed,
			payload,
			payloadBytes,
			accounts: toAccounts(payload),
			batch: {
				id: payload.batchId,
				size: payload.batchSize,
				index: payload.batchIndex,
			},
		});
	} catch (error) {
		if (error instanceof RetrieverError) {
			return err(error);
		}
		throw error;
	}
}
