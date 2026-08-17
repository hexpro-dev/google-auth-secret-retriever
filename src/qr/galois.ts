/**
 * Arithmetic in GF(256), the field QR's error correction is built on.
 *
 * Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1, which is 0x11D, and generator
 * alpha = 2. Those two choices are fixed by the QR specification; changing
 * either produces a field that is perfectly valid mathematics and completely
 * incompatible with every QR reader in existence.
 *
 * Addition and subtraction in a field of characteristic 2 are both XOR, which
 * is why there is no `sub` here and why several formulas below drop a minus
 * sign that a textbook would show.
 */

export const PRIMITIVE = 0x11d;
export const FIELD_SIZE = 256;

/** exp[i] = alpha^i, doubled in length so callers can skip a modulo. */
const EXP = new Uint8Array(512);
/** log[alpha^i] = i. log[0] is undefined and never read. */
const LOG = new Uint8Array(256);

{
	let value = 1;
	for (let i = 0; i < 255; i += 1) {
		EXP[i] = value;
		LOG[value] = i;
		value <<= 1;
		if (value >= 256) {
			value ^= PRIMITIVE;
		}
	}
	for (let i = 255; i < 512; i += 1) {
		EXP[i] = EXP[i - 255] as number;
	}
}

export function exp(power: number): number {
	// Powers arrive negative from the Forney step, so normalise first.
	return EXP[((power % 255) + 255) % 255] as number;
}

export function log(value: number): number {
	if (value === 0) {
		throw new Error('log(0) is undefined in GF(256)');
	}
	return LOG[value] as number;
}

export function mul(a: number, b: number): number {
	if (a === 0 || b === 0) {
		return 0;
	}
	return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

export function div(a: number, b: number): number {
	if (b === 0) {
		throw new Error('division by zero in GF(256)');
	}
	if (a === 0) {
		return 0;
	}
	return EXP[((LOG[a] as number) - (LOG[b] as number) + 255) % 255] as number;
}

export function inv(a: number): number {
	if (a === 0) {
		throw new Error('0 has no inverse in GF(256)');
	}
	return EXP[255 - (LOG[a] as number)] as number;
}

/* ── Polynomials ──────────────────────────────────────────────────────────── */

/**
 * Polynomials are `Uint8Array`s with index i holding the coefficient of x^i.
 *
 * Least-significant-first, which is the opposite of how QR codewords arrive on
 * the wire. The conversion happens once, at the edge, in `reed-solomon.ts`.
 * Mixing the two conventions inside the algebra is a reliable way to produce
 * code that works for symmetric inputs and fails for everything else.
 */
export type Poly = Uint8Array;

/** Drop leading zero coefficients (the high-degree end). */
export function polyTrim(poly: Poly): Poly {
	let degree = poly.length - 1;
	while (degree > 0 && poly[degree] === 0) {
		degree -= 1;
	}
	return poly.subarray(0, degree + 1);
}

export function polyAdd(a: Poly, b: Poly): Poly {
	const out = new Uint8Array(Math.max(a.length, b.length));
	out.set(a);
	for (let i = 0; i < b.length; i += 1) {
		out[i] = (out[i] as number) ^ (b[i] as number);
	}
	return out;
}

export function polyMul(a: Poly, b: Poly): Poly {
	if (a.length === 0 || b.length === 0) {
		return new Uint8Array(0);
	}
	const out = new Uint8Array(a.length + b.length - 1);
	for (let i = 0; i < a.length; i += 1) {
		const ai = a[i] as number;
		if (ai === 0) {
			continue;
		}
		for (let j = 0; j < b.length; j += 1) {
			out[i + j] = (out[i + j] as number) ^ mul(ai, b[j] as number);
		}
	}
	return out;
}

export function polyScale(poly: Poly, scalar: number): Poly {
	const out = new Uint8Array(poly.length);
	for (let i = 0; i < poly.length; i += 1) {
		out[i] = mul(poly[i] as number, scalar);
	}
	return out;
}

/** Horner evaluation at a field element. */
export function polyEval(poly: Poly, x: number): number {
	let result = 0;
	for (let i = poly.length - 1; i >= 0; i -= 1) {
		result = mul(result, x) ^ (poly[i] as number);
	}
	return result;
}

/**
 * The formal derivative.
 *
 * In characteristic 2 every even-index term vanishes, so this is not the
 * derivative from calculus and cannot be checked against one. It is the
 * algebraic definition, and it is what Forney's formula needs.
 */
export function polyDerivative(poly: Poly): Poly {
	if (poly.length <= 1) {
		return new Uint8Array(1);
	}
	const out = new Uint8Array(poly.length - 1);
	for (let i = 1; i < poly.length; i += 1) {
		out[i - 1] = i % 2 === 1 ? (poly[i] as number) : 0;
	}
	return out;
}

const GENERATOR_CACHE = new Map<number, Poly>();

/**
 * The generator polynomial for `degree` error-correction codewords:
 * (x - alpha^0)(x - alpha^1)...(x - alpha^(degree-1)).
 *
 * QR starts the run of roots at alpha^0, which matters in the Forney step
 * later; a code that starts at alpha^1 needs a different exponent there.
 */
export function generatorPolynomial(degree: number): Poly {
	const cached = GENERATOR_CACHE.get(degree);
	if (cached !== undefined) {
		return cached;
	}

	let poly: Poly = new Uint8Array([1]);
	for (let i = 0; i < degree; i += 1) {
		poly = polyMul(poly, new Uint8Array([exp(i), 1]));
	}

	GENERATOR_CACHE.set(degree, poly);
	return poly;
}
