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
import type { AppNotice, AppState } from './state.js';

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

/** The name an account goes by on this page, for headings and announcements. */
function accountLabel(account: OtpAccount): string {
	return account.displayIssuer || account.accountName || 'this account';
}

/* ── Announcements ────────────────────────────────────────────────────────── */

let announceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Say something to a screen reader without putting it on screen.
 *
 * For the things a sighted person sees happen elsewhere: a button that briefly
 * reads "Copied", or cards appearing further down the page. The region is
 * emptied first and filled a moment later, so the same sentence twice in a row
 * (copying the same secret again) is announced twice rather than once.
 */
function announce(text: string): void {
	const region = byId('announcer');
	region.textContent = '';
	clearTimeout(announceTimer);
	announceTimer = setTimeout(() => {
		region.textContent = text;
	}, 100);
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
	ingest(scan.value);
}

function handleText(text: string): void {
	const scan = parseMigrationUri(text);
	if (!scan.ok) {
		store.notify({ kind: 'error', text: scan.error.message, detail: scan.error.code });
		return;
	}
	ingest(scan.value);
}

/**
 * Fold a scan in, and say what it added.
 *
 * The cards appear below the controls, so somebody who chose a file with a
 * screen reader would otherwise hear nothing at all: focus comes back to the
 * file button and the page changes somewhere else.
 */
