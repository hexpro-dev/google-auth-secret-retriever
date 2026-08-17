import { describe, expect, it } from 'vitest';
import { decodeBase32 } from '../../src/encoding/base32.js';
import {
	Base32DecodeError,
	PayloadValidationError,
	QrUnsupportedFeatureError,
} from '../../src/errors.js';
import { buildOtpauthUri, parseOtpauthUri } from '../../src/otp/otpauth-uri.js';
import { syntheticSecret } from '../helpers/build-payload.js';

/** The example from Google's published Key Uri Format documentation. */
const KEY_URI_EXAMPLE =
	'otpauth://totp/ACME%20Co:john.doe@email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA1&digits=6&period=30';

describe('parseOtpauthUri against the published example', () => {
	it('reads every field', () => {
		const parsed = parseOtpauthUri(KEY_URI_EXAMPLE);

		expect(parsed.secret).toEqual(decodeBase32('HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ'));
		expect(parsed.issuer).toBe('ACME Co');
		expect(parsed.accountName).toBe('john.doe@email.com');
		expect(parsed.type).toBe('totp');
		expect(parsed.algorithm).toBe('SHA1');
		expect(parsed.digits).toBe(6);
		expect(parsed.period).toBe(30);
	});

	it('reads an issuer from the label when there is no issuer parameter', () => {
		const parsed = parseOtpauthUri(
			'otpauth://totp/ACME%20Co:john@example.com?secret=JBSWY3DPEHPK3PXP',
		);

		expect(parsed.issuer).toBe('ACME Co');
		expect(parsed.accountName).toBe('john@example.com');
	});

	it('prefers the issuer parameter over the label prefix when they disagree', () => {
		// The parameter is the newer of the two and the one a producer sets on
		// purpose; the label prefix is often a stale copy.
		const parsed = parseOtpauthUri(
			'otpauth://totp/Old:john@example.com?secret=JBSWY3DPEHPK3PXP&issuer=New',
		);

		expect(parsed.issuer).toBe('New');
	});

	it('handles a label with no issuer', () => {
		const parsed = parseOtpauthUri('otpauth://totp/A4043?secret=JBSWY3DPEHPK3PXP');

		expect(parsed.issuer).toBe('');
		expect(parsed.accountName).toBe('A4043');
	});

	it('reads an hotp URI with its counter', () => {
		const parsed = parseOtpauthUri('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=17');

		expect(parsed.type).toBe('hotp');
		expect(parsed.counter).toBe(17);
	});

	it('is not case sensitive about the scheme or the algorithm', () => {
		const parsed = parseOtpauthUri('OTPAUTH://TOTP/x?secret=JBSWY3DPEHPK3PXP&algorithm=sha256');

		expect(parsed.type).toBe('totp');
		expect(parsed.algorithm).toBe('SHA256');
	});

	it('falls back to sane values for nonsense parameters rather than failing', () => {
		// A wrong digit count should not cost someone their secret.
		const parsed = parseOtpauthUri(
			'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=WHIRLPOOL&digits=99&period=-4',
		);

		expect(parsed.algorithm).toBe('SHA1');
		expect(parsed.digits).toBe(6);
		expect(parsed.period).toBe(30);
	});

	it('rejects a URI with no secret', () => {
		expect(() => parseOtpauthUri('otpauth://totp/x')).toThrow(Base32DecodeError);
		expect(() => parseOtpauthUri('otpauth://totp/x?secret=')).toThrow(Base32DecodeError);
	});

	it('rejects something that is not an otpauth URI', () => {
		expect(() => parseOtpauthUri('https://example.com')).toThrow(QrUnsupportedFeatureError);
		expect(() => parseOtpauthUri('otpauth://steam/x?secret=JBSWY3DPEHPK3PXP')).toThrow(
			QrUnsupportedFeatureError,
		);
	});
});

