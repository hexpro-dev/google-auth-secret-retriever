import { QrDecodeError } from '../errors.js';
import {
	type Poly,
	div,
	exp,
	generatorPolynomial,
	inv,
	log,
	mul,
	polyDerivative,
	polyEval,
	polyMul,
} from './galois.js';

/**
 * Reed-Solomon encoding and decoding over GF(256).
 *
 * Decoding is the classical four-step pipeline: syndromes, Berlekamp-Massey for
 * the error locator, Chien search for its roots, Forney for the magnitudes.
 *
 * On the array convention: codewords arrive most-significant-first, because
 * that is the order they sit in the symbol, while the algebra in `galois.ts`
 * indexes coefficients least-significant-first. The reversal happens here and
 * only here.
 *
 * Erasures are not handled. A QR decoder does not know which modules were
 * unreadable (it read *something* at every position), so there are no erasure
 * locations to supply, and a decode that fails cleanly is worth much more than
 * a guess at somebody's secret.
 */

/** Append `ecCount` error-correction codewords to `data`. */
export function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
	const generator = generatorPolynomial(ecCount);
	// Remainder of data * x^ecCount divided by the generator, computed the
	// usual way: a running LFSR rather than an explicit polynomial division.
	const remainder = new Uint8Array(ecCount);

	for (let i = 0; i < data.length; i += 1) {
		const factor = (data[i] as number) ^ (remainder[0] as number);
		remainder.copyWithin(0, 1);
		remainder[ecCount - 1] = 0;

		if (factor !== 0) {
			const logFactor = log(factor);
			for (let j = 0; j < ecCount; j += 1) {
				// generator is least-significant-first, so its coefficient for
				// this position is read from the far end.
				const coefficient = generator[ecCount - 1 - j] as number;
				if (coefficient !== 0) {
					remainder[j] = (remainder[j] as number) ^ exp(logFactor + log(coefficient));
				}
			}
		}
	}

	const out = new Uint8Array(data.length + ecCount);
	out.set(data, 0);
	out.set(remainder, data.length);
	return out;
}

export interface RsDecodeResult {
	readonly data: Uint8Array;
	readonly errorsCorrected: number;
}

/** Reverse a codeword run into a least-significant-first polynomial. */
function toPoly(codewords: Uint8Array): Poly {
	const poly = new Uint8Array(codewords.length);
	for (let i = 0; i < codewords.length; i += 1) {
		poly[i] = codewords[codewords.length - 1 - i] as number;
	}
	return poly;
}

/**
 * Berlekamp-Massey: the shortest linear feedback shift register that generates
 * the syndrome sequence, which is the error locator polynomial.
 */
function errorLocator(syndromes: Poly, ecCount: number): Poly {
	let current: Poly = new Uint8Array([1]);
	let previous: Poly = new Uint8Array([1]);
	let registerLength = 0;
	let shift = 1;
	let lastDiscrepancy = 1;

	for (let n = 0; n < ecCount; n += 1) {
		let discrepancy = syndromes[n] as number;
		for (let i = 1; i <= registerLength; i += 1) {
			discrepancy ^= mul(current[i] ?? 0, syndromes[n - i] as number);
		}

		if (discrepancy === 0) {
			shift += 1;
			continue;
		}

		// current -= (discrepancy / lastDiscrepancy) * x^shift * previous
		const scale = div(discrepancy, lastDiscrepancy);
		const correction = new Uint8Array(shift + previous.length);
		for (let i = 0; i < previous.length; i += 1) {
			correction[i + shift] = mul(previous[i] as number, scale);
		}

		const updated = new Uint8Array(Math.max(current.length, correction.length));
		updated.set(current);
		for (let i = 0; i < correction.length; i += 1) {
			updated[i] = (updated[i] as number) ^ (correction[i] as number);
		}

		if (2 * registerLength <= n) {
			previous = current;
			registerLength = n + 1 - registerLength;
			lastDiscrepancy = discrepancy;
			shift = 1;
		} else {
			shift += 1;
		}

		current = updated;
	}

	return current;
}

/**
 * Decode a block, correcting up to floor(ecCount / 2) symbol errors.
 *
 * Throws `QrDecodeError` when the block carries more errors than that. Detected
 * failure is the right outcome: silently returning a mis-corrected block would
 * hand back a plausible-looking secret that is wrong.
 */
export function rsDecode(received: Uint8Array, ecCount: number): RsDecodeResult {
	if (received.length <= ecCount) {
		throw new QrDecodeError('reed-solomon', 0, 'a block is shorter than its error correction');
	}

	const poly = toPoly(received);

	// S_k = r(alpha^k) for k = 0 .. ecCount-1. QR's generator starts at
	// alpha^0, so the syndrome run starts there too.
	const syndromes = new Uint8Array(ecCount);
	let anyError = false;
	for (let k = 0; k < ecCount; k += 1) {
		const value = polyEval(poly, exp(k));
		syndromes[k] = value;
		if (value !== 0) {
			anyError = true;
		}
	}

	if (!anyError) {
		return { data: received.slice(0, received.length - ecCount), errorsCorrected: 0 };
	}

	const locator = errorLocator(syndromes, ecCount);
	const maxErrors = Math.floor(ecCount / 2);
	const degree = locator.length - 1;
	if (degree > maxErrors || degree === 0) {
		throw new QrDecodeError('reed-solomon', 0, 'too many unreadable modules in one block');
	}

	// Chien search. Position j is in error when the locator has a root at
	// alpha^-j.
	const positions: number[] = [];
	for (let j = 0; j < received.length; j += 1) {
		if (polyEval(locator, exp(-j)) === 0) {
			positions.push(j);
		}
	}

	if (positions.length !== degree) {
		// The locator claims more errors than it can point at, which means the
		// received word is not within correcting distance of any codeword.
		throw new QrDecodeError('reed-solomon', 0, 'the error pattern could not be located');
	}

	// Omega = S * Lambda truncated to ecCount terms.
	const product = polyMul(syndromes, locator);
	const omega = product.subarray(0, ecCount);
	const derivative = polyDerivative(locator);

	const corrected = new Uint8Array(poly);
	for (const position of positions) {
		// X is the error locator value for this position; the magnitude comes
		// from Forney with b = 0, which is why the leading X factor appears.
		const x = exp(position);
		const xInverse = inv(x);
		const numerator = mul(x, polyEval(omega, xInverse));
		const denominator = polyEval(derivative, xInverse);

		if (denominator === 0) {
			throw new QrDecodeError('reed-solomon', 0, 'the error pattern could not be resolved');
		}

		corrected[position] = (corrected[position] as number) ^ div(numerator, denominator);
	}

	// Verify rather than trust. Berlekamp-Massey can converge on a plausible
	// locator for a word that is simply too damaged, and the corrected result
	// would then be a confident, wrong answer.
	for (let k = 0; k < ecCount; k += 1) {
		if (polyEval(corrected, exp(k)) !== 0) {
			throw new QrDecodeError(
				'reed-solomon',
				positions.length,
				'correction did not resolve the block',
			);
		}
	}

	const out = new Uint8Array(received.length);
	for (let i = 0; i < received.length; i += 1) {
		out[i] = corrected[received.length - 1 - i] as number;
	}

	return {
		data: out.subarray(0, received.length - ecCount),
		errorsCorrected: positions.length,
	};
}