function ingest(scan: Parameters<AppStore['ingest']>[0]): void {
	const before = store.current.accounts.length;
	const notice = store.ingest(scan);
	if (notice !== null) {
		store.notify(notice);
		return;
	}
	const added = store.current.accounts.length - before;
	if (added > 0) {
		announce(added === 1 ? 'Added 1 account.' : `Added ${added} accounts.`);
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

/**
 * A copy button that says it worked.
 *
 * The visible "Copied" is a change to the focused button's own text, which
 * most screen readers do not read out, so the same news also goes to the
 * announcer. `copied` names what was copied and whose it was.
 */
function copyButton(label: string, copied: string, value: () => string): HTMLButtonElement {
	const button = element('button', 'ghost', label);
	button.type = 'button';
	const refused = (): void => {
		button.textContent = 'Press Ctrl or Cmd and C';
		announce('Copying is blocked here. Select the text and press Ctrl or Cmd and C.');
	};
	button.addEventListener('click', () => {
		// No clipboard at all, rather than a refusal: an http page that is not
		// localhost. Optional chaining alone would make the click do nothing.
		if (navigator.clipboard === undefined) {
			refused();
			return;
		}
		navigator.clipboard.writeText(value()).then(() => {
			button.textContent = 'Copied';
			announce(`Copied ${copied}.`);
			setTimeout(() => {
				button.textContent = label;
			}, 1200);
		}, refused);
	});
	return button;
}

function accountCard(account: OtpAccount, index: number, revealed: boolean): HTMLElement {
	const card = element('article', 'card');
	const name = accountLabel(account);

	// Every card has a Reveal and two Copy buttons, so each one is described by
	// its card's heading. A description rather than a longer name, so the name
	// stays the visible word and speech input can still say "Copy secret".
	const headingId = `account-${index}`;
	const describe = <T extends HTMLElement>(node: T, key: string): T => {
		node.setAttribute('aria-describedby', headingId);
		node.dataset.key = `${key}-${index}`;
		return node;
	};

	const header = element('header');
	const heading = element(
		'h3',
		undefined,
		account.displayIssuer || account.accountName || 'Account',
	);
	heading.id = headingId;
	header.append(heading);
	if (account.displayIssuer !== '' && account.accountName !== '') {
		const accountName = element('p', 'dim', account.accountName);
		accountName.dir = 'ltr';
		header.append(accountName);
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
	if (revealed) {
		secret.textContent = account.secret;
	} else {
		// Up to 32 bullets, which a screen reader reads out one by one. They are
		// a picture of a hidden value, so they are hidden from it and replaced
		// by the word.
		const mask = element('span', undefined, '•'.repeat(Math.min(account.secret.length, 32)));
		mask.setAttribute('aria-hidden', 'true');
		secret.append(mask, element('span', 'visually-hidden', 'Hidden'));
	}
	secretRow.append(secret);

	// The label says what pressing it will do, so it is not also marked as a
	// pressed toggle: "Hide, pressed" reads as a contradiction.
	const reveal = describe(element('button', 'ghost', revealed ? 'Hide' : 'Reveal'), 'reveal');
	reveal.type = 'button';
	reveal.addEventListener('click', () => store.toggleReveal(index));
	secretRow.append(
		reveal,
		describe(
			copyButton('Copy secret', `the secret for ${name}`, () => account.secret),
			'secret',
		),
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
		describe(
			copyButton('Copy link', `the link for ${name}`, () => account.uri),
			'link',
		),
	);
	card.append(element('p', 'label', 'otpauth link'), uriRow);

	// The re-import code, likewise.
	const qrWrap = element('details', 'qr');
	qrWrap.append(
		describe(element('summary', undefined, 'Show a QR code to scan into another app'), 'qr'),
	);
	if (revealed) {
		const holder = element('div', 'qr-holder');
		// Inline SVG: crisp at any density, printable, and no blob URL, which
		// matters for a page that promises nothing leaves the tab.
		holder.append(qrElement(encodeQr(account.uri, { ecLevel: 'M' }), name));
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

/** What the notice regions are showing, so an unchanged notice is not announced again. */
let shownNotice: AppNotice | null = null;

function sameNotice(a: AppNotice | null, b: AppNotice | null): boolean {
	return a?.kind === b?.kind && a?.text === b?.text && a?.detail === b?.detail;
}

/**
 * Errors go to the alert region and everything else to the status one.
 *
 * Both regions are in the page from the start and only their contents change,
 * and only when the notice does. `render` runs on every state change, revealing
 * a secret included, and rewriting a live region with the same words announces
 * them again. With the camera on, the same "already captured" notice arrives
 * many times a second.
 */
function renderNotice(notice: AppNotice | null): void {
	if (sameNotice(notice, shownNotice)) {
		return;
	}
	shownNotice = notice;

	const alert = byId('alert');
	const status = byId('notice');
	alert.textContent = '';
	status.textContent = '';
	if (notice === null) {
		return;
	}

	const box = element('div', `notice ${notice.kind}`);
	box.append(element('p', undefined, notice.text));
	if (notice.detail !== undefined) {
		box.append(element('p', 'mono small dim', notice.detail));
	}
	(notice.kind === 'error' ? alert : status).append(box);
}

function render(state: AppState): void {
	renderNotice(state.notice);

	const progress = byId('progress');
	const summary = batchSummary(state.batch) ?? '';
	if (progress.textContent !== summary) {
		progress.textContent = '';
		if (summary !== '') {
			progress.append(element('p', 'progress', summary));
		}
	}

	const results = byId('results');

	// The cards are rebuilt on every change, so the button somebody just pressed
	// is replaced by a new one. Without this, pressing Reveal from the keyboard
	// drops focus to the top of the document. The open QR panels are carried
	// across for the same reason.
	const focused = document.activeElement;
	const focusKey =
		focused instanceof HTMLElement && results.contains(focused) ? focused.dataset.key : undefined;
	const openKeys = new Set(
		Array.from(results.querySelectorAll<HTMLElement>('details[open] > summary')).map(
			(summary) => summary.dataset.key,
		),
	);

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

	for (const summary of Array.from(results.querySelectorAll<HTMLElement>('details > summary'))) {
		if (openKeys.has(summary.dataset.key)) {
			(summary.parentElement as HTMLDetailsElement).open = true;
		}
	}
	if (focusKey !== undefined) {
		results.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
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
			store.setStage('decoding');
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
				store.setStage('decoding');
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
			// Clears the last notice first, as the image routes do, so the same
			// error for a second attempt is announced rather than taken as unchanged.
			store.setStage('decoding');
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
		// The button that was pressed is in a toolbar that has just been hidden,
		// so focus would otherwise fall to the top of the document.
		byId('accounts-heading').focus();
		announce('Cleared. The account list is empty.');
	});

	byId('version').textContent = typeof __VERSION__ === 'string' ? __VERSION__ : '';

	startCodeTimer();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', wire);
} else {
	wire();
}
