import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { readMigrationQr } from '../../src/index.js';
import { BitMatrix } from '../../src/qr/bit-matrix.js';
import { decodeQrFromImageData } from '../../src/qr/decode/decoder.js';
import { encodeQr } from '../../src/qr/encode/encoder.js';
import type { QrSymbol } from '../../src/qr/encode/encoder.js';
import { renderQrImageData, renderQrPng, renderQrSvg } from '../../src/qr/encode/render.js';
import type { ImageDataLike } from '../../src/types.js';
import { ALICE, CAROL, toMigrationUri } from '../helpers/build-payload.js';
import { expectOk } from '../helpers/expect-result.js';

/**
 * The renderers, checked as output rather than as "something came back".
 *
 * `renderQrPng` writes the file by hand: chunk framing, a CRC-32, and stored
 * deflate blocks inside a zlib wrapper, none of which a dependency checks on our
 * behalf. A file written that way is either right or quietly corrupt, and a
 * corrupt one still passes a test that only measures its length. So the CRC is
 * recomputed here the long way, the deflate framing is walked block by block,
 * and the pixels are read back with pngjs and compared against the symbol they
 * came from.
 *
 * Everything rendered here is synthetic, as everything in this repository must
 * be.
 */

const TEXT = 'HELLO WORLD';

function symbolOf(text = TEXT): QrSymbol {
	return encodeQr(text, { ecLevel: 'M' });
}

/* ── Independent implementations, for checking the ones under test ────────── */

/**
 * CRC-32 a bit at a time.
 *
 * Deliberately not the table-driven form `render.ts` uses, so a wrong table is
 * caught here rather than quietly agreeing with the code that built it.
 */
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of bytes) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

/**
 * The scanlines the symbol implies: a zero filter byte, then one grey sample per
 * pixel. Built from `getSafe`, so the quiet zone falls out of the bounds check
 * rather than out of a copy of the renderer's arithmetic.
 */
function expectedScanlines(matrix: BitMatrix, scale: number, quietZone: number): Uint8Array {
	const size = (matrix.width + quietZone * 2) * scale;
	const raw = new Uint8Array((size + 1) * size);
	for (let y = 0; y < size; y += 1) {
		const row = y * (size + 1);
		raw[row] = 0;
		for (let x = 0; x < size; x += 1) {
			const dark = matrix.getSafe(
				Math.floor(x / scale) - quietZone,
				Math.floor(y / scale) - quietZone,
			);
			raw[row + 1 + x] = dark ? 0 : 255;
		}
	}
	return raw;
}

/** Index of the first byte that differs, or -1. Keeps a failure readable. */
function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
	const shared = Math.min(actual.length, expected.length);
	for (let i = 0; i < shared; i += 1) {
		if (actual[i] !== expected[i]) {
			return i;
		}
	}
	return actual.length === expected.length ? -1 : shared;
}

/* ── PNG structure ────────────────────────────────────────────────────────── */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface PngChunk {
	readonly type: string;
	readonly body: Uint8Array;
	/** The CRC in the file, and the one this test computes for itself. */
	readonly crc: number;
	readonly computed: number;
	readonly end: number;
}

function readChunks(png: Uint8Array): PngChunk[] {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const out: PngChunk[] = [];
	let at = SIGNATURE.length;

	while (at + 12 <= png.length) {
		const length = view.getUint32(at);
		out.push({
			type: String.fromCharCode(...png.subarray(at + 4, at + 8)),
			body: png.subarray(at + 8, at + 8 + length),
			crc: view.getUint32(at + 8 + length),
			computed: crc32(png.subarray(at + 4, at + 8 + length)),
			end: at + 12 + length,
		});
		at += 12 + length;
	}

	return out;
}

interface StoredBlock {
	readonly final: boolean;
	/** Zero is a stored block. Anything else means a compressor got involved. */
	readonly type: number;
	readonly length: number;
	readonly nlen: number;
}

interface ZlibStream {
	readonly blocks: readonly StoredBlock[];
	readonly data: Uint8Array;
	readonly adler: number;
	readonly end: number;
}

