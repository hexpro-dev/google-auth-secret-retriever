# google-auth-secret-retriever

Extract the `otpauth://` URIs and base32 secrets from a Google Authenticator
"Export accounts" QR code, entirely in the browser.

Zero runtime dependencies. Works on a still image or a live camera, handles the
multi-code exports Google produces for large account lists, and ships a
single-file offline app that runs from `file://` with the network off.

## Why this exists

Getting your own secrets out of Google Authenticator is a recurring need, and the
usual route is a chain of unrelated command line tools: screenshot the export
code, run `zbarimg` to get an `otpauth-migration://` string, then install a Go
program to turn that string into `otpauth://` URIs. Three installs and a
terminal, for what is a base64 decode and a protobuf parse.

All of it fits in a browser tab, with nothing sent anywhere.

## Privacy

Nothing you load is transmitted, and that is a property of the code rather than a
promise about intent. There is no call to `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource` or `sendBeacon` anywhere in this package, and nothing is written to
`localStorage`, `sessionStorage`, `indexedDB` or a cookie.

The offline build goes further: one HTML file with no external reference of any
kind, and a content security policy including `connect-src 'none'` so the browser
enforces it rather than taking the code's word. All of that is asserted by
`tests/build/standalone-html.test.ts`, which fails if any of it stops being true.

The check worth doing yourself is the simplest one. Turn your connection off and
use it anyway.

## The offline app

Download `google-auth-secret-retriever.html` from the releases page and open it.
No install, no build, no node.

Everything works from `file://` except the camera, which some browsers will not
grant to a file origin. Dropping or pasting a screenshot always works. If you
want the camera, serve the file over http instead:

```
python3 -m http.server
```

then open the address it prints.

## Library

```
pnpm add @hexpro/google-auth-secret-retriever
```

```ts
import { readMigrationQr } from '@hexpro/google-auth-secret-retriever';
import { imageDataFromFile } from '@hexpro/google-auth-secret-retriever/dom';

const image = await imageDataFromFile(file);
const scan = readMigrationQr(image);

if (!scan.ok) {
	// Every failure carries a `code` from a closed union, so you can say
	// something specific rather than "could not read that".
	console.warn(scan.error.code, scan.error.message);
} else {
	for (const account of scan.value.accounts) {
		account.secret; // base32, as an authenticator displays it
		account.issuer;
		account.accountName;
		account.algorithm; // SHA1 | SHA256 | SHA512 | MD5
		account.digits; // 6 | 8
		account.type; // totp | hotp
		account.counter; // HOTP only
		account.uri; // rebuilt otpauth:// link
	}
}
```

Already have the text, from `zbarimg` or any generic QR reader?

```ts
import { parseMigrationUri } from '@hexpro/google-auth-secret-retriever';

const scan = parseMigrationUri('otpauth-migration://offline?data=...');
```

### Live codes

```ts
import { generateTotp } from '@hexpro/google-auth-secret-retriever';

const { code, secondsRemaining } = await generateTotp(account.secretBytes, {
	algorithm: account.algorithm,
	digits: account.digits,
});
```

HMAC comes from WebCrypto, so there is no hand-rolled crypto here. MD5 is refused
rather than shipped, because browsers cannot compute it and Google has never been
observed to emit it; the secret and its parameters are still returned.

### A QR code to import elsewhere

```ts
import { encodeQr, renderQrSvg } from '@hexpro/google-auth-secret-retriever';

element.innerHTML = renderQrSvg(encodeQr(account.uri));
```

Inline SVG, so it is crisp at any pixel density, prints, and needs no canvas or
blob URL. `renderQrPng` and `renderQrImageData` are there when you need pixels.

### Multi-code exports

Google splits a large export across several QR codes, each carrying a batch
identifier, a total and its own index. `BatchCollector` merges them in any order
and tells you what is missing.

```ts
import { BatchCollector } from '@hexpro/google-auth-secret-retriever';

const collector = new BatchCollector();
const outcome = collector.add(scan.value);

outcome.status; // added | duplicate | conflict | foreign-batch | size-mismatch
outcome.progress; // { size, captured, missing, complete }
collector.accounts; // merged and deduplicated
```