describe('buildOtpauthUri', () => {
	const secret = syntheticSecret('build', 20);

	it('writes the label as Issuer:Account and repeats the issuer as a parameter', () => {
		// The duplication is deliberate: older readers use the label prefix,
		// newer ones use the parameter, and emitting both is what makes a URI
		// portable between authenticators.
		const uri = buildOtpauthUri({
			secret,
			issuer: 'Example Corp',
			accountName: 'user@example.com',
		});

		expect(uri).toContain('otpauth://totp/Example%20Corp:user%40example.com?');
		expect(uri).toContain('issuer=Example%20Corp');
	});

	it('writes every parameter explicitly, even at the format defaults', () => {
		// Importers disagree about what the defaults are, and a few bytes here
		// removes a whole class of "the codes do not match" question.
		const uri = buildOtpauthUri({ secret, issuer: 'X', accountName: 'y' });

		expect(uri).toContain('algorithm=SHA1');
		expect(uri).toContain('digits=6');
		expect(uri).toContain('period=30');
	});

	it('emits counter for hotp and period for totp, never both', () => {
		const totp = buildOtpauthUri({ secret, accountName: 'y', type: 'totp' });
		const hotp = buildOtpauthUri({ secret, accountName: 'y', type: 'hotp', counter: 9 });

		expect(totp).toContain('period=30');
		expect(totp).not.toContain('counter=');
		expect(hotp).toContain('counter=9');
		expect(hotp).not.toContain('period=');
	});

	it('escapes a space as %20 rather than a plus', () => {
		// URLSearchParams would write '+', and an authenticator that does not
		// form-decode shows "Example+Corp" on screen.
		const uri = buildOtpauthUri({ secret, issuer: 'Example Corp', accountName: 'a b' });

		expect(uri).not.toContain('+');
		expect(uri).toContain('%20');
	});

	it.each([':', '/', '?', '#', '&', '=', '@', ' ', '%', "'", '(', ')', '*', '!'])(
		'escapes %j in the label so it cannot break the URI',
		(character) => {
			const uri = buildOtpauthUri({
				secret,
				issuer: `Iss${character}uer`,
				accountName: `acc${character}ount`,
			});
			const parsed = parseOtpauthUri(uri);

			expect(parsed.issuer).toBe(`Iss${character}uer`);
			expect(parsed.accountName).toBe(`acc${character}ount`);
		},
	);

	it('round trips unicode issuers and account names', () => {
		const uri = buildOtpauthUri({
			secret,
			issuer: '日本語サービス',
			accountName: 'ユーザー@例.jp',
		});
		const parsed = parseOtpauthUri(uri);

		expect(parsed.issuer).toBe('日本語サービス');
		expect(parsed.accountName).toBe('ユーザー@例.jp');
	});

	it('omits the issuer parameter when there is no issuer', () => {
		const uri = buildOtpauthUri({ secret, accountName: 'A4043' });

		expect(uri).toBe(uri.replace(/issuer=[^&]*/, uri.includes('issuer=') ? 'FAIL' : ''));
		expect(uri).toContain('otpauth://totp/A4043?');
	});

	it('falls back to the issuer when there is no account name', () => {
		// A blank label renders as an empty row in every authenticator.
		const uri = buildOtpauthUri({ secret, issuer: 'Example Corp' });

		expect(uri).toContain('otpauth://totp/Example%20Corp?');
	});

	it('does not repeat the issuer when it is also the account name', () => {
		const uri = buildOtpauthUri({ secret, issuer: 'Same', accountName: 'Same' });

		expect(uri).toContain('otpauth://totp/Same?');
	});

	it('refuses to build a URI with no secret', () => {
		expect(() => buildOtpauthUri({ secret: new Uint8Array(0), accountName: 'x' })).toThrow(
			PayloadValidationError,
		);
	});

	it('round trips through parseOtpauthUri for every algorithm and digit count', () => {
		for (const algorithm of ['SHA1', 'SHA256', 'SHA512', 'MD5'] as const) {
			for (const digits of [6, 8] as const) {
				const uri = buildOtpauthUri({ secret, issuer: 'I', accountName: 'a', algorithm, digits });
				const parsed = parseOtpauthUri(uri);

				expect(parsed.algorithm).toBe(algorithm === 'MD5' ? 'MD5' : algorithm);
				expect(parsed.digits).toBe(digits);
				expect(parsed.secret).toEqual(secret);
			}
		}
	});
});