/** Walk a zlib stream of stored deflate blocks, which is all `render.ts` emits. */
function readStoredZlib(stream: Uint8Array): ZlibStream {
	const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
	const blocks: StoredBlock[] = [];
	const parts: Uint8Array[] = [];
	let at = 2;
	let final = false;

	while (!final && at + 5 <= stream.length) {
		const header = stream[at] as number;
		const length = (stream[at + 1] as number) | ((stream[at + 2] as number) << 8);
		final = (header & 1) === 1;
		blocks.push({
			final,
			type: (header >>> 1) & 3,
			length,
			nlen: (stream[at + 3] as number) | ((stream[at + 4] as number) << 8),
		});
		parts.push(stream.subarray(at + 5, at + 5 + length));
		at += 5 + length;
	}

	const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		data.set(part, offset);
		offset += part.length;
	}

	return { blocks, data, adler: view.getUint32(at), end: at + 4 };
}

/* ── Pixels ───────────────────────────────────────────────────────────────── */

/** Read a PNG with an implementation that is not ours. */
function decodePng(bytes: Uint8Array): ImageDataLike {
	const png = PNG.sync.read(Buffer.from(bytes));
	return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

/** Sample the centre of every module cell, so a render can be held against its symbol. */
function sampleModules(
	image: ImageDataLike,
	modules: number,
	scale: number,
	quietZone: number,
): BitMatrix {
	const out = new BitMatrix(modules);
	for (let y = 0; y < modules; y += 1) {
		for (let x = 0; x < modules; x += 1) {
			const px = Math.floor((x + quietZone) * scale + scale / 2);
			const py = Math.floor((y + quietZone) * scale + scale / 2);
			out.set(x, y, (image.data[(py * image.width + px) * 4] as number) < 128);
		}
	}
	return out;
}

/** Every subpath in the `d` attribute, as module coordinates. */
function svgSubpaths(svg: string): Array<readonly [number, number]> {
	const attribute = /<path d="([^"]*)"/.exec(svg);
	const body = attribute === null ? '' : (attribute[1] as string);
	return [...body.matchAll(/M(-?\d+) (-?\d+)h1v1h-1z/g)].map(
		(match) => [Number(match[1]), Number(match[2])] as const,
	);
}

function darkModules(matrix: BitMatrix): Array<readonly [number, number]> {
	const out: Array<readonly [number, number]> = [];
	for (let y = 0; y < matrix.height; y += 1) {
		for (let x = 0; x < matrix.width; x += 1) {
			if (matrix.get(x, y)) {
				out.push([x, y] as const);
			}
		}
	}
	return out;
}

/* ── SVG ──────────────────────────────────────────────────────────────────── */

