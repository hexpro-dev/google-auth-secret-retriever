import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotMigrationUriError } from '../../src/errors.js';

/**
 * A guard against the one mistake this repository cannot recover from.
 *
 * It is public and git history is permanent. A Google Authenticator export QR
 * is the full credential for every account inside it: anyone holding it can
 * generate those codes indefinitely, and changing the account password does not
 * revoke it. So no real export, and no real secret, may ever be committed, not
 * even in a commit that is reverted afterwards.
 *
 * This is one of several layers. The others are the synthetic fixture
 * generator, the hash check in CI, and a gitleaks scan over the full history.
 * This one is the cheapest and the fastest to fail, which is why it runs with
 * the ordinary test suite.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

/** Files git knows about. Anything untracked cannot be committed by accident. */
function trackedFiles(): string[] {
	const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
	return output.split('\0').filter((name) => name.length > 0);
}

const BINARY_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.pdf',
	'.woff',
	'.woff2',
]);

/**
 * Base32 runs that are allowed to appear.
 *
 * Every one is either published in an RFC, published in Google's own Key Uri
 * Format documentation, or an obviously synthetic value used in a test. Adding
 * to this list is a decision, not a formality: read the value first.
 */
const ALLOWED = new Set([
	// RFC 4648 section 10 test vectors.
	'MZXW6YTBOI',
	// Google's Key Uri Format documentation example.
	'HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ',
	// The placeholder used throughout the tests and the README.
	'JBSWY3DPEHPK3PXP',
	'JBSWY3DPEHPK3PXPJBSWY3DP',
	// The base32 alphabet itself, which appears in source and in tests.
	'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
	'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
]);

describe('no real 2FA material in the repository', () => {
	const files = trackedFiles();

	it('has files to check, so a broken glob cannot pass silently', () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it('contains no long base32 run outside the allowlist', () => {
		// A base32 secret is 16 characters or more. Shorter runs are common in
		// ordinary uppercase prose and constants, so the threshold is where
		// real key material starts.
		const pattern = /\b[A-Z2-7]{16,}\b/g;
		const offenders: string[] = [];

		for (const name of files) {
			if (BINARY_EXTENSIONS.has(extname(name))) {
				continue;
			}
			// This file necessarily contains the allowlist itself.
			if (name.endsWith('tests/security/no-real-secrets.test.ts')) {
				continue;
			}

			let contents: string;
			try {
				contents = readFileSync(join(ROOT, name), 'utf8');
			} catch {
				continue;
			}

			for (const match of contents.matchAll(pattern)) {
				const value = match[0];
				if (!ALLOWED.has(value)) {
					offenders.push(`${name}: ${value.slice(0, 6)}... (${value.length} chars)`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it('contains no otpauth-migration payload outside the generator and its tests', () => {
		// A migration URI is the export itself. The only places one may appear
		// are files that build synthetic ones.
		const allowedFiles = [
			'tests/',
			'src/migration/parse-uri.ts',
			'src/protobuf/migration-payload.ts',
			'src/index.ts',
			'src/errors.ts',
			'src/app/',
			'scripts/',
			'README.md',
			'CLAUDE.md',
		];

		const offenders: string[] = [];
		for (const name of files) {
			if (
				BINARY_EXTENSIONS.has(extname(name)) ||
				allowedFiles.some((prefix) => name.startsWith(prefix))
			) {
				continue;
			}

			let contents: string;
			try {
				contents = readFileSync(join(ROOT, name), 'utf8');
			} catch {
				continue;
			}

			if (contents.includes('otpauth-migration://offline?data=')) {
				offenders.push(name);
			}
		}

		expect(offenders).toEqual([]);
	});

	it('keeps the scratch directory out of version control', () => {
		// Where any work against a real export is supposed to happen.
		const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');

		expect(ignore).toContain('scratch/');
		expect(files.some((name) => name.startsWith('scratch/'))).toBe(false);
	});
});

describe('error messages carry no secret material', () => {
	it('never interpolates a base32 run into a message', async () => {
		// Errors end up in console logs, bug reports and screenshots. A tool
		// that leaks a credential into its own diagnostics has failed at the
		// only thing it promised.
		const errors = await import('../../src/errors.js');
		const messages: string[] = [];

		messages.push(new errors.QrNotFoundError(3, 12).message);
		messages.push(new errors.QrDecodeError('reed-solomon', 2, 'detail').message);
		messages.push(new errors.QrUnsupportedFeatureError('fnc1', 'a GS1 symbol').message);
		messages.push(new errors.QrCapacityError(20, 19).message);
		messages.push(new errors.Base32DecodeError(4, 'bad character').message);
		messages.push(new errors.Base64DecodeError(4, 'bad character').message);
		messages.push(new errors.ProtobufParseError(0, 'truncated').message);
		messages.push(new errors.PayloadValidationError('secret', 0, 'missing').message);
		messages.push(new errors.BatchMismatchError('foreign-batch', 1, 2).message);
		messages.push(new errors.UnsupportedAlgorithmError('MD5').message);
		messages.push(new errors.CryptoUnavailableError().message);
		messages.push(new errors.ImageDecodeError('image/heic').message);
		messages.push(new errors.CameraPermissionError().message);
		messages.push(new errors.CameraUnavailableError('no-device').message);
		messages.push(new errors.CameraInUseError().message);
		messages.push(
			new errors.NotMigrationUriError(
				'single-account-uri',
				'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
			).message,
		);

		for (const message of messages) {
			expect(message, message).not.toMatch(/[A-Z2-7]{16,}/);
			expect(message, message).not.toContain('secret=');
		}
	});

	it('keeps the scanned text off the message but available on the error', () => {
		// A single-account QR holds a secret. The caller may need the text to
		// offer to read it anyway, so it is a field rather than part of the
		// message, which is the part that gets printed.
		const uri = 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP';
		const error = new NotMigrationUriError('single-account-uri', uri);

		expect(error.text).toBe(uri);
		expect(error.message).not.toContain('secret');
	});
});
