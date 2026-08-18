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
	/**
	 * The dark modules and the background, as SVG paints.
	 *
	 * Read by the SVG renderer only. `renderQrPng` and `renderQrImageData` write
	 * black and white unconditionally and ignore both.
	 *
	 * Accepted: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, the keywords `none`,
	 * `transparent` and `currentColor`, and `rgb()`, `rgba()`, `hsl()`, `hsla()`,
	 * `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()` and `color()`. Anything
	 * else throws a `TypeError`, named colours such as `black` included.
	 */
	readonly dark?: string;
	readonly light?: string;
}

function matrixOf(symbol: QrSymbol | BitMatrix): BitMatrix {
	return 'matrix' in symbol ? symbol.matrix : symbol;
}

/* ── Colour ───────────────────────────────────────────────────────────────── */

/**
 * What a colour is allowed to be.
 *
 * `renderQrSvg` writes these straight into a `fill` attribute, and the README
 * shows its output being assigned to `innerHTML`, so this is the whole of what
 * stands between a caller's string and the markup. The guarantee is narrow on
 * purpose: not "CSS will like this", but "this cannot leave the attribute it is
 * written into".
 *
 * Named colours are deliberately absent, and not because they are unsafe. They
 * are not: a bare word cannot leave an attribute any more than a hex triple can.
 * The accepted set is the thing being audited, and every entry in it costs
 * something to keep proving, so 148 names have to earn their place and `#000000`
 * is four characters longer than `black`. Validity is the browser's job, not
 * this function's, which is why `rgb(0, red, 0)` gets through: it is wrong, and
 * being wrong is not what this check is for. `url()` is absent for a different
 * reason, and that one is about safety: a paint server reference is a way out of
 * the document, in a tool whose whole claim is that nothing leaves it.
 */
const COLOUR_KEYWORDS: ReadonlySet<string> = new Set(['none', 'transparent', 'currentcolor']);

/**
 * Space through tilde, at most 128 of them, tested before anything else.
 *
 * Two jobs. It keeps the output well formed for a consumer parsing it as XML
 * rather than as HTML, which escaping cannot do on its own: apart from tab, line
 * feed and carriage return, XML has no legal spelling for a C0 control inside an
 * attribute value, escaped or not. This rejects those three as well. And it
 * runs before `toLowerCase`, which is Unicode-aware: U+212A KELVIN SIGN
 * lowercases to `k`, so a keyword containing a `k` could otherwise be spelled
 * with a character CSS has never heard of and still match. None of the three
 * keywords contains one, which is luck rather than design, and this is what
 * stops that mattering if a fourth is ever added.
 *
 * The length sits above anything the syntax below can produce, so it can never
 * reject a real colour. It is there to bound the scan.
 */
const PRINTABLE_ASCII = /^[ -~]{1,128}$/;

/**
 * Hex by length, and the functional notations by shape rather than by grammar.
 *
 * The arguments are checked as a character set, not parsed. Parsing them would
 * mean an argument grammar for ten functions across two syntaxes and would buy
 * nothing: `rgb(0, red, 0)` is not dangerous, it is merely wrong, and the
 * browser already says so. The set excludes `(` and `)`, which is what rules out
 * nesting, and with it `var()`, `color-mix()` and anything smuggled into an
 * argument.
 *
 * It cannot backtrack catastrophically either. The only quantifier that runs any
 * distance is a bounded single character class, and the literal after it is `)`,
 * which the class cannot match, so the engine is never left with a second way to
 * split the input. The hex branch is three fixed-width alternatives.
 */
const COLOUR_SYNTAX =
	/^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.,%/ +-]{1,120}\))$/i;

/**
 * Defence in depth. After the check above it can never fire.
 *
 * It stays because it is a second, independent mechanism at a sink the README
 * teaches people to feed to `innerHTML`, and because a regex is exactly the kind
 * of thing somebody widens later to add a colour format. Inside a double-quoted
 * HTML attribute only `&` and `"` have to go; all five, because this returns a
 * string that also gets written to `.svg` files and `data:` URIs, where XML's
 * AttValue production forbids a bare `<`. `&#39;` rather than `&apos;`, which
 * HTML 4.01 never defined and a parser of that vintage renders literally.
 */
function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Resolve one colour option, or refuse to render.
 *
 * Coerced exactly once, and the coerced copy is what gets both checked and
 * written. Checking one string and interpolating another is the shape most
 * sanitiser bugs arrive in, and here it would be exploitable: an object whose
 * `toString` answers `#000000` the first time and something else the second
 * passes any check that reads the original again.
 *
 * Trimmed, because a colour that is not a literal usually comes from a custom
 * property, and engines have never agreed on whether `getPropertyValue` hands
 * back the whitespace around one.
 *
 * Refusing rather than substituting, which is the opposite of what a negative
 * quiet zone does below, and the difference is whether a safe degradation
 * exists. A negative quiet zone crops, which is visibly wrong. A colour has no
 * such option: SVG 2 section 4.2 says a presentation attribute holding an
 * invalid value is treated as though the property's initial value had been
 * specified, and the initial value of `fill` is black. So a substituted `light`
 * would paint a black square that no scanner reads and nothing reports, and a
 * substituted `dark` would be invisible, because black is what it was going to
 * be anyway.
 *
 * A `TypeError` rather than a `RetrieverError`, because the taxonomy is for
 * things that happen to data and this is a caller passing the wrong constant.
 * `attempt` rethrows anything that is not a `RetrieverError`, which is where a
 * bug belongs. The message names the option and never the value: a rejected
 * colour is exactly the kind of string not to hand back a second route into a
 * page.
 */
