import type { ImageDataLike } from '../../types.js';
import type { BitMatrix } from '../bit-matrix.js';
import type { QrSymbol } from './encoder.js';

/**
 * Turning a symbol into something you can look at or scan.
 *
 * SVG is the primary output. It is crisp at any pixel density, prints, costs a
 * few hundred bytes, and can be inlined into a page without a canvas, a blob
 * URL or a relaxed content security policy. For a page whose whole claim is
 * that nothing leaves the tab, not needing a blob URL is worth something.
 */

export interface RenderOptions {
	/** Pixels per module. Ignored by the SVG renderer, which is resolution-free. */
	readonly scale?: number;
	/**
	 * Light border, in modules.
	 *
	 * Four is the specification's minimum and it is not decorative: scanners
	 * use it to find the symbol's edge, and a code pasted flush against dark
	 * page furniture often will not read at all.
	 */
	readonly quietZone?: number;
	readonly dark?: string;
	readonly light?: string;
}

function matrixOf(symbol: QrSymbol | BitMatrix): BitMatrix {
	return 'matrix' in symbol ? symbol.matrix : symbol;
}

/**
 * A single `<path>` with one subpath per dark module.
 *
 * Kept as separate `h1v1` subpaths rather than merged rectangles because it
 * renders identically, and merging runs is a surprising amount of code to save
 * bytes that gzip mostly recovers anyway.
 */
export function renderQrSvg(symbol: QrSymbol | BitMatrix, options: RenderOptions = {}): string {
	const matrix = matrixOf(symbol);
	const quietZone = options.quietZone ?? 4;
	const dark = options.dark ?? '#000000';
	const light = options.light ?? '#ffffff';
	const size = matrix.width + quietZone * 2;

	let path = '';
	for (let y = 0; y < matrix.height; y += 1) {
		for (let x = 0; x < matrix.width; x += 1) {
			if (matrix.get(x, y)) {
				path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
			}
		}
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`,
		` shape-rendering="crispEdges" role="img">`,
		`<rect width="${size}" height="${size}" fill="${light}"/>`,
		`<path d="${path}" fill="${dark}"/>`,
		`</svg>`,
	].join('');
}

/** RGBA pixels, for a canvas or for feeding straight back into the decoder. */
export function renderQrImageData(
	symbol: QrSymbol | BitMatrix,
	options: RenderOptions = {},
): ImageDataLike {
	const matrix = matrixOf(symbol);
	const scale = Math.max(1, Math.round(options.scale ?? 4));
	const quietZone = options.quietZone ?? 4;
	const modules = matrix.width + quietZone * 2;
	const size = modules * scale;

	const data = new Uint8ClampedArray(size * size * 4);
	data.fill(255);

	for (let y = 0; y < matrix.height; y += 1) {
		for (let x = 0; x < matrix.width; x += 1) {
			if (!matrix.get(x, y)) {
				continue;
			}
			const px = (x + quietZone) * scale;
			const py = (y + quietZone) * scale;
			for (let dy = 0; dy < scale; dy += 1) {
				let offset = ((py + dy) * size + px) * 4;
				for (let dx = 0; dx < scale; dx += 1) {
					data[offset] = 0;
					data[offset + 1] = 0;
					data[offset + 2] = 0;
					offset += 4;
				}
			}
		}
	}

	return { data, width: size, height: size };
}

/* ── PNG ──────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) {
		crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let i = 0; i < bytes.length; i += 1) {
		a = (a + (bytes[i] as number)) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(body.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	for (let i = 0; i < 4; i += 1) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(body, 8);
	view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
	return out;
}

/**
 * A greyscale PNG, written by hand.
 *
 * Deflate is used in "stored" mode, which is to say not compressed at all. That
 * is a legal deflate stream, it is about sixty lines instead of a compressor,
 * and a QR code at a sensible scale is a few tens of kilobytes either way. The
 * point is a downloadable file with no dependency and no canvas, not a small
 * one.
 */
export function renderQrPng(symbol: QrSymbol | BitMatrix, options: RenderOptions = {}): Uint8Array {
	const matrix = matrixOf(symbol);
	const scale = Math.max(1, Math.round(options.scale ?? 4));
	const quietZone = options.quietZone ?? 4;
	const modules = matrix.width + quietZone * 2;
	const size = modules * scale;

	// One filter byte per row, then one byte per pixel.
	const raw = new Uint8Array((size + 1) * size);
	for (let y = 0; y < size; y += 1) {
		const rowStart = y * (size + 1);
		raw[rowStart] = 0;
		const my = Math.floor(y / scale) - quietZone;
		for (let x = 0; x < size; x += 1) {
			const mx = Math.floor(x / scale) - quietZone;
			const dark =
				my >= 0 && mx >= 0 && my < matrix.height && mx < matrix.width && matrix.get(mx, my);
			raw[rowStart + 1 + x] = dark ? 0 : 255;
		}
	}

	// zlib container around stored deflate blocks.
	const blocks: Uint8Array[] = [];
	const MAX_BLOCK = 65535;
	for (let offset = 0; offset < raw.length; offset += MAX_BLOCK) {
		const length = Math.min(MAX_BLOCK, raw.length - offset);
		const last = offset + length >= raw.length;
		const header = new Uint8Array(5);
		header[0] = last ? 1 : 0;
		header[1] = length & 0xff;
		header[2] = (length >> 8) & 0xff;
		header[3] = ~length & 0xff;
		header[4] = (~length >> 8) & 0xff;
		blocks.push(header, raw.subarray(offset, offset + length));
	}

	const bodyLength = blocks.reduce((sum, part) => sum + part.length, 0);
	const zlib = new Uint8Array(2 + bodyLength + 4);
	zlib[0] = 0x78;
	zlib[1] = 0x01;
	let position = 2;
	for (const part of blocks) {
		zlib.set(part, position);
		position += part.length;
	}
	new DataView(zlib.buffer).setUint32(position, adler32(raw));

	const ihdr = new Uint8Array(13);
	const ihdrView = new DataView(ihdr.buffer);
	ihdrView.setUint32(0, size);
	ihdrView.setUint32(4, size);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // greyscale
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const parts = [
		signature,
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib),
		chunk('IEND', new Uint8Array(0)),
	];

	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}

	return out;
}
