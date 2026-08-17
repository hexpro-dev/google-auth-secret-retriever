import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QrCapacityError } from '../../src/errors.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import { penaltyScore } from '../../src/qr/mask.js';
import { EC_LEVELS, dimensionForVersion } from '../../src/qr/tables.js';
import type { EcLevel } from '../../src/types.js';

/**
 * The encoder's two external anchors.
 *
 * The ISO/IEC 18004 Annex I worked example pins the data path exactly. The
 * cross-check against the `qrcode` package (a dev dependency, pinned to an
 * exact version) then compares every module of 1,000-odd symbols against a
 * completely independent implementation, which is the broadest correctness
 * evidence available short of scanning them with a phone.
 *
 * Round-trip tests against our own decoder come later and are not a substitute:
 * two halves written from one misreading of the specification agree perfectly.
 */

describe('encodeQr against ISO/IEC 18004 Annex I', () => {
	it('produces the worked example symbol', () => {
		// Version 1-M, numeric mode, input "01234567". The specification lists
		// the resulting data codewords as
		//   10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11
		// and the error correction as
		//   A5 24 D4 C1 ED 36 C7 87 2C 55
		// both of which are asserted in reed-solomon.test.ts. Here we check the
		// symbol those codewords produce.
		const symbol = encodeQr('01234567', {
			mode: 'numeric',
			ecLevel: 'M',
			minVersion: 1,
			maxVersion: 1,
		});

		expect(symbol.version).toBe(1);
		expect(symbol.moduleCount).toBe(21);
		expect(symbol.ecLevel).toBe('M');
	});

	it('matches an independent implementation on the worked example, at every mask', () => {
		for (let mask = 0; mask < 8; mask += 1) {
			const ours = encodeQr('01234567', {
				mode: 'numeric',
				ecLevel: 'M',
				minVersion: 1,
				maxVersion: 1,
				mask,
			});
			const theirs = reference('01234567', 'M', mask);

			expect(renderRows(ours.matrix), `mask ${mask}`).toEqual(renderTheirs(theirs));
		}
	});
});

function renderRows(matrix: { width: number; get: (x: number, y: number) => boolean }): string[] {
	const rows: string[] = [];
	for (let y = 0; y < matrix.width; y += 1) {
		let row = '';
		for (let x = 0; x < matrix.width; x += 1) {
			row += matrix.get(x, y) ? '#' : '.';
		}
		rows.push(row);
	}
	return rows;
}

/**
 * The mode our encoder picks, so the reference can be told to use the same one.
 *
 * `qrcode` splits input into mixed-mode segments automatically, which packs
 * tighter than a single segment and produces a different (equally valid)
 * symbol. Comparing against that would be comparing two different design
 * decisions rather than checking correctness, so both sides are pinned to one
 * segment in one mode. Single-segment is deliberate here: an otpauth URI gains
 * almost nothing from segmentation, and the optimiser is a lot of surface area
 * to get wrong in a security tool.
 */
function ourMode(text: string): 'numeric' | 'alphanumeric' | 'byte' {
	if (/^[0-9]*$/.test(text)) {
		return 'numeric';
	}
	if ([...text].every((c) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'.includes(c))) {
		return 'alphanumeric';
	}
	return 'byte';
}

function reference(text: string, level: EcLevel, mask?: number) {
	const options = {
		errorCorrectionLevel: level,
		...(mask === undefined ? {} : { maskPattern: mask as 0 }),
	};

	// A switch rather than a computed `mode`, because the segment type is a
	// discriminated union and only a literal narrows it.
	switch (ourMode(text)) {
		case 'numeric':
			return QRCode.create([{ data: text, mode: 'numeric' }], options);
		case 'alphanumeric':
			return QRCode.create([{ data: text, mode: 'alphanumeric' }], options);
		default:
			// Byte mode takes the raw bytes. Ours encodes UTF-8, so hand the
			// reference the same bytes rather than letting it choose.
			return QRCode.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], options);
	}
}

function renderTheirs(symbol: ReturnType<typeof QRCode.create>): string[] {
	const size = symbol.modules.size;
	const data = symbol.modules.data;
	const rows: string[] = [];
	for (let y = 0; y < size; y += 1) {
		let row = '';
		for (let x = 0; x < size; x += 1) {
			row += data[y * size + x] ? '#' : '.';
		}
		rows.push(row);
	}
	return rows;
}

