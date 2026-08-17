import { QrDecodeError, QrUnsupportedFeatureError } from '../../errors.js';
import { BitReader } from '../bit-buffer.js';
import { ALPHANUMERIC_CHARS, charCountBits } from '../tables.js';

/**
 * The data bitstream, turned back into text.
 *
 * Segment decoding is where a QR payload stops being bits and starts being
 * something a person asked for, so the failure modes here matter: a wrong mode
 * or a wrong character-count width produces text that looks almost right, which
 * is worse than an error.
 */

const MODE_TERMINATOR = 0b0000;
const MODE_NUMERIC = 0b0001;
const MODE_ALPHANUMERIC = 0b0010;
const MODE_STRUCTURED_APPEND = 0b0011;
const MODE_BYTE = 0b0100;
const MODE_FNC1_FIRST = 0b0101;
const MODE_ECI = 0b0111;
const MODE_KANJI = 0b1000;
const MODE_FNC1_SECOND = 0b1001;

/**
 * Decode the byte payload, honouring an ECI designator when one is present.
 *
 * The specification says a byte segment is ISO-8859-1 unless an ECI says
 * otherwise. Almost nothing in the world honours that: encoders emit UTF-8 and
 * omit the ECI. So UTF-8 is tried strictly first and latin1 is the fallback,
 * which gets both the standard and reality right and only differs on input that
 * is ambiguous anyway.
 */
function decodeBytes(bytes: Uint8Array, eci: number | null): string {
	if (eci !== null) {
		const label = ECI_LABELS.get(eci);
		if (label === undefined) {
			throw new QrUnsupportedFeatureError('eci', `character set ECI ${eci}`);
		}
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {
			throw new QrUnsupportedFeatureError('eci', `character set ${label}`);
		}
	}

	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder('iso-8859-1').decode(bytes);
	}
}

const ECI_LABELS: ReadonlyMap<number, string> = new Map([
	[0, 'iso-8859-1'],
	[1, 'iso-8859-1'],
	[3, 'iso-8859-1'],
	[4, 'iso-8859-2'],
	[5, 'iso-8859-3'],
	[6, 'iso-8859-4'],
	[7, 'iso-8859-5'],
	[8, 'iso-8859-6'],
	[9, 'iso-8859-7'],
	[10, 'iso-8859-8'],
	[11, 'iso-8859-9'],
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

/** An ECI designator is 1, 2 or 3 bytes, flagged by its leading bits. */
function readEciDesignator(reader: BitReader): number {
	const first = reader.read(8);
	if ((first & 0x80) === 0) {
		return first & 0x7f;
	}
	if ((first & 0xc0) === 0x80) {
		return ((first & 0x3f) << 8) | reader.read(8);
	}
	if ((first & 0xe0) === 0xc0) {
		return ((first & 0x1f) << 16) | reader.read(16);
	}
	throw new QrUnsupportedFeatureError('eci', 'a malformed character set designator');
}

export function decodeSegments(data: Uint8Array, version: number): string {
	const reader = new BitReader(data);
	let out = '';
	let eci: number | null = null;

	while (reader.remaining >= 4) {
		const mode = reader.read(4);

		if (mode === MODE_TERMINATOR) {
			break;
		}

		switch (mode) {
			case MODE_ECI:
				eci = readEciDesignator(reader);
				continue;

			case MODE_NUMERIC: {
				let count = reader.read(charCountBits('numeric', version));
				while (count >= 3) {
					out += String(reader.read(10)).padStart(3, '0');
					count -= 3;
				}
				if (count === 2) {
					out += String(reader.read(7)).padStart(2, '0');
				} else if (count === 1) {
					out += String(reader.read(4));
				}
				continue;
			}

			case MODE_ALPHANUMERIC: {
				let count = reader.read(charCountBits('alphanumeric', version));
				while (count >= 2) {
					const pair = reader.read(11);
					out += ALPHANUMERIC_CHARS[Math.floor(pair / 45)];
					out += ALPHANUMERIC_CHARS[pair % 45];
					count -= 2;
				}
				if (count === 1) {
					out += ALPHANUMERIC_CHARS[reader.read(6)];
				}
				continue;
			}

			case MODE_BYTE: {
				const count = reader.read(charCountBits('byte', version));
				if (count * 8 > reader.remaining) {
					throw new QrDecodeError(
						'segments',
						0,
						'a segment claims more data than the symbol holds',
					);
				}
				out += decodeBytes(reader.readBytes(count), eci);
				continue;
			}

			case MODE_KANJI: {
				const count = reader.read(charCountBits('kanji', version));
				const bytes = new Uint8Array(count * 2);
				for (let i = 0; i < count; i += 1) {
					// 13 bits packed as a Shift-JIS offset, undone here.
					const value = reader.read(13);
					let sjis = Math.floor(value / 0xc0) * 0x100 + (value % 0xc0);
					sjis += sjis < 0x1f00 ? 0x8140 : 0xc140;
					bytes[i * 2] = (sjis >> 8) & 0xff;
					bytes[i * 2 + 1] = sjis & 0xff;
				}
				try {
					out += new TextDecoder('shift_jis').decode(bytes);
				} catch {
					throw new QrUnsupportedFeatureError('eci', 'Shift-JIS is not available in this runtime');
				}
				continue;
			}

			case MODE_STRUCTURED_APPEND:
				// Worth an explicit message rather than a generic one: people
				// reach this tool holding a multi-part Google export and assume
				// this is what it uses. It is not. Google splits at the payload
				// level, with a batch id inside each QR code, and each of those
				// codes is an ordinary standalone symbol.
				throw new QrUnsupportedFeatureError(
					'structured-append',
					'a symbol that is one part of a multi-symbol set, which a Google Authenticator export never is',
				);

			case MODE_FNC1_FIRST:
			case MODE_FNC1_SECOND:
				throw new QrUnsupportedFeatureError('fnc1', 'a GS1 application identifier symbol');

			default:
				throw new QrUnsupportedFeatureError(
					'mode',
					`segment mode ${mode.toString(2).padStart(4, '0')}`,
				);
		}
	}

	return out;
}
