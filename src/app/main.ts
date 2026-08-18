import {
	imageDataFromBlob,
	imageDataFromClipboard,
	isCameraAvailable,
	startCameraScan,
} from '../dom/index.js';
import type { CameraScanHandle } from '../dom/index.js';
import { isRetrieverError } from '../errors.js';
import { readMigrationQr } from '../index.js';
import { parseMigrationUri } from '../migration/parse-uri.js';
import { generateHotp } from '../otp/hotp.js';
import { generateTotp } from '../otp/totp.js';
import { encodeQr } from '../qr/encode/encoder.js';
import type { QrSymbol } from '../qr/encode/encoder.js';
import { qrSvgGeometry } from '../qr/encode/render.js';
import type { OtpAccount } from '../types.js';
import { AppStore, batchSummary, groupCode } from './state.js';
import type { AppState } from './state.js';

/**
 * The offline app.
 *
 * Vanilla DOM on purpose. This is built into one HTML file that has to open
 * from `file://` with the network off, which is the whole proof of the privacy
 * claim, and a framework would be most of the download for a screen with one
 * list on it.
 */

declare const __VERSION__: string;

const store = new AppStore();
let camera: CameraScanHandle | null = null;

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) {
		node.className = className;
	}
	if (text !== undefined) {
		// textContent, never markup. Account names come from a QR code a
		// stranger may have produced, and this page renders secrets.
		node.textContent = text;
	}
	return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The re-import code as elements rather than as a string.
 *
 * `renderQrSvg` returns markup and the library has to keep doing that, but this
 * page renders secrets, so it builds the same picture with `createElementNS` and
 * `setAttribute`, neither of which parses anything. Same rule as `element()`
 * above: nothing here becomes markup by being a string.
 *
 * `xmlns` is set even though a namespaced element does not need it, so that the
 * serialised form is still a standalone SVG file. Someone who copies this
 * element out of the page, or drags it onto the desktop, gets something that
 * opens.
 *
 * The name goes in an `aria-label` rather than an SVG `<title>` because a
 * `<title>` also renders as a hover tooltip over the code, and because
 * `aria-label` on `role="img"` is the accessible name every engine agrees on.
 * It names the account, since a page with eight of these otherwise reads as
 * eight identically labelled images.
 */
function qrElement(symbol: QrSymbol, name: string): SVGSVGElement {
	const { size, path } = qrSvgGeometry(symbol, { quietZone: 4 });

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', SVG_NS);
	svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', `QR code for ${name}`);

	const background = document.createElementNS(SVG_NS, 'rect');
	background.setAttribute('width', String(size));
	background.setAttribute('height', String(size));
	background.setAttribute('fill', '#ffffff');

	const modules = document.createElementNS(SVG_NS, 'path');
	modules.setAttribute('d', path);
	modules.setAttribute('fill', '#000000');

	svg.append(background, modules);
	return svg;
}

function byId<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (node === null) {
		throw new Error(`missing element: ${id}`);
	}
	return node as T;
}

/* ── Decoding ─────────────────────────────────────────────────────────────── */

async function handleBlob(blob: Blob): Promise<void> {
	store.setStage('reading');
	try {
		const image = await imageDataFromBlob(blob);
		store.setStage('decoding');
		handleImage(image);
	} catch (error) {
		store.notify({
			kind: 'error',
			text: isRetrieverError(error) ? error.message : 'That file could not be opened as an image.',
			detail: isRetrieverError(error) ? error.code : undefined,
		});
	}
}

/**
 * Decode budget for a still image.
 *
 * Stated at the call site rather than left to the library default, because this
 * caller knows something the library cannot: the "decoding" stage is already on
 * screen, so a second and a half spent on a difficult photograph is time the
 * person can see being used, and giving up in 400 ms is not a kindness.
 */
const DECODE_BUDGET_MS = 1500;

function handleImage(image: Parameters<typeof readMigrationQr>[0]): void {
	const scan = readMigrationQr(image, { timeBudgetMs: DECODE_BUDGET_MS });
	if (!scan.ok) {
		store.notify({ kind: 'error', text: scan.error.message, detail: scan.error.code });
		return;
	}
	const notice = store.ingest(scan.value);
	if (notice !== null) {
		store.notify(notice);
	}
}

