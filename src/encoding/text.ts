import { QrUnsupportedFeatureError } from '../errors.js';

/**
 * Turning QR byte segments into text.
 *
 * The QR specification says a byte segment is ISO-8859-1 unless an ECI
 * designator says otherwise. Almost nothing in the real world honours that:
 * encoders emit UTF-8 and omit the ECI. So the strategy is to try UTF-8
 * strictly and fall back to latin1 when it fails, which gets both the standard
 * and the world right, and only disagrees on input that is ambiguous anyway.
 */

/** ECI designators this package knows how to turn into a TextDecoder label. */
export const ECI_LABELS: ReadonlyMap<number, string> = new Map([
	[0, 'iso-8859-1'],
	[1, 'iso-8859-1'],
	[2, 'cp437'],
	[3, 'iso-8859-1'],
	[4, 'iso-8859-2'],
	[5, 'iso-8859-3'],
	[6, 'iso-8859-4'],
	[7, 'iso-8859-5'],
	[8, 'iso-8859-6'],
	[9, 'iso-8859-7'],
	[10, 'iso-8859-8'],
	[11, 'iso-8859-9'],
	[12, 'iso-8859-10'],
	[13, 'iso-8859-11'],
	[15, 'iso-8859-13'],
	[16, 'iso-8859-14'],
	[17, 'iso-8859-15'],
	[18, 'iso-8859-16'],
	[20, 'shift_jis'],
	[21, 'windows-1250'],
	[22, 'windows-1251'],
	[23, 'windows-1252'],
	[24, 'windows-1256'],
	[25, 'utf-16be'],
	[26, 'utf-8'],
	[27, 'ascii'],
	[28, 'big5'],
	[29, 'gb18030'],
	[30, 'euc-kr'],
	[170, 'ascii'],
]);

export function encodeTextAsUtf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function decodeBytesAsText(bytes: Uint8Array, eci?: number): string {
	if (eci !== undefined) {
		const label = ECI_LABELS.get(eci);
		if (label === undefined) {
			throw new QrUnsupportedFeatureError('eci', `character set ECI ${eci}`);
		}
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {
			// A label this runtime does not implement (cp437 in some engines).
			throw new QrUnsupportedFeatureError('eci', `character set ${label}`);
		}
	}

	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		// Not valid UTF-8, so take the specification at its word.
		return new TextDecoder('iso-8859-1').decode(bytes);
	}
}