function colourOption(name: 'dark' | 'light', value: string): string {
	const colour = String(value).trim();
	if (colour === '') {
		// Its own sentence, because it is the likeliest way to arrive here by
		// accident and the general message would send somebody hunting through a
		// list of colour syntaxes for a value they never passed.
		throw new TypeError(
			`renderQrSvg: options.${name} is empty. A CSS custom property that does not exist ` +
				'reads back as an empty string, so check the name, or leave the option out to get ' +
				'the default.',
		);
	}
	if (
		!PRINTABLE_ASCII.test(colour) ||
		!(COLOUR_KEYWORDS.has(colour.toLowerCase()) || COLOUR_SYNTAX.test(colour))
	) {
		throw new TypeError(
			`renderQrSvg: options.${name} is not a colour this renderer accepts. Use a hex colour ` +
				'such as #0b76d9, one of none, transparent and currentColor, or an rgb(), rgba(), ' +
				'hsl(), hsla(), hwb(), lab(), lch(), oklab(), oklch() or color() value. Named ' +
				'colours are refused, so write black as #000000, and so are var() and url().',
		);
	}
	return escapeAttribute(colour);
}

/* ── Geometry ─────────────────────────────────────────────────────────────── */

/**
 * How many modules of border, as a number, whatever arrived.
 *
 * Not a nicety. `quietZone` is added to a module coordinate with `+`, and `+`
 * concatenates when either side is a string, so before this a string here broke
 * out of the `d` attribute exactly the way an unescaped colour broke out of
 * `fill`. The quieter half of the same defect is that `'10'`, which is the shape
 * a value takes coming out of JSON or a form field, produced a correctly sized
 * `viewBox` around a path drawn at 010 and 210: a QR code that looks right and
 * cannot be scanned.
 *
 * Coerced rather than refused, unlike a colour, because a wrong quiet zone
 * degrades visibly. A negative one crops into the symbol, which is obviously
 * broken at a glance, and that behaviour is pinned by a test whose reasoning is
 * that a renderer throwing inside a render loop takes the page with it.
 *
 * Floor rather than truncate, so the sign does not change the direction of the
 * rounding. `Math.trunc(-0.5)` is `-0`, which would mean a negative quiet zone
 * quietly stopping short of cropping at all, and the sentence above would be
 * false for exactly the values it is about.
 */
function moduleBorder(value: number | undefined): number {
	const border = Math.floor(Number(value ?? 4));
	return Number.isFinite(border) ? border : 4;
}

/** Pixels per module, on the same terms: coerced, never thrown over. */
function pixelScale(value: number | undefined): number {
	const scale = Math.round(Number(value ?? 4));
	return Number.isFinite(scale) ? Math.max(1, scale) : 4;
}

/** The numbers and the one path string an SVG of this symbol is made of. */
export interface QrSvgGeometry {
	readonly size: number;
	readonly path: string;
}

/**
 * The geometry, without the markup.
 *
 * Exported so the offline app can build the same picture with `createElementNS`
 * rather than assigning a string to `innerHTML`. A seam inside this package
 * rather than API, so it is deliberately absent from `src/index.ts` and
 * `src/qr/index.ts`.
 */
export function qrSvgGeometry(
	symbol: QrSymbol | BitMatrix,
	options: RenderOptions = {},
): QrSvgGeometry {
	const matrix = matrixOf(symbol);
	const quietZone = moduleBorder(options.quietZone);
	// `Number` because `matrix.width` reaches an attribute through `size`, and a
	// forged matrix carrying a string width would concatenate rather than add.
	const size = Number(matrix.width) + quietZone * 2;

	let path = '';
	for (let y = 0; y < matrix.height; y += 1) {
		for (let x = 0; x < matrix.width; x += 1) {
			if (matrix.get(x, y)) {
				path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
			}
		}
	}

	return { size, path };
}

/**
 * A single `<path>` with one subpath per dark module.
 *
 * Kept as separate `h1v1` subpaths rather than merged rectangles because it
 * renders identically, and merging runs is a surprising amount of code to save
 * bytes that gzip mostly recovers anyway.
 */
export function renderQrSvg(symbol: QrSymbol | BitMatrix, options: RenderOptions = {}): string {
	// Colours first, so a refusal costs nothing on a large symbol.
	const light = colourOption('light', options.light ?? '#ffffff');
	const dark = colourOption('dark', options.dark ?? '#000000');
	const { size, path } = qrSvgGeometry(symbol, options);

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
	const scale = pixelScale(options.scale);
	const quietZone = moduleBorder(options.quietZone);
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
	const scale = pixelScale(options.scale);
	const quietZone = moduleBorder(options.quietZone);
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