function handleText(text: string): void {
	const scan = parseMigrationUri(text);
	if (!scan.ok) {
		store.notify({ kind: 'error', text: scan.error.message, detail: scan.error.code });
		return;
	}
	const notice = store.ingest(scan.value);
	if (notice !== null) {
		store.notify(notice);
	}
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

/** One labelled value in the parameter table. */
function detail(label: string, value: string, note?: string): HTMLElement {
	const row = element('div', 'detail');
	row.append(element('dt', undefined, label));
	const dd = element('dd', 'mono');
	dd.dir = 'ltr';
	dd.textContent = value;
	if (note !== undefined) {
		dd.append(element('span', 'note', ` ${note}`));
	}
	row.append(dd);
	return row;
}

function copyButton(label: string, value: () => string): HTMLButtonElement {
	const button = element('button', 'ghost', label);
	button.type = 'button';
	button.addEventListener('click', () => {
		void navigator.clipboard?.writeText(value()).then(
			() => {
				const original = button.textContent;
				button.textContent = 'Copied';
				setTimeout(() => {
					button.textContent = original;
				}, 1200);
			},
			() => {
				button.textContent = 'Press Ctrl or Cmd and C';
			},
		);
	});
	return button;
}

function accountCard(account: OtpAccount, index: number, revealed: boolean): HTMLElement {
	const card = element('article', 'card');

	const header = element('header');
	header.append(
		element('h3', undefined, account.displayIssuer || account.accountName || 'Account'),
	);
	if (account.displayIssuer !== '' && account.accountName !== '') {
		const name = element('p', 'dim', account.accountName);
		name.dir = 'ltr';
		header.append(name);
	}
	header.append(element('span', 'index mono', String(index + 1).padStart(2, '0')));
	card.append(header);

	// The live code, or an honest explanation of why there is not one.
	const codeRow = element('div', 'code-row');
	const code = element('output', 'code mono');
	code.dir = 'ltr';
	code.id = `code-${index}`;
	code.setAttribute('aria-live', 'off');
	codeRow.append(code);
	const remaining = element('span', 'dim mono');
	remaining.id = `remaining-${index}`;
	codeRow.append(remaining);
	card.append(codeRow);

	// The secret.
	const secretRow = element('div', 'secret-row');
	const secret = element('code', 'secret mono');
	secret.dir = 'ltr';
	// Base32 is left-to-right text. Without this it renders in the wrong visual
	// order inside a right-to-left document, and somebody types the wrong key.
	secret.textContent = revealed ? account.secret : '•'.repeat(Math.min(account.secret.length, 32));
	secretRow.append(secret);

	const reveal = element('button', 'ghost', revealed ? 'Hide' : 'Reveal');
	reveal.type = 'button';
	reveal.setAttribute('aria-pressed', String(revealed));
	reveal.addEventListener('click', () => store.toggleReveal(index));
	secretRow.append(
		reveal,
		copyButton('Copy secret', () => account.secret),
	);
	card.append(element('p', 'label', 'Secret (base32)'), secretRow);

	// Everything else the export carried.
	const details = element('dl', 'details');
	details.append(
		detail('Issuer', account.issuer || '(none)'),
		detail('Account', account.name || '(none)'),
		detail('Type', account.type.toUpperCase()),
		detail(
			'Algorithm',
			account.algorithm,
			account.defaultsApplied.includes('algorithm') ? 'assumed; the export did not say' : undefined,
		),
		detail(
			'Digits',
			String(account.digits),
			account.defaultsApplied.includes('digits') ? 'assumed; the export did not say' : undefined,
		),
		// Not decoded from anything. The migration payload has no period field.
		detail('Period', `${account.period} s`, 'not stored in the export; Google always uses 30'),
	);
	if (account.type === 'hotp') {
		details.append(detail('Counter', String(account.counter)));
	}
	card.append(details);

	// The URI, masked with the secret because it contains the secret.
	const uriRow = element('div', 'uri-row');
	const uri = element('code', 'uri mono');
	uri.dir = 'ltr';
	uri.textContent = revealed ? account.uri : account.uri.replace(/secret=[^&]*/, 'secret=•••');
	uriRow.append(
		uri,
		copyButton('Copy link', () => account.uri),
	);
	card.append(element('p', 'label', 'otpauth link'), uriRow);

	// The re-import code, likewise.
	const qrWrap = element('details', 'qr');
	qrWrap.append(element('summary', undefined, 'Show a QR code to scan into another app'));
	if (revealed) {
		const holder = element('div', 'qr-holder');
		// Inline SVG: crisp at any density, printable, and no blob URL, which
		// matters for a page that promises nothing leaves the tab.
		holder.append(
			qrElement(
				encodeQr(account.uri, { ecLevel: 'M' }),
				account.displayIssuer || account.accountName || 'this account',
			),
		);
		qrWrap.append(holder);
		qrWrap.append(
			element(
				'p',
				'dim small',
				'Anyone who photographs this has the account. Close it when you are done.',
			),
		);
	} else {
		qrWrap.append(element('p', 'dim small', 'Reveal the secret first.'));
	}
	card.append(qrWrap);

	return card;
}

function render(state: AppState): void {
	const notice = byId('notice');
	notice.textContent = '';
	notice.hidden = state.notice === null;
	if (state.notice !== null) {
		notice.className = `notice ${state.notice.kind}`;
		notice.append(element('p', undefined, state.notice.text));
		if (state.notice.detail !== undefined) {
			notice.append(element('p', 'mono small dim', state.notice.detail));
		}
	}

	const progress = byId('progress');
	const summary = batchSummary(state.batch);
	progress.textContent = summary ?? '';
	progress.hidden = summary === null;

	const results = byId('results');
	results.textContent = '';

	const count = byId('count');
	count.textContent =
		state.accounts.length === 0
			? ''
			: `${state.accounts.length} ${state.accounts.length === 1 ? 'account' : 'accounts'}`;

	byId('actions').hidden = state.accounts.length === 0;

	for (const [index, account] of state.accounts.entries()) {
		results.append(accountCard(account, index, state.revealed.has(index)));
	}

	byId<HTMLButtonElement>('camera-toggle').textContent = state.cameraOn
		? 'Stop the camera'
		: 'Use the camera';
}

/* ── Live codes ───────────────────────────────────────────────────────────── */

/**
 * One timer for the whole page, aimed at the next period boundary.
 *
 * Never `setInterval(1000)`: it drifts, and a code that changes a second late
 * is a code somebody has already typed.
 */
function startCodeTimer(): void {
	const tick = async (): Promise<void> => {
		const { accounts } = store.current;

		for (const [index, account] of accounts.entries()) {
			const code = document.getElementById(`code-${index}`);
			const remaining = document.getElementById(`remaining-${index}`);
			if (code === null) {
				continue;
			}

			try {
				if (account.type === 'hotp') {
					code.textContent = groupCode(
						await generateHotp(account.secretBytes, BigInt(account.counter), {
							algorithm: account.algorithm,
							digits: account.digits,
						}),
					);
					if (remaining !== null) {
						remaining.textContent = 'does not rotate';
					}
					continue;
				}

				const result = await generateTotp(account.secretBytes, {
					algorithm: account.algorithm,
					digits: account.digits,
					period: account.period,
				});
				code.textContent = groupCode(result.code);
				if (remaining !== null) {
					remaining.textContent = `${result.secondsRemaining} s`;
				}
			} catch (error) {
				code.textContent = '------';
				if (remaining !== null) {
					remaining.textContent = isRetrieverError(error) ? error.message : 'unavailable';
				}
			}
		}

		// Aim at the next whole second, and re-aim every time, so a suspended
		// laptop or an NTP correction is absorbed rather than accumulated.
		const delay = 1000 - (Date.now() % 1000) + 20;
		setTimeout(() => void tick(), delay);
	};

	void tick();
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */

function wire(): void {
	store.subscribe(render);

	byId<HTMLInputElement>('file').addEventListener('change', (event) => {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		// `multiple` matters: a three-part export is three screenshots, and
		// people will select all of them at once.
		void (async () => {
			for (const file of files) {
				await handleBlob(file);
			}
			input.value = '';
		})();
	});

	const drop = byId('drop');
	let depth = 0;
	const setDragging = (on: boolean): void => {
		drop.classList.toggle('dragging', on);
	};

	// Counted, because entering a child element fires dragleave on the parent
	// and a boolean flickers.
	window.addEventListener('dragenter', (event) => {
		event.preventDefault();
		depth += 1;
		setDragging(true);
	});
	window.addEventListener('dragover', (event) => event.preventDefault());
	window.addEventListener('dragleave', () => {
		depth = Math.max(0, depth - 1);
		if (depth === 0) {
			setDragging(false);
		}
	});
	window.addEventListener('drop', (event) => {
		event.preventDefault();
		depth = 0;
		setDragging(false);

		const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
			file.type.startsWith('image/'),
		);
		if (files.length > 0) {
			void (async () => {
				for (const file of files) {
					await handleBlob(file);
				}
			})();
			return;
		}

		const text = event.dataTransfer?.getData('text/plain');
		if (text !== undefined && text.trim() !== '') {
			handleText(text);
		}
	});

	// The path most people use: screenshot to clipboard, then paste.
	window.addEventListener('paste', (event) => {
		void (async () => {
			const image = await imageDataFromClipboard(event as unknown as { clipboardData: never });
			if (image !== null) {
				store.setStage('decoding');
				handleImage(image);
				return;
			}
			const text = event.clipboardData?.getData('text/plain');
			if (text !== undefined && text.trim() !== '') {
				handleText(text);
			}
		})();
	});

	// A button rather than a form. A form is a navigation primitive, and the
	// integrity test asserts the file contains none, which is a stronger and
	// simpler statement than a form that happens to be prevented.
	byId('paste-read').addEventListener('click', () => {
		const field = byId<HTMLTextAreaElement>('paste-text');
		if (field.value.trim() !== '') {
			handleText(field.value);
			field.value = '';
		}
	});

	const cameraToggle = byId<HTMLButtonElement>('camera-toggle');
	const video = byId<HTMLVideoElement>('video');

	if (!isCameraAvailable()) {
		// Hidden rather than shown broken. On a file:// origin some browsers
		// will not grant a camera at all, and the image and paste routes always
		// work, so an affordance that cannot succeed is worse than none.
		cameraToggle.hidden = true;
		byId('camera-note').hidden = false;
	}

	cameraToggle.addEventListener('click', () => {
		if (camera !== null) {
			camera.stop();
			camera = null;
			store.setCamera(false);
			video.hidden = true;
			return;
		}

		void (async () => {
			try {
				const started = await startCameraScan({
					video,
					onResult: (result) => {
						if (result.ok) {
							handleText(result.value.text);
						}
					},
				});
				// A later start won the race and owns the camera. Keeping this handle
				// would replace the live one with a handle whose `stop` does nothing, and
				// then no click could turn the camera off again.
				if (started.superseded) {
					return;
				}
				camera = started;
				store.setCamera(true);
				video.hidden = false;
			} catch (error) {
				store.notify({
					kind: 'error',
					text: isRetrieverError(error) ? error.message : 'The camera could not be started.',
					detail: isRetrieverError(error) ? error.code : undefined,
				});
			}
		})();
	});

	byId('reveal-all').addEventListener('click', () => store.revealAll(true));
	byId('mask-all').addEventListener('click', () => store.revealAll(false));
	byId('clear').addEventListener('click', () => {
		store.clear();
		if (camera !== null) {
			camera.stop();
			camera = null;
			store.setCamera(false);
			video.hidden = true;
		}
	});

	byId('version').textContent = typeof __VERSION__ === 'string' ? __VERSION__ : '';

	startCodeTimer();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', wire);
} else {
	wire();
}