describe('renderQrSvg', () => {
	it('produces one well formed svg element and nothing else', () => {
		const svg = renderQrSvg(symbolOf());

		expect(svg.startsWith('<svg ')).toBe(true);
		expect(svg.endsWith('</svg>')).toBe(true);
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		// One opening bracket each for svg, rect and path, one for the close.
		expect(svg.match(/</g)).toHaveLength(4);
		expect(svg.match(/>/g)).toHaveLength(4);
		// Attribute values are the only quotes, so they have to pair up.
		expect((svg.match(/"/g) ?? []).length % 2).toBe(0);
		expect(svg).toContain('role="img"');
		// Without this a browser antialiases the module edges and a photograph
		// of the result is measurably harder to read.
		expect(svg).toContain('shape-rendering="crispEdges"');
	});

	it('draws one square per dark module, at the module positions', () => {
		const symbol = symbolOf();
		const quietZone = 4;
		const drawn = svgSubpaths(renderQrSvg(symbol, { quietZone }));

		expect(drawn).toHaveLength(symbol.matrix.countDark());
		expect(drawn).toEqual(
			darkModules(symbol.matrix).map(([x, y]) => [x + quietZone, y + quietZone] as const),
		);
	});

	it('puts nothing in the path but those squares', () => {
		// A stray command would still render, and would still be wrong.
		const attribute = /<path d="([^"]*)"/.exec(renderQrSvg(symbolOf()));
		const body = attribute === null ? 'no path' : (attribute[1] as string);

		expect(body.replace(/M-?\d+ -?\d+h1v1h-1z/g, '')).toBe('');
	});

	it('sizes the viewBox to the symbol plus a quiet zone on each side', () => {
		for (const version of [1, 5, 12]) {
			const symbol = encodeQr('x', { minVersion: version, maxVersion: version });
			for (const quietZone of [0, 1, 4, 10]) {
				const size = symbol.moduleCount + quietZone * 2;
				const svg = renderQrSvg(symbol, { quietZone });

				expect(svg, `version ${version} quiet zone ${quietZone}`).toContain(
					`viewBox="0 0 ${size} ${size}"`,
				);
				expect(svg).toContain(`<rect width="${size}" height="${size}"`);
			}
		}
	});

	it('defaults to the four module quiet zone the specification asks for', () => {
		const symbol = symbolOf();

		expect(renderQrSvg(symbol)).toBe(renderQrSvg(symbol, { quietZone: 4 }));
	});

	it('keeps the quiet zone clear', () => {
		const symbol = symbolOf();
		const quietZone = 6;
		const size = symbol.moduleCount + quietZone * 2;
		const inside = svgSubpaths(renderQrSvg(symbol, { quietZone })).filter(
			([x, y]) => x >= quietZone && y >= quietZone && x < size - quietZone && y < size - quietZone,
		);

		expect(inside).toHaveLength(symbol.matrix.countDark());
	});

	it('takes the colours it is given, and defaults to black on white', () => {
		const symbol = symbolOf();

		expect(renderQrSvg(symbol)).toContain('fill="#ffffff"');
		expect(renderQrSvg(symbol)).toContain('fill="#000000"');

		const coloured = renderQrSvg(symbol, { dark: '#0b76d9', light: 'transparent' });

		expect(coloured).toContain('fill="transparent"');
		expect(coloured).toContain('fill="#0b76d9"');
		expect(coloured).not.toContain('#000000');
		expect(coloured).not.toContain('#ffffff');
	});

	it('ignores scale, because the output is resolution free', () => {
		const symbol = symbolOf();

		expect(renderQrSvg(symbol, { scale: 1 })).toBe(renderQrSvg(symbol, { scale: 64 }));
	});

	it('interpolates a colour verbatim, so a colour has to come from the caller', () => {
		// There is no escaping here, and the assertion is what the code does
		// rather than what would be safer: a colour goes straight into an
		// attribute. That is fine for the constants this package renders with,
		// and it is the reason a colour must never be taken from user input. If
		// anyone ever wires a colour picker to this, they will land here.
		const symbol = symbolOf();
		const size = symbol.moduleCount + 8;
		const svg = renderQrSvg(symbol, { light: '#fff" onload="steal()' });

		expect(svg).toContain(`<rect width="${size}" height="${size}" fill="#fff" onload="steal()"/>`);
	});

	it('renders a bare BitMatrix the same as the symbol holding it', () => {
		const symbol = symbolOf();

		expect(renderQrSvg(symbol.matrix)).toBe(renderQrSvg(symbol));
	});
});

/* ── ImageData ────────────────────────────────────────────────────────────── */

describe('renderQrImageData', () => {
	it('sizes the image to the modules, the quiet zone and the scale', () => {
		const symbol = symbolOf();

		for (const [scale, quietZone] of [
			[1, 0],
			[1, 4],
			[3, 2],
			[7, 4],
		] as const) {
			const image = renderQrImageData(symbol, { scale, quietZone });
			const expected = (symbol.moduleCount + quietZone * 2) * scale;

			expect(image.width, `scale ${scale} quiet zone ${quietZone}`).toBe(expected);
			expect(image.height).toBe(expected);
			expect(image.data).toHaveLength(expected * expected * 4);
		}
	});

	it('defaults to four pixels a module and a four module quiet zone', () => {
		const symbol = symbolOf();
		const image = renderQrImageData(symbol);

		expect(image.width).toBe((symbol.moduleCount + 8) * 4);
	});

	it('paints every pixel to match the module under it', () => {
		const symbol = symbolOf();
		const scale = 5;
		const quietZone = 4;
		const image = renderQrImageData(symbol, { scale, quietZone });
		let wrong = 0;
		let transparent = 0;

		for (let y = 0; y < image.height; y += 1) {
			for (let x = 0; x < image.width; x += 1) {
				const offset = (y * image.width + x) * 4;
				const dark = symbol.matrix.getSafe(
					Math.floor(x / scale) - quietZone,
					Math.floor(y / scale) - quietZone,
				);
				const expected = dark ? 0 : 255;
				if (
					image.data[offset] !== expected ||
					image.data[offset + 1] !== expected ||
					image.data[offset + 2] !== expected
				) {
					wrong += 1;
				}
				if (image.data[offset + 3] !== 255) {
					transparent += 1;
				}
			}
		}

		expect(wrong).toBe(0);
		// A canvas draws an image with a zero alpha as nothing at all.
		expect(transparent).toBe(0);
	});

	it('is dark where the symbol is dark and light where it is not', () => {
		// The finder pattern's corners are fixed by the specification, so they
		// pin the orientation as well as the polarity.
		const symbol = symbolOf();
		const scale = 4;
		const quietZone = 4;
		const image = renderQrImageData(symbol, { scale, quietZone });
		const at = (mx: number, my: number) => {
			const px = (mx + quietZone) * scale + 1;
			const py = (my + quietZone) * scale + 1;
			return image.data[(py * image.width + px) * 4] as number;
		};

		// Dark ring, light separator ring, dark core.
		expect(at(0, 0)).toBe(0);
		expect(at(1, 1)).toBe(255);
		expect(at(3, 3)).toBe(0);
		// The quiet zone, one module out from each edge of the symbol.
		expect(at(-1, -1)).toBe(255);
		expect(at(symbol.moduleCount, symbol.moduleCount)).toBe(255);
	});

	it('leaves the whole quiet zone light', () => {
		const symbol = symbolOf();
		const scale = 3;
		const quietZone = 4;
		const image = renderQrImageData(symbol, { scale, quietZone });
		const border = quietZone * scale;
		let dark = 0;

		for (let y = 0; y < image.height; y += 1) {
			for (let x = 0; x < image.width; x += 1) {
				const outside =
					x < border || y < border || x >= image.width - border || y >= image.height - border;
				if (outside && image.data[(y * image.width + x) * 4] !== 255) {
					dark += 1;
				}
			}
		}

		expect(dark).toBe(0);
	});

	it('clamps a scale below one and rounds a fractional one', () => {
		// A zero or negative scale would otherwise produce an empty image, and a
		// fractional one a grid that does not line up with the pixels.
		const symbol = symbolOf();
		const modules = symbol.moduleCount + 8;

		expect(renderQrImageData(symbol, { scale: 0 }).width).toBe(modules);
		expect(renderQrImageData(symbol, { scale: 0.4 }).width).toBe(modules);
		expect(renderQrImageData(symbol, { scale: -3 }).width).toBe(modules);
		expect(renderQrImageData(symbol, { scale: 2.6 }).width).toBe(modules * 3);
	});

	it('renders a bare BitMatrix the same as the symbol holding it', () => {
		const symbol = symbolOf();
		const fromMatrix = renderQrImageData(symbol.matrix, { scale: 2 });
		const fromSymbol = renderQrImageData(symbol, { scale: 2 });

		expect(fromMatrix.width).toBe(fromSymbol.width);
		expect(firstDifference(new Uint8Array(fromMatrix.data), new Uint8Array(fromSymbol.data))).toBe(
			-1,
		);
	});
});

/* ── PNG bytes ────────────────────────────────────────────────────────────── */

describe('renderQrPng file structure', () => {
	it('starts with the PNG signature', () => {
		const png = renderQrPng(symbolOf(), { scale: 2 });

		expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
	});

	it('carries IHDR, IDAT and IEND in that order and stops there', () => {
		const png = renderQrPng(symbolOf(), { scale: 2 });
		const chunks = readChunks(png);

		expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
		// The walk has to land exactly on the end of the file. A chunk length
		// that disagrees with its body shows up here and nowhere else.
		expect(chunks[chunks.length - 1]?.end).toBe(png.length);
	});

	it('CRCs every chunk over its type and body', () => {
		const png = renderQrPng(symbolOf(), { scale: 3, quietZone: 2 });

		for (const chunk of readChunks(png)) {
			expect(chunk.crc, `${chunk.type} CRC`).toBe(chunk.computed);
		}
	});

	it('ends with the IEND chunk every PNG in the world ends with', () => {
		// Empty body, so its twelve bytes are a fixed constant. An independent
		// anchor for the CRC implementation on both sides of this test.
		const png = renderQrPng(symbolOf(), { scale: 2 });

		expect([...png.subarray(png.length - 12)]).toEqual([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
	});

	it('declares the rendered size as 8 bit greyscale, uncompressed of nothing else', () => {
		const symbol = symbolOf();
		const scale = 3;
		const quietZone = 4;
		const size = (symbol.moduleCount + quietZone * 2) * scale;
		const ihdr = readChunks(renderQrPng(symbol, { scale, quietZone }))[0] as PngChunk;
		const view = new DataView(ihdr.body.buffer, ihdr.body.byteOffset, ihdr.body.byteLength);

		expect(ihdr.body).toHaveLength(13);
		expect(view.getUint32(0)).toBe(size);
		expect(view.getUint32(4)).toBe(size);
		expect(ihdr.body[8]).toBe(8); // bit depth
		expect(ihdr.body[9]).toBe(0); // colour type: greyscale
		expect(ihdr.body[10]).toBe(0); // compression method: deflate
		expect(ihdr.body[11]).toBe(0); // filter method
		expect(ihdr.body[12]).toBe(0); // not interlaced
	});

	it('wraps the scanlines in a valid zlib stream of stored blocks', () => {
		const symbol = symbolOf();
		const scale = 3;
		const quietZone = 4;
		const idat = readChunks(renderQrPng(symbol, { scale, quietZone }))[1] as PngChunk;
		const raw = expectedScanlines(symbol.matrix, scale, quietZone);
		const stream = readStoredZlib(idat.body);

		// Deflate, 32k window, and the header's own check value.
		expect(idat.body[0]).toBe(0x78);
		expect((((idat.body[0] as number) << 8) | (idat.body[1] as number)) % 31).toBe(0);

		expect(stream.blocks.map((block) => block.type)).toEqual(stream.blocks.map(() => 0));
		for (const block of stream.blocks) {
			// LEN and NLEN are complements, and an inflater that checks will
			// reject the stream if they are not.
			expect(block.nlen).toBe(~block.length & 0xffff);
		}
		// The final flag belongs on the last block and no other.
		expect(stream.blocks.map((block) => block.final)).toEqual(
			stream.blocks.map((_, index) => index === stream.blocks.length - 1),
		);

		expect(stream.adler).toBe(adler32(raw));
		expect(stream.end).toBe(idat.body.length);
	});

	it('carries exactly the scanlines the symbol implies', () => {
		const symbol = symbolOf();
		const scale = 3;
		const quietZone = 4;
		const idat = readChunks(renderQrPng(symbol, { scale, quietZone }))[1] as PngChunk;
		const raw = expectedScanlines(symbol.matrix, scale, quietZone);
		const stream = readStoredZlib(idat.body);

		expect(stream.data).toHaveLength(raw.length);
		expect(firstDifference(stream.data, raw)).toBe(-1);
	});

	it('splits into more than one stored block once the image is over 64 kB', () => {
		// A stored deflate block holds 65535 bytes, so anything larger has to be
		// split, and getting the split wrong is the classic way a hand written
		// PNG turns out corrupt only for large images.
		const symbol = symbolOf();
		const scale = 9;
		const quietZone = 4;
		const raw = expectedScanlines(symbol.matrix, scale, quietZone);
		const idat = readChunks(renderQrPng(symbol, { scale, quietZone }))[1] as PngChunk;
		const stream = readStoredZlib(idat.body);

		expect(raw.length).toBeGreaterThan(65535);
		expect(stream.blocks.length).toBe(Math.ceil(raw.length / 65535));
		expect(stream.blocks[0]?.length).toBe(65535);
		expect(stream.blocks[0]?.final).toBe(false);
		expect(firstDifference(stream.data, raw)).toBe(-1);
		expect(stream.adler).toBe(adler32(raw));
	});
});

/* ── PNG pixels ───────────────────────────────────────────────────────────── */

describe('renderQrPng pixels', () => {
	it('decodes back to the symbol it was rendered from', () => {
		for (const [scale, quietZone] of [
			[1, 0],
			[2, 1],
			[4, 4],
			[9, 4],
		] as const) {
			const symbol = symbolOf();
			const image = decodePng(renderQrPng(symbol, { scale, quietZone }));
			const label = `scale ${scale} quiet zone ${quietZone}`;

			expect(image.width, label).toBe((symbol.moduleCount + quietZone * 2) * scale);
			expect(sampleModules(image, symbol.moduleCount, scale, quietZone).toString(), label).toBe(
				symbol.matrix.toString(),
			);
		}
	});

	it('defaults to four pixels a module and a four module quiet zone', () => {
		// Every option is optional, so a bare call is the one a consumer reaches
		// for first, and the default it lands on is the difference between a file
		// that scans and one that does not.
		const symbol = symbolOf();
		const image = decodePng(renderQrPng(symbol));

		expect(image.width).toBe((symbol.moduleCount + 8) * 4);
		expect(sampleModules(image, symbol.moduleCount, 4, 4).toString()).toBe(
			symbol.matrix.toString(),
		);
	});

	it('decodes to the same pixels renderQrImageData produces', () => {
		// Two renderers, one symbol. They walk the grid in opposite directions,
		// one over modules and one over destination pixels, so agreeing is worth
		// something.
		const symbol = symbolOf();
		const png = decodePng(renderQrPng(symbol, { scale: 5, quietZone: 3 }));
		const direct = renderQrImageData(symbol, { scale: 5, quietZone: 3 });

		expect(png.width).toBe(direct.width);
		expect(firstDifference(new Uint8Array(png.data), new Uint8Array(direct.data))).toBe(-1);
	});

	it('renders a bare BitMatrix the same as the symbol holding it', () => {
		const symbol = symbolOf();

		expect(
			firstDifference(renderQrPng(symbol.matrix, { scale: 2 }), renderQrPng(symbol, { scale: 2 })),
		).toBe(-1);
	});

	it('clamps a scale below one', () => {
		const symbol = symbolOf();
		const image = decodePng(renderQrPng(symbol, { scale: 0 }));

		expect(image.width).toBe(symbol.moduleCount + 8);
		expect(sampleModules(image, symbol.moduleCount, 1, 4).toString()).toBe(
			symbol.matrix.toString(),
		);
	});

	it('holds together at a large scale', () => {
		// Fourteen stored deflate blocks, and 862 kB of scanlines.
		const symbol = symbolOf();
		const scale = 32;
		const image = decodePng(renderQrPng(symbol, { scale }));

		expect(image.width).toBe((symbol.moduleCount + 8) * scale);
		expect(sampleModules(image, symbol.moduleCount, scale, 4).toString()).toBe(
			symbol.matrix.toString(),
		);
	});
});

/* ── Round trip ───────────────────────────────────────────────────────────── */

describe('render round trip', () => {
	it('carries text through a PNG and back out of the decoder', () => {
		const text = 'otpauth://totp/Hex:alice?secret=JBSWY3DPEHPK3PXP&issuer=Hex';
		const png = renderQrPng(encodeQr(text, { ecLevel: 'M' }), { scale: 6 });

		expect(expectOk(decodeQrFromImageData(decodePng(png))).text).toBe(text);
	});

	it('carries a synthetic export through a PNG and back into accounts', () => {
		// The strongest thing available: a payload, encoded, written out as a
		// file by hand, read back by somebody else's PNG reader, and decoded.
		// Everything in between has to be right for this to pass.
		const uri = toMigrationUri({ accounts: [ALICE, CAROL] });
		const png = renderQrPng(encodeQr(uri, { ecLevel: 'M' }), { scale: 6 });
		const scan = expectOk(readMigrationQr(decodePng(png)));

		expect(scan.uri).toBe(uri);
		expect(scan.accounts).toHaveLength(2);
		expect(scan.accounts[0]?.accountName).toBe('alice@example.com');
	});
});

/* ── Option edges ─────────────────────────────────────────────────────────── */

describe('render options at their edges', () => {
	it('drops the border entirely at a quiet zone of zero', () => {
		const symbol = symbolOf();
		const modules = symbol.moduleCount;

		expect(renderQrSvg(symbol, { quietZone: 0 })).toContain(`viewBox="0 0 ${modules} ${modules}"`);
		expect(renderQrImageData(symbol, { scale: 1, quietZone: 0 }).width).toBe(modules);

		const image = decodePng(renderQrPng(symbol, { scale: 1, quietZone: 0 }));

		expect(image.width).toBe(modules);
		expect(sampleModules(image, modules, 1, 0).toString()).toBe(symbol.matrix.toString());
	});

	it('crops into the symbol rather than throwing at a negative quiet zone', () => {
		// Nonsense input, but it arrives as a number from a caller's own options
		// object, and a QR renderer that throws inside a render loop takes the
		// page with it.
		const symbol = symbolOf();
		const trim = 2;
		const modules = symbol.moduleCount - trim * 2;
		const image = decodePng(renderQrPng(symbol, { scale: 1, quietZone: -trim }));

		expect(image.width).toBe(modules);
		// The pixels of renderQrImageData are deliberately not asserted for this
		// case: it writes past the end of a row and wraps onto the next, which is
		// a defect rather than a contract, and pinning it here would make fixing
		// it look like a regression.
		expect(() => renderQrImageData(symbol, { scale: 1, quietZone: -trim })).not.toThrow();
		expect(renderQrSvg(symbol, { quietZone: -trim })).toContain(
			`viewBox="0 0 ${modules} ${modules}"`,
		);

		const cropped = new BitMatrix(modules);
		for (let y = 0; y < modules; y += 1) {
			for (let x = 0; x < modules; x += 1) {
				cropped.set(x, y, symbol.matrix.get(x + trim, y + trim));
			}
		}

		expect(sampleModules(image, modules, 1, 0).toString()).toBe(cropped.toString());
	});
});
