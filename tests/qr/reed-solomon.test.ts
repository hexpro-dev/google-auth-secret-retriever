import { describe, expect, it } from 'vitest';
import { QrDecodeError } from '../../src/errors.js';
import { exp, generatorPolynomial, log, mul, polyEval } from '../../src/qr/galois.js';
import { rsDecode, rsEncode } from '../../src/qr/reed-solomon.js';

/** Deterministic, so a failure is reproducible from the seed in the name. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

describe('GF(256) against published values', () => {
	it('has alpha^8 equal to 0x1D, which is the primitive polynomial folding back', () => {
		expect(exp(8)).toBe(0x1d);
	});

	it('agrees with the QR specification on the first few powers of alpha', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(exp)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
	});

	it('is a cyclic group of order 255', () => {
		expect(exp(255)).toBe(1);
		expect(exp(0)).toBe(1);
	});

	it('has exp and log as inverses across the whole field', () => {
		for (let i = 1; i < 256; i += 1) {
			expect(exp(log(i))).toBe(i);
		}
	});

	it('multiplies commutatively and associatively', () => {
		const random = seededRandom(12345);
		for (let trial = 0; trial < 500; trial += 1) {
			const a = Math.floor(random() * 256);
			const b = Math.floor(random() * 256);
			const c = Math.floor(random() * 256);

			expect(mul(a, b)).toBe(mul(b, a));
			expect(mul(mul(a, b), c)).toBe(mul(a, mul(b, c)));
		}
	});

	it('matches the published degree-10 generator polynomial', () => {
		// The specification lists this one by its alpha exponents:
		// 0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45.
		// An external anchor: the field arithmetic cannot be self-consistently
		// wrong and still reproduce these.
		const published = [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
		const generator = generatorPolynomial(10);

		// Stored least-significant-first, so compare against the reverse.
		const exponents = [...generator].reverse().map(log);
		expect(exponents).toEqual(published);
	});

	it('builds a generator whose roots are the first `degree` powers of alpha', () => {
		for (const degree of [7, 10, 13, 17, 22, 26, 30]) {
			const generator = generatorPolynomial(degree);
			for (let i = 0; i < degree; i += 1) {
				expect(polyEval(generator, exp(i)), `degree ${degree}, root ${i}`).toBe(0);
			}
		}
	});
});

describe('rsEncode against ISO/IEC 18004 Annex I', () => {
	it('reproduces the worked example', () => {
		// The specification's version 1-M example: these 16 data codewords
		// produce these 10 error-correction codewords. This is the strongest
		// single anchor in the whole QR implementation, because it pins the
		// field, the generator and the division all at once.
		const data = new Uint8Array([
			0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
			0x11,
		]);
		const expected = [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55];

		const encoded = rsEncode(data, 10);

		expect([...encoded.subarray(0, 16)]).toEqual([...data]);
		expect([...encoded.subarray(16)]).toEqual(expected);
	});
});

describe('rsDecode', () => {
	const data = new Uint8Array(Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff));

	it('returns the data unchanged when there are no errors', () => {
		const result = rsDecode(rsEncode(data, 10), 10);

		expect(result.data).toEqual(data);
		expect(result.errorsCorrected).toBe(0);
	});

	it('corrects a single error anywhere in the block', () => {
		for (let position = 0; position < data.length + 10; position += 1) {
			const corrupted = rsEncode(data, 10);
			corrupted[position] = (corrupted[position] as number) ^ 0x5a;

			const result = rsDecode(corrupted, 10);
			expect(result.data, `error at ${position}`).toEqual(data);
			expect(result.errorsCorrected).toBe(1);
		}
	});

	it('corrects exactly t errors over many seeded trials', () => {
		const random = seededRandom(987654);

		for (let trial = 0; trial < 300; trial += 1) {
			const ecCount = [10, 16, 22, 26, 30][trial % 5]!;
			const t = Math.floor(ecCount / 2);
			const encoded = rsEncode(data, ecCount);

			const positions = new Set<number>();
			while (positions.size < t) {
				positions.add(Math.floor(random() * encoded.length));
			}
			for (const position of positions) {
				// Always a non-zero delta, or it would not be an error.
				encoded[position] = (encoded[position] as number) ^ (1 + Math.floor(random() * 255));
			}

			const result = rsDecode(encoded, ecCount);
			expect(result.data, `trial ${trial}`).toEqual(data);
			expect(result.errorsCorrected).toBe(t);
		}
	});

	it('reports the number of errors it actually corrected', () => {
		const encoded = rsEncode(data, 20);
		encoded[3] = (encoded[3] as number) ^ 0x11;
		encoded[9] = (encoded[9] as number) ^ 0x22;
		encoded[17] = (encoded[17] as number) ^ 0x33;

		expect(rsDecode(encoded, 20).errorsCorrected).toBe(3);
	});

	it('detects rather than mis-corrects when there are more than t errors', () => {
		// The important property. A confident wrong answer here becomes a
		// secret that silently generates codes which never work.
		const random = seededRandom(24680);
		let detected = 0;
		const trials = 200;

		for (let trial = 0; trial < trials; trial += 1) {
			const ecCount = 10;
			const encoded = rsEncode(data, ecCount);

			const positions = new Set<number>();
			while (positions.size < Math.floor(ecCount / 2) + 2) {
				positions.add(Math.floor(random() * encoded.length));
			}
			for (const position of positions) {
				encoded[position] = (encoded[position] as number) ^ (1 + Math.floor(random() * 255));
			}

			try {
				const result = rsDecode(encoded, ecCount);
				// Being beyond the correcting radius, a decode that succeeds
				// must not claim to have produced the original data.
				expect(result.data).not.toEqual(data);
			} catch (error) {
				expect(error).toBeInstanceOf(QrDecodeError);
				detected += 1;
			}
		}

		// Detection is not guaranteed for every pattern beyond the radius, but
		// it should be the overwhelmingly common outcome.
		expect(detected).toBeGreaterThan(trials * 0.9);
	});

	it('rejects a block shorter than its error correction', () => {
		expect(() => rsDecode(new Uint8Array(5), 10)).toThrow(QrDecodeError);
	});

	it('round trips across every error-correction size the specification uses', () => {
		for (let ecCount = 7; ecCount <= 30; ecCount += 1) {
			const encoded = rsEncode(data, ecCount);
			expect(rsDecode(encoded, ecCount).data, `ecCount ${ecCount}`).toEqual(data);
		}
	});
});
