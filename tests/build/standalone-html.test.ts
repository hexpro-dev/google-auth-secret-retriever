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
}, 60_000);

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
		const urls = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
		const allowed = /^https?:\/\/(www\.w3\.org\/2000\/svg)/;

		for (const url of urls) {
			expect(allowed.test(url), `unexpected URL: ${url}`).toBe(true);
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
