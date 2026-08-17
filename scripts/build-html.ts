import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * Assemble the single-file offline app.
 *
 * The flagship deliverable, not a demo. One HTML file with the script and the
 * styles inlined, no external reference of any kind, openable from `file://`
 * with the network off. That is what makes the privacy claim checkable rather
 * than something a reader has to believe.
 *
 * Exported as a function so the integrity test can build it in memory. That
 * matters: it means `pnpm test` works on a clean checkout with no build step,
 * and the assertions run against exactly the bytes that ship.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface StandaloneBuildResult {
	readonly html: string;
	readonly scriptSha256: string;
	readonly styleSha256: string;
	readonly bytes: number;
}

function sha256Base64(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('base64');
}

export async function buildStandaloneHtml(): Promise<StandaloneBuildResult> {
	const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };

	const bundle = await esbuild.build({
		entryPoints: [join(ROOT, 'src/app/main.ts')],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		// The floor is what the package claims to support. Safari 16 is the
		// oldest version worth caring about for a tool people reach for once.
		target: ['es2022', 'safari16', 'firefox115', 'chrome110'],
		minify: true,
		write: false,
		legalComments: 'none',
		define: { __VERSION__: JSON.stringify(pkg.version) },
	});

	const script = bundle.outputFiles[0]?.text;
	if (script === undefined) {
		throw new Error('esbuild produced no output');
	}

	const rawCss = await readFile(join(ROOT, 'src/app/styles.css'), 'utf8');
	const style = (await esbuild.transform(rawCss, { loader: 'css', minify: true })).code;

	const template = await readFile(join(ROOT, 'src/app/index.html'), 'utf8');

	// Substitute first, then hash what actually landed in the document.
	//
	// Hashing the bundle and the stylesheet directly is the obvious way round
	// and it is quietly wrong: the template is formatted like any other file, so
	// a formatter is free to put a newline and a tab around the placeholder. The
	// element's text content is then not the string that was hashed, every hash
	// misses, and the browser silently drops both the styles and the script. The
	// page still renders, unstyled and inert, which is a confusing way to find
	// out. Reading the contents back out of the document removes the class of
	// bug entirely.
	const withContent = template.replace('<!--STYLE-->', style).replace('<!--SCRIPT-->', script);

	const styleText = /<style>([\s\S]*?)<\/style>/.exec(withContent)?.[1];
	const scriptText = /<script>([\s\S]*?)<\/script>/.exec(withContent)?.[1];
	if (styleText === undefined || scriptText === undefined) {
		throw new Error('the template must contain one <style> and one <script> element');
	}

	const scriptSha256 = sha256Base64(scriptText);
	const styleSha256 = sha256Base64(styleText);

	// A policy that names the exact hashes rather than allowing inline
	// anything. `connect-src 'none'` is the line that matters: it is the
	// privacy claim written as something the browser enforces, rather than a
	// promise about what the code happens to do.
	const csp = [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`script-src 'sha256-${scriptSha256}'`,
		`style-src 'sha256-${styleSha256}'`,
		"img-src 'self' data: blob:",
		"media-src 'self' blob: mediastream:",
		"connect-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
	].join('; ');

	const html = withContent.replace(
		'<!--CSP-->',
		`<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
	);

	return {
		html,
		scriptSha256,
		styleSha256,
		bytes: Buffer.byteLength(html, 'utf8'),
	};
}

/** Names the file so someone downloading it knows what they have. */
export const OUTPUT_NAME = 'google-auth-secret-retriever.html';

async function main(): Promise<void> {
	const result = await buildStandaloneHtml();
	const output = join(ROOT, 'dist', OUTPUT_NAME);

	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, result.html, 'utf8');

	const digest = createHash('sha256').update(result.html, 'utf8').digest('hex');
	process.stdout.write(`${output}\n  ${result.bytes} bytes\n  sha256 ${digest}\n`);
}

// Only when run directly, so importing this from a test does not write a file.
if (
	process.argv[1] !== undefined &&
	import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''))
) {
	await main();
}