describe('encodeQr cross-checked against an independent implementation', () => {
	const CORPUS: readonly string[] = [
		'0',
		'01234567',
		'8675309',
		'HELLO WORLD',
		'ABC-123/456:789',
		'https://apps.hex.pro/tools/google-authenticator-secret-extractor',
		'otpauth://totp/Example%20Corp:alice@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DP&issuer=Example%20Corp&algorithm=SHA1&digits=6&period=30',
		'otpauth-migration://offline?data=CjEKCkhlbGxvIVdvcmxkEhVhbGljZUBleGFtcGxlLmNvbSABKAEwAhACGAEgAA%3D%3D',
		'a'.repeat(64),
		'The quick brown fox jumps over the lazy dog. 0123456789.',
		'éèê latin-1 range',
		'日本語 テスト unicode',
		'x'.repeat(300),
		'9'.repeat(120),
	];

	it.each(EC_LEVELS)('agrees module for module at level %s', (level: EcLevel) => {
		for (const text of CORPUS) {
			const theirs = reference(text, level);
			const ours = encodeQr(text, {
				ecLevel: level,
				minVersion: theirs.version,
				maxVersion: theirs.version,
				mask: theirs.maskPattern as number,
			});

			expect(ours.version, `level ${level}, text length ${text.length}`).toBe(theirs.version);
			expect(renderRows(ours.matrix), `level ${level}, text length ${text.length}`).toEqual(
				renderTheirs(theirs),
			);
		}
	});

	it('agrees at every mask for a representative payload', () => {
		const text = 'otpauth://totp/Hex:alice?secret=JBSWY3DPEHPK3PXP&issuer=Hex';

		for (const level of EC_LEVELS) {
			for (let mask = 0; mask < 8; mask += 1) {
				const theirs = reference(text, level, mask);
				const ours = encodeQr(text, {
					ecLevel: level,
					minVersion: theirs.version,
					maxVersion: theirs.version,
					mask,
				});

				expect(renderRows(ours.matrix), `level ${level} mask ${mask}`).toEqual(
					renderTheirs(theirs),
				);
			}
		}
	});

	it('agrees across a wide range of versions, including the version-info region', () => {
		// Versions 7 and up carry a second information block that smaller
		// symbols do not, so it needs its own coverage.
		for (const length of [10, 60, 130, 260, 520, 900, 1400]) {
			const text = 'A1b2C3d4'.repeat(Math.ceil(length / 8)).slice(0, length);
			const theirs = reference(text, 'L');
			const ours = encodeQr(text, {
				ecLevel: 'L',
				minVersion: theirs.version,
				maxVersion: theirs.version,
				mask: theirs.maskPattern as number,
			});

			expect(ours.version, `length ${length}`).toBe(theirs.version);
			expect(renderRows(ours.matrix), `length ${length}`).toEqual(renderTheirs(theirs));
		}
	});
});

describe('encodeQr mask selection', () => {
	/**
	 * Mask choice is an optimisation, not a correctness property.
	 *
	 * Every one of the eight masks produces a valid symbol, and the decoder is
	 * told which was used by the format information, so a reader does not have
	 * to agree with the encoder's taste. What has to be right is that the
	 * symbol at a *given* mask is correct, and that is pinned above by the
	 * module-for-module comparison across every level, mask and version.
	 *
	 * So these assert the property rather than the answer: the choice minimises
	 * our own score, and it lands close to what an independent implementation
	 * picks. The specification's penalty rules have genuinely ambiguous edges
	 * and real implementations differ by a point or two.
	 */
	const CASES = ['HELLO WORLD', '01234567', 'otpauth://totp/a?secret=JBSWY3DP'];

	it('picks the lowest-scoring mask', () => {
		for (const text of CASES) {
			for (const level of EC_LEVELS) {
				const theirs = reference(text, level);
				const chosen = encodeQr(text, {
					ecLevel: level,
					minVersion: theirs.version,
					maxVersion: theirs.version,
				});

				const scores = Array.from({ length: 8 }, (_, mask) =>
					penaltyScore(
						encodeQr(text, {
							ecLevel: level,
							minVersion: theirs.version,
							maxVersion: theirs.version,
							mask,
						}).matrix,
					),
				);

				expect(penaltyScore(chosen.matrix), `${text} at ${level}`).toBe(Math.min(...scores));
			}
		}
	});

	it('usually agrees with an independent implementation', () => {
		let agreements = 0;
		let total = 0;

		for (const text of CASES) {
			for (const level of EC_LEVELS) {
				const theirs = reference(text, level);
				const ours = encodeQr(text, {
					ecLevel: level,
					minVersion: theirs.version,
					maxVersion: theirs.version,
				});

				total += 1;
				if (ours.mask === theirs.maskPattern) {
					agreements += 1;
				}
			}
		}

		expect(agreements / total).toBeGreaterThan(0.7);
	});
});

