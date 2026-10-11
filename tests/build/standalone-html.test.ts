import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildStandaloneHtml } from '../../scripts/build-html.js';

/**
 * The privacy claim, enforced.
 *
 * The offline app promises that nothing you load into it can be sent anywhere.
 * That is a claim about the file, so it is checkable mechanically, and this is
 * where it gets checked: there is no external reference of any kind, no API that
 * could open a connection, and no API that could persist a secret.
 *
 * The test builds in memory rather than reading `dist/`, so it needs no build
 * step and cannot pass against a stale artefact.
 */

let html = '';
let scriptSha256 = '';
let styleSha256 = '';
let bytes = 0;

/** Just the script body, where the API assertions apply. */
let script = '';
/**
 * The markup with the script and style bodies removed.
 *
 * Attribute assertions belong here rather than to the whole file: minified
 * JavaScript legitimately contains things like `.src=` and `href`, and matching
 * those would make the check meaningless while looking strict.
 */
let markup = '';
/** The minified stylesheet, for the rules the markup depends on. */
let style = '';
/** The app's source, for the elements it looks up by id. */
let appSource = '';

/** The opening tag of the element with this id, or undefined. */
function tagWithId(id: string): string | undefined {
	return new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\sid="${id}"[^>]*>`).exec(markup)?.[0];
}

beforeAll(async () => {
	const result = await buildStandaloneHtml();
	html = result.html;
	scriptSha256 = result.scriptSha256;
	styleSha256 = result.styleSha256;
	bytes = result.bytes;

	script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
	expect(script.length).toBeGreaterThan(1000);

	markup = html
		.replace(/<script>[\s\S]*<\/script>/, '<script></script>')
		.replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
	style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
	appSource = await readFile(
		fileURLToPath(new URL('../../src/app/main.ts', import.meta.url)),
		'utf8',
	);
}, 60_000);

describe('the file is a program', () => {
	// Everything else in here checks what the file does not contain. None of it
	// notices a file that does not run at all, and one did: the build substituted
	// the bundle in with `String.replace` and a string replacement, so a `$&` in
	// the minified code, which arrives as soon as the minifier names a variable
	// `$` and compares it with `&&`, inserted the `<!--SCRIPT-->` placeholder back
	// into the middle of the script. `<!--` opens a comment in a classic script,
	// so the rest of that line vanished and the file parsed to "Unexpected end of
	// input". The page still rendered. Nothing worked, and every other assertion
	// here passed.

	it('parses as a classic script, which is how a browser will read it', () => {
		// `vm.Script` compiles without running, in sloppy script mode, which is
		// the same grammar the browser applies to an inline <script> with no type.
		expect(() => new Script(script)).not.toThrow();
	});

	it('has no build placeholder left in it', () => {
		// The specific failure above, named, so a regression says what happened
		// rather than pointing at a syntax error 60,000 characters in.
		for (const placeholder of ['<!--SCRIPT-->', '<!--STYLE-->', '<!--CSP-->']) {
			expect(html, placeholder).not.toContain(placeholder);
		}
	});

	it('has no HTML comment syntax anywhere in the script', () => {
		// Legal in a classic script and never intended here. `<!--` would silently
		// eat the rest of its line, which is exactly how the failure above hid.
		expect(script).not.toContain('<!--');
		expect(script).not.toContain('-->');
	});
});

describe('the file is self-contained', () => {
	it('has exactly one script, with no src', () => {
		const scripts = markup.match(/<script\b[^>]*>/g) ?? [];

		expect(scripts).toHaveLength(1);
		expect(scripts[0]).not.toContain('src');
	});

	it('has no element that could fetch anything', () => {
		for (const tag of ['link', 'iframe', 'object', 'embed', 'form', 'img', 'source', 'track']) {
			expect(markup, tag).not.toMatch(new RegExp(`<${tag}\\b`, 'i'));
		}
	});

	it('has no attribute pointing at another resource', () => {
		for (const attribute of ['src=', 'href=', 'action=', 'srcset=', 'poster=', 'formaction=']) {
			expect(markup, attribute).not.toContain(attribute);
		}
	});

	it('has no external reference in the inlined styles', () => {
		expect(html).not.toContain('@import');
		expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
		// A webfont would be a network request, which is the one thing this file
		// must never make. System fonts only.
		expect(html).not.toContain('@font-face');
	});

	it('mentions no URL except the repository, as inert text', () => {
		// The footer says where the source lives, which is the point of a tool
		// asking to be trusted. It is plain text, never a link, so there is
		// nothing for the page to navigate to or fetch.
		//
		// The two allowed entries are XML namespace names rather than addresses.
		// Nothing resolves them, and the SVG in this page cannot be built without
		// them. Matched exactly rather than by prefix, so a real w3.org address
		// beginning with one of them would still fail.
		const urls = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
		const allowed = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/2000/xmlns/']);

		for (const url of urls) {
			expect(allowed.has(url), `unexpected URL: ${url}`).toBe(true);
		}
	});
});

describe('the file cannot talk to a network', () => {
	// Each of these is an API that could send what the user loaded somewhere
	// else. None of them appears, which is why the claim is structural rather
	// than a promise about intent.
	const NETWORK_APIS = [
		'fetch(',
		'XMLHttpRequest',
		'WebSocket',
		'EventSource',
		'sendBeacon',
		'importScripts',
		'serviceWorker',
		'navigator.connection',
		'RTCPeerConnection',
	];

	it.each(NETWORK_APIS)('does not use %s', (api) => {
		expect(script).not.toContain(api);
	});

	it('does not evaluate strings as code', () => {
		expect(script).not.toContain('eval(');
		expect(script).not.toContain('new Function');
		// A dynamic import in a file:// document would be a fetch.
		expect(script).not.toMatch(/\bimport\s*\(/);
	});

	it('does not build markup out of strings either', () => {
		// Every node in this app is made with createElement or createElementNS, so
		// there is no string that turns into markup and no sanitiser to be right
		// about. This page renders secrets, and account names that came off a QR
		// code a stranger may have produced, which is the one setting where "we
		// only ever pass our own constants" is not a good enough answer.
		const sinks = [
			'innerHTML',
			'outerHTML',
			'insertAdjacentHTML',
			'document.write',
			'DOMParser',
			'parseFromString',
			'createContextualFragment',
			'setHTML',
			'srcdoc',
		];
		for (const sink of sinks) {
			expect(script, sink).not.toContain(sink);
		}
	});
});

describe('the file cannot persist a secret', () => {
	// A tool that leaves a 2FA secret in localStorage has undone its own
	// promise: closing the tab would no longer be enough.
	const STORAGE_APIS = [
		'localStorage',
		'sessionStorage',
		'indexedDB',
		'document.cookie',
		'caches.',
		'showSaveFilePicker',
		'requestFileSystem',
	];

	it.each(STORAGE_APIS)('does not use %s', (api) => {
		expect(script).not.toContain(api);
	});
});

describe('the content security policy', () => {
	it('is present and names the exact script and style', () => {
		expect(html).toContain('Content-Security-Policy');
		expect(html).toContain(`'sha256-${scriptSha256}'`);
		expect(html).toContain(`'sha256-${styleSha256}'`);
	});

	it('names a hash that matches what the browser will actually read', async () => {
		// The regression test for a bug that already happened once, and whose
		// symptom is nasty: the page renders, unstyled and completely inert, with
		// no error reported anywhere. The template is formatted like any other
		// file, so a formatter may wrap the placeholder in a newline and a tab.
		// Hash the bundle rather than the element's text content and every hash
		// misses, and the browser quietly drops both the styles and the script.
		const { createHash } = await import('node:crypto');
		const digest = (text: string): string =>
			createHash('sha256').update(text, 'utf8').digest('base64');

		const styleText = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
		const scriptText = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];

		expect(styleText).toBeDefined();
		expect(scriptText).toBeDefined();
		expect(digest(styleText as string)).toBe(styleSha256);
		expect(digest(scriptText as string)).toBe(scriptSha256);
	});

	it('forbids connections outright', () => {
		// The privacy claim written as something the browser enforces.
		expect(html).toContain("connect-src 'none'");
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("object-src 'none'");
		expect(html).toContain("frame-src 'none'");
	});

	it('does not fall back to allowing inline anything', () => {
		expect(html).not.toContain("'unsafe-inline'");
		expect(html).not.toContain("'unsafe-eval'");
	});

	it('still allows the camera stream and inline images', () => {
		// The camera needs mediastream:, and the re-import QR is inline SVG.
		expect(html).toContain('mediastream:');
		expect(html).toContain("img-src 'self' data: blob:");
	});
});

describe('the file can be used without a mouse and without a screen', () => {
	// None of this is visible in a screenshot, and every item below was wrong
	// once. Each one is a property of the markup the browser is handed, so it
	// is checked here rather than left to somebody remembering to test with a
	// keyboard and a screen reader before a release.

	it('is a standards mode document that says what language it is in', () => {
		// Without a doctype the page renders in quirks mode, and without `lang` a
		// screen reader guesses the pronunciation from the reader's own settings.
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(markup).toMatch(/<html lang="en">/);
		expect(markup).toMatch(/<title>[^<]+<\/title>/);
	});

	it('declares its encoding inside the first 1024 bytes', () => {
		// The HTML standard's limit for the prescan. The policy meta that follows
		// it is long, so the order matters.
		const at = html.indexOf('<meta charset="utf-8" />');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(at).toBeLessThan(1024);
		expect(at).toBeLessThan(html.indexOf('Content-Security-Policy'));
	});

	it('lets zoom alone', () => {
		const viewport = /<meta name="viewport" content="([^"]*)"/.exec(markup)?.[1];
		expect(viewport).toBe('width=device-width, initial-scale=1');
	});

	it('keeps the file input in the tab order, with a visible focus ring on its label', () => {
		// `hidden` or `display: none` takes a file input out of the tab order, and
		// then "Choose a file" cannot be reached from the keyboard at all. It is
		// clipped out of sight instead, the label is what is seen, and the label
		// wears the focus ring while the input has focus.
		const input = tagWithId('file');
		expect(input).toBeDefined();
		expect(input).toMatch(/type="file"/);
		expect(input).not.toMatch(/\shidden\b/);
		expect(input).toMatch(/class="visually-hidden"/);
		expect(markup).toMatch(/<label for="file" class="button">Choose a file<\/label>/);
		expect(style).toContain('.visually-hidden:focus-visible+label');
		const rule = /\.visually-hidden\{([^}]*)\}/.exec(style)?.[1] ?? '';
		expect(rule).toContain('position:absolute');
		expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden/);
	});

	it('has its live regions in the page from the start, never hidden', () => {
		// A region inserted, or unhidden, at the same moment as its text is often
		// not announced at all. These four exist before anything happens and only
		// their contents change.
		const regions: Readonly<Record<string, string>> = {
			alert: 'role="alert"',
			notice: 'role="status"',
			progress: 'role="status"',
			announcer: 'role="status"',
		};
		for (const [id, role] of Object.entries(regions)) {
			const tag = tagWithId(id);
			expect(tag, `#${id} is missing`).toBeDefined();
			expect(tag, `#${id}`).toContain(role);
			expect(tag, `#${id} starts hidden`).not.toMatch(/\shidden\b/);
		}
	});

	it('puts no interactive element inside another', () => {
		// The file input used to sit inside its label. A label holding a control
		// is valid HTML, but a label styled as a button with an input inside it is
		// two things to a screen reader and one to everybody else.
		for (const [, inner] of markup.matchAll(
			/<(?:label|button|a|summary)\b[^>]*>([\s\S]*?)<\/(?:label|button|a|summary)>/g,
		)) {
			expect(inner).not.toMatch(/<(?:input|button|select|textarea|a|label)\b/);
		}
		expect(markup).not.toMatch(/role="button"/);
	});

	it('has every element the program looks up by id', () => {
		// The markup and the program are joined by strings. Renaming a region on
		// one side leaves the page working and silent, which is the failure this
		// whole block is about.
		const ids = [...appSource.matchAll(/byId(?:<[^>]+>)?\('([^']+)'\)/g)].map((found) => found[1]);
		expect(ids).toContain('announcer');
		for (const id of ids) {
			expect(tagWithId(id as string), `the program looks up #${id}`).toBeDefined();
		}
	});
});

describe('the file is a reasonable download', () => {
	it('stays under the size budget', () => {
		// Enforced so growth gets noticed rather than discovered.
		expect(bytes).toBeLessThan(400 * 1024);
	});

	it('is big enough to actually contain the decoder', () => {
		// Guards the opposite failure: a build that silently produced a stub.
		expect(bytes).toBeGreaterThan(30 * 1024);
	});

	it('contains the app, not just a shell', () => {
		expect(html).toContain('Google Authenticator secret retriever');
		expect(html).toContain('otpauth-migration://');
	});
});