A re-scan of a part you already have is a `duplicate` and harmless, which matters
with a camera. The same index with different contents is a `conflict`, and a
different batch identifier is refused rather than merged: two exports taken
minutes apart can hold overlapping accounts with different secrets, and combining
them would produce a list that never existed on the phone.

### Camera

```ts
import { isCameraAvailable, startCameraScan } from '@hexpro/google-auth-secret-retriever/dom';

if (isCameraAvailable()) {
	const handle = await startCameraScan({
		video: videoElement,
		onResult: (result) => {
			if (result.ok) {
				// result.value.text is the decoded otpauth-migration:// URI
			}
		},
	});
	// Two starts in the same second (a re-render, a double tap) both reach
	// getUserMedia, and the later one owns the camera. Never let a superseded
	// handle replace a live one: its stop() does nothing, so the camera would be
	// left running with nothing able to turn it off.
	if (!handle.superseded) {
		live = handle;
	}
	// handle.stop() releases the camera. It is also released on tab hide, and if
	// the track ends underneath the scan.
}
```

The stream is asked for at 1920 by 1080 as a soft constraint, which a smaller
sensor simply ignores, and the frame reaches the decoder at up to
`MAX_CAMERA_PIXELS` rather than being reduced to a fixed long edge. That matters
for a large export: a ten-account code is 125 modules across, and at a 720-pixel
frame it arrives below the Nyquist limit, unreadable however good the camera is.
Each frame gets five rungs of the decode ladder, which is what covers both
polarities at both of the cheap scales, and the gap after a decode is at least as
long as that decode took, so the decoder never holds much more than half the
thread however slow the device is. The `live` status carries the settings the
camera really gave you.

## What it supports

Reads QR versions 1 to 40, all four error-correction levels, and numeric,
alphanumeric, byte and kanji segments including ECI. Handles rotation at any
angle, mirrored images, dark-mode screenshots, brightness gradients, mild blur,
sensor noise, screen glare, and photographs taken off-axis.

Not supported, deliberately: Micro QR and rMQR, structured append, GS1 and FNC1,
and more than one symbol per image. Google's multi-code export is handled at the
payload level instead, one code per image, which is what it actually is. Each of
these is refused with a message saying so rather than failing obscurely.

## The period field

Every account reports a 30 second period, and it is not decoded from anything.
The migration payload has fields for the secret, the name, the issuer, the
algorithm, the digit count, the type and the counter, and no field for the period.
Google Authenticator uses 30 seconds for everything it exports, so that is what
this reports, and `periodSource` sits beside it so the value is never mistaken for
data that came out of the QR code.

`defaultsApplied` does the same job for the three enums Google routinely leaves
unspecified, so you can tell "SHA1 because the payload said SHA1" from "SHA1
because the payload said nothing".

## Handle the export code carefully

A Google Authenticator export code carries the secret key for every account
inside it. Anyone who photographs it, or finds the screenshot in a photo backup a
year from now, can generate those codes indefinitely. Changing the account
password does not revoke it, and neither does removing the app.

Do this on a device you trust, delete the screenshot afterwards including from the
recently deleted folder, and treat anything you copy out of it the way you would
treat a password.

## Development

```
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build       # library to dist/
pnpm build:html  # the single-file offline app
```

Correctness is pinned to published test vectors rather than to round trips against
itself: RFC 4648 for base32 and base64, RFC 4226 and RFC 6238 for the one-time
passwords, ISO/IEC 18004 for Reed-Solomon and the worked symbol example, and a
module-for-module comparison of the encoder against an independent implementation
across every version, mask and error-correction level. An encoder and decoder
written from one misreading of a specification agree with each other perfectly,
which is why each layer is anchored separately.

Every test fixture is generated synthetically. No real Google Authenticator export
may be committed to this repository; see `CLAUDE.md`.

## Licence

MIT. See `LICENSE`.
