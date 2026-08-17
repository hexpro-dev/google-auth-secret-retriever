import { decodeBase32, encodeBase32 } from '../encoding/base32.js';
import { Base32DecodeError, PayloadValidationError, QrUnsupportedFeatureError } from '../errors.js';
import type { OtpAccountInput, OtpAlgorithm, OtpDigits, OtpType } from '../types.js';

/**
 * The Key Uri Format, which is what every authenticator reads when it scans a
 * QR code for a single account.
 *
 *   otpauth://TYPE/LABEL?PARAMETERS
 *
 * The label is `Issuer:Account` when an issuer is known, and the issuer is
 * *also* repeated as a query parameter. That duplication looks redundant and is
 * not: older readers only look at the label prefix, newer ones prefer the
 * parameter, and emitting both is what makes a URI portable. Google's own
 * documentation recommends it.
 *
 * Every parameter is written explicitly, including ones that match the format's
 * defaults, because importers disagree about what the defaults are. Writing
 * `algorithm=SHA1&digits=6&period=30` costs a few bytes and removes an entire
 * class of "the codes do not match" support question.
 */

const ALGORITHMS: readonly OtpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512', 'MD5'];

/**
 * Percent-encode a label component.
 *
 * `encodeURIComponent` leaves `!'()*` alone, which are legal in a path segment
 * but confuse some scanners, and it encodes everything else this needs. The
 * extra pass covers the stragglers.
 */
function encodeLabelPart(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function buildOtpauthUri(input: OtpAccountInput): string {
	if (input.secret.length === 0) {
		throw new PayloadValidationError('secret', 0, 'the account has no secret');
	}

	const type: OtpType = input.type ?? 'totp';
	const issuer = input.issuer?.trim() ?? '';
	const accountName = input.accountName?.trim() ?? '';

	// A URI with an empty label is legal but useless: every authenticator shows
	// it as a blank row. Falling back to the issuer gives it something to show.
	const labelAccount = accountName === '' ? issuer : accountName;
	const label =
		issuer === '' || issuer === labelAccount
			? encodeLabelPart(labelAccount)
			: `${encodeLabelPart(issuer)}:${encodeLabelPart(labelAccount)}`;

	const params = new URLSearchParams();
	params.set('secret', encodeBase32(input.secret));
	if (issuer !== '') {
		params.set('issuer', issuer);
	}
	params.set('algorithm', input.algorithm ?? 'SHA1');
	params.set('digits', String(input.digits ?? 6));
	if (type === 'hotp') {
		params.set('counter', String(input.counter ?? 0));
	} else {
		params.set('period', String(input.period ?? 30));
	}

	// URLSearchParams serialises a space as '+'. In a query that is correct
	// form-encoding, but authenticators vary on whether they form-decode, and a
	// '+' rendered literally turns "Example Corp" into "Example+Corp" on screen.
	// %20 is unambiguous to both kinds of reader.
	return `otpauth://${type}/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

export function parseOtpauthUri(uri: string): OtpAccountInput & { readonly accountName: string } {
	const match = /^otpauth:\/\/(totp|hotp)\/([^?]*)(?:\?(.*))?$/i.exec(uri.trim());
	if (match === null) {
		throw new QrUnsupportedFeatureError('mode', 'this is not an otpauth URI');
	}

	const type = match[1]!.toLowerCase() as OtpType;
	const rawLabel = match[2] ?? '';
	const params = new URLSearchParams(match[3] ?? '');

	const secretText = params.get('secret');
	if (secretText === null || secretText === '') {
		throw new Base32DecodeError(0, 'the URI has no secret');
	}
	const secret = decodeBase32(secretText);

	// The label is `Issuer:Account` or just `Account`.
	//
	// Split before percent-decoding, not after. A colon inside an issuer or an
	// account name arrives as %3A, and decoding first turns it back into a
	// literal ':' that is then indistinguishable from the separator, which
	// silently moves part of the issuer into the account name. Splitting the
	// raw text means only an unencoded colon can separate the two, which is
	// exactly the rule the format intends.
	//
	// Still the *first* colon: producers that do not encode the separator are
	// common, and an account name may legitimately contain one after it.
	const colon = rawLabel.indexOf(':');
	const labelIssuer = colon === -1 ? '' : decodeURIComponent(rawLabel.slice(0, colon)).trim();
	const accountName = decodeURIComponent(
		colon === -1 ? rawLabel : rawLabel.slice(colon + 1),
	).trim();

	const algorithmText = (params.get('algorithm') ?? 'SHA1').toUpperCase();
	const algorithm = ALGORITHMS.includes(algorithmText as OtpAlgorithm)
		? (algorithmText as OtpAlgorithm)
		: 'SHA1';

	const digitsValue = Number(params.get('digits') ?? 6);
	const digits: OtpDigits = digitsValue === 8 ? 8 : 6;

	const periodValue = Number(params.get('period') ?? 30);
	const period = Number.isFinite(periodValue) && periodValue > 0 ? periodValue : 30;

	const counterValue = Number(params.get('counter') ?? 0);
	const counter = Number.isFinite(counterValue) && counterValue >= 0 ? counterValue : 0;

	return {
		secret,
		// The query parameter wins over the label prefix when they disagree:
		// it is the newer of the two and the one a producer sets deliberately.
		issuer: params.get('issuer')?.trim() ?? labelIssuer,
		accountName,
		type,
		algorithm,
		digits,
		period,
		counter,
	};
}
