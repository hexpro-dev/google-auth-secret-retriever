import { encodeBase32 } from '../encoding/base32.js';
import { PayloadValidationError } from '../errors.js';
import { buildOtpauthUri } from '../otp/otpauth-uri.js';
import type {
	AppliedDefault,
	MigrationPayload,
	OtpAccount,
	OtpAlgorithm,
	OtpDigits,
	OtpType,
	RawOtpParameters,
} from '../types.js';

/**
 * Turning wire records into accounts.
 *
 * The interesting work here is being honest about what was decoded and what was
 * assumed. Three of the fields have an `UNSPECIFIED` enum value that Google
 * emits routinely, and the conventional reading of each is SHA1, 6 digits and
 * TOTP. Those readings are almost certainly right, but they are conventions
 * rather than data, so `defaultsApplied` records which ones were used and the
 * user interface can say so.
 *
 * `period` gets the same treatment for a stronger reason: the payload has no
 * period field at all, so 30 is not even a default, it is knowledge about how
 * Google Authenticator behaves.
 */

const ALGORITHMS: Readonly<Record<number, OtpAlgorithm>> = {
	1: 'SHA1',
	2: 'SHA256',
	3: 'SHA512',
	4: 'MD5',
};

export function toAccount(raw: RawOtpParameters, index = 0): OtpAccount {
	if (raw.secret.length === 0) {
		throw new PayloadValidationError('secret', index, 'an account in the export has no secret');
	}

	const defaultsApplied: AppliedDefault[] = [];

	const algorithm = ALGORITHMS[raw.algorithm];
	const resolvedAlgorithm: OtpAlgorithm = algorithm ?? 'SHA1';
	if (algorithm === undefined) {
		defaultsApplied.push('algorithm');
	}

	const resolvedDigits: OtpDigits = raw.digits === 2 ? 8 : 6;
	if (raw.digits !== 1 && raw.digits !== 2) {
		defaultsApplied.push('digits');
	}

	const resolvedType: OtpType = raw.type === 1 ? 'hotp' : 'totp';
	if (raw.type !== 1 && raw.type !== 2) {
		defaultsApplied.push('type');
	}

	// Google stores the account either as `account` or as `Issuer:account`,
	// depending on how it was originally added. Split on the first colon only,
	// because an account name can legitimately contain one.
	const colon = raw.name.indexOf(':');
	const labelIssuer = colon === -1 ? null : raw.name.slice(0, colon).trim();
	const accountName = colon === -1 ? raw.name.trim() : raw.name.slice(colon + 1).trim();

	const issuer = raw.issuer.trim();
	const displayIssuer = issuer !== '' ? issuer : (labelIssuer ?? '');

	// The counter is int64 on the wire but a browser counter that exceeds 2^53
	// is not a real account, and Number keeps the public type usable.
	const counter =
		resolvedType === 'hotp' && raw.counter <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(raw.counter)
			: 0;

	return {
		secret: encodeBase32(raw.secret),
		secretBytes: raw.secret,
		issuer,
		labelIssuer,
		name: raw.name,
		accountName,
		displayIssuer,
		type: resolvedType,
		algorithm: resolvedAlgorithm,
		digits: resolvedDigits,
		period: 30,
		periodSource: 'google-default',
		counter,
		uri: buildOtpauthUri({
			secret: raw.secret,
			// The label prefix is a fallback, not a second issuer: passing
			// `displayIssuer` here is what stops `Issuer:Issuer:account`.
			issuer: displayIssuer,
			accountName,
			type: resolvedType,
			algorithm: resolvedAlgorithm,
			digits: resolvedDigits,
			period: 30,
			counter,
		}),
		defaultsApplied,
		raw,
	};
}

export function toAccounts(payload: MigrationPayload): readonly OtpAccount[] {
	return payload.otpParameters.map((raw, index) => toAccount(raw, index));
}

/**
 * A stable identity for an account, used to drop duplicates when several QR
 * codes from one export are merged.
 *
 * Includes the secret, because two accounts can legitimately share an issuer
 * and a name (two logins at the same service) and must not collapse into one.
 */
export function accountKey(account: OtpAccount): string {
	return `${account.type}|${account.displayIssuer}|${account.name}|${account.secret}`;
}