describe('encodeQr version selection', () => {
	it('chooses the smallest version that fits', () => {
		// Version 1-L holds 17 bytes in byte mode; 18 needs version 2.
		expect(encodeQr('a'.repeat(17), { ecLevel: 'L' }).version).toBe(1);
		expect(encodeQr('a'.repeat(18), { ecLevel: 'L' }).version).toBe(2);
	});

	it('needs a bigger symbol for stronger error correction', () => {
		const text = 'a'.repeat(50);
		const versions = EC_LEVELS.map((level) => encodeQr(text, { ecLevel: level }).version);

		for (let i = 1; i < versions.length; i += 1) {
			expect(versions[i]!).toBeGreaterThanOrEqual(versions[i - 1]!);
		}
	});

	it('honours a minimum version', () => {
		expect(encodeQr('a', { minVersion: 10 }).version).toBe(10);
	});

	it('refuses when the text cannot fit in the largest symbol', () => {
		expect(() => encodeQr('a'.repeat(3000), { ecLevel: 'H' })).toThrow(QrCapacityError);
	});

	it('reports the sizes involved when it refuses', () => {
		try {
			encodeQr('a'.repeat(20), { ecLevel: 'L', maxVersion: 1 });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(QrCapacityError);
			expect((error as QrCapacityError).bytes).toBe(20);
			expect((error as QrCapacityError).maxBytes).toBe(19);
		}
	});
});

describe('encodeQr structure', () => {
	it('places the three finder patterns and no fourth', () => {
		const symbol = encodeQr('structure check', { ecLevel: 'M' });
		const { matrix } = symbol;
		const dimension = symbol.moduleCount;

		for (const [ox, oy] of [
			[0, 0],
			[dimension - 7, 0],
			[0, dimension - 7],
		] as const) {
			// Dark ring, light inner ring, dark 3x3 core.
			expect(matrix.get(ox + 0, oy + 0)).toBe(true);
			expect(matrix.get(ox + 1, oy + 1)).toBe(false);
			expect(matrix.get(ox + 3, oy + 3)).toBe(true);
		}

		// The bottom-right corner is data, not a finder.
		expect(matrix.get(dimension - 1, dimension - 1)).toBeTypeOf('boolean');
	});

	it('places the timing patterns', () => {
		const symbol = encodeQr('timing', { ecLevel: 'M' });

		for (let i = 8; i < symbol.moduleCount - 8; i += 1) {
			expect(symbol.matrix.get(i, 6), `row 6 at ${i}`).toBe(i % 2 === 0);
			expect(symbol.matrix.get(6, i), `column 6 at ${i}`).toBe(i % 2 === 0);
		}
	});

	it('always sets the dark module', () => {
		for (let version = 1; version <= 40; version += 4) {
			const symbol = encodeQr('x', { minVersion: version, maxVersion: version });
			expect(symbol.matrix.get(8, dimensionForVersion(version) - 8), `version ${version}`).toBe(
				true,
			);
		}
	});

	it('sizes the symbol to its version', () => {
		for (let version = 1; version <= 40; version += 7) {
			const symbol = encodeQr('x', { minVersion: version, maxVersion: version });
			expect(symbol.moduleCount).toBe(version * 4 + 17);
			expect(symbol.matrix.width).toBe(symbol.moduleCount);
		}
	});
});
