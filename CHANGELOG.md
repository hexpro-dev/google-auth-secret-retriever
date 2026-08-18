# Changelog

## Unreleased

Reading rate, measured on a 408-case corpus of degraded captures: 77% to 92%
with nothing else changed, and 54% to 91% on the camera path. No case in the
corpus returns text that was not encoded, before or after.

### Fixed

- **The single-file offline app did not run.** `scripts/build-html.ts`
  substituted the bundle into the template with `String.replace` and a string
  replacement, and a string replacement reads `$` patterns: `$&` means "the text
  that was matched". The minifier names a variable `$` sooner or later, and the
  first time one is compared with `&&` after it, `o!==$&&o!==X` came out of the
  build as `o!==<!--SCRIPT-->&o!==X`. `<!--` opens a comment in a classic script,
  so the rest of that line went with it and the whole file parsed to "Unexpected
  end of input". The page rendered, the styles applied, and nothing worked. Every
  other assertion in the build test passed, because they all check what the file
  does not contain and none of them checked that it runs. The replacements are
  functions now, which have no pattern syntax, and the build test compiles the
  script with `node:vm` and refuses any surviving placeholder or HTML comment.
  Confirmed fixed by driving the built file in headless Chrome: a link is read,
  two accounts appear, and the re-import code renders and decodes back to the
  `otpauth://` URI it was built from.
- **A colour going straight into an SVG attribute.** `renderQrSvg` interpolated
  `dark` and `light` verbatim, so a value containing a double quote closed the
  attribute and could open an element after it, and the README shows that output
  being assigned to `innerHTML`. Colours are now checked against a list of
  accepted forms and escaped on the way in. A value that is not on the list
  throws, rather than being substituted, because substituting is silent and so is
  doing nothing: SVG 2 section 4.2 treats a presentation attribute holding an
  invalid value as though the property's initial value had been specified, and
  the initial value of `fill` is black, so a bad `light` turns the symbol into a
  black square that no scanner reads and nothing reports, and a bad `dark` is
  invisible because black is what it was going to be anyway. Nothing shipped
  was exploitable, because the only caller passed no colours at all, which is the
  reason to fix it now rather than after somebody wires a colour picker to it.
- **A quiet zone that arrived as a string being concatenated into the path.**
  `quietZone` is added to a module coordinate, and `+` concatenates when either
  side is a string, so a string here landed inside the `d` attribute the same way
  a colour landed inside `fill`. The quieter half of the same defect: `'10'`,
  which is the shape a value takes coming out of JSON or a form field, produced a
  correctly sized `viewBox` around a path drawn at 010 and 210, so the code
  looked right and could not be scanned. `quietZone` and `scale` are now coerced
  to numbers, `quietZone` in all three renderers and `scale` in the two that read
  it, and a value no number can be made of falls back to the default. A negative
  quiet zone still crops rather than throwing.
  `renderQrSvg` also coerces `matrix.width`, which closes the last route from a
  caller's string into an attribute, this one needing a forged matrix and so a
  caller who is already the attacker. The two raster renderers do not, because
  neither of them produces markup.
- **The offline app assigning renderer output to `innerHTML`.** It built the
  re-import code from a string, which contradicts the rule stated in `element()`
  at the top of the same file. It now builds the SVG with `createElementNS`, and
  the build test asserts the bundle contains none of the nine ways a string
  usually becomes markup, `innerHTML` and `DOMParser` among them. The code also
  gained an accessible name, which the string renderer has no way to emit.
- **Photographs held at an angle.** The bottom-right alignment pattern was
  chosen by distance from a prediction that is known to be wrong: the fit
  through three finder patterns is affine, so at version 26 its guess for the
  far corner is nearly six modules out, and inside a search window that wide
  there are dozens of isolated dark data modules closer to it than the pattern
  is. Candidates are now ranked by how much they look like a bullseye, measured
  along both axes and both diagonals, with distance from the prediction only
  breaking ties. The accepted candidate is also refitted once, through the
  four-point projective fit, which predicts the centre to inside a module.
  Measured: the tilt family of the corpus went from 13 of 66 to 61 of 66, yaw
  and pitch now read to 30 degrees on both axes at versions 11, 18 and 27, and
  the 26 cases jsQR could read and this could not are now zero.
- **Every still image over 1400 pixels decoding at half the resolution it asked
  for.** `fitWithin` reduced by whole halvings only, so it undershot its own cap
  by up to a factor of two and one extra pixel of input could halve the working
  image. It now lands on the cap: halvings while they still clear it, then one
  area-averaged pass for the remainder.
- **The camera path throwing away most of the sensor.** It asked for 1280 wide
  and then reduced the frame to a 720-pixel long edge, so a ten-account export
  arrived at 1.8 pixels per module, below Nyquist at every sensor size and
  unreadable however good the camera. It now asks for 1920 by 1080 as a soft
  constraint and works at up to `MAX_CAMERA_PIXELS`. Corpus camera path on
  ten-account exports: 18 of 143 to 115 of 143.
- **A per-frame budget that could not reach the rung it needed.** 35 ms and two
  attempts is the two polarities of one binariser, so a wrong polarity guess
  left nothing. Now 250 ms and five attempts.
- **A ladder ordered by guesswork rather than by what a camera can reach.** The
  camera takes the front of the ladder and nothing else, so a rung it cannot
  reach may as well not exist. Measured on 32 dim 1600 by 1200 scenes, the
  winning rung was the global threshold or a half-scale pass at one polarity or
  the other in 23 of them, and all of those sat at position 5 or later behind the
  upscale rung. Both polarities and both cheap scales are now the first four
  positions, and the upscale rung is last. It is the most expensive rung by a
  factor of five to twelve (52 to 64 ms against 5 for half scale and 10 for full
  scale on a 1080p frame) and it won none of the 32. Measured: the dim set went
  from 9 of 32 to 32 of 32 at the _unchanged_ budget of 140 ms and four attempts,
  and a blank frame, which is what the camera sees while somebody is still aiming,
  went from 74 ms to 27 ms. The camera column of the corpus went from 366 of 408
  to 371. Four cases trade the other way, all of them a symbol filling a sixth to
  a quarter of the frame: two of those need the upscale rung and two need a rung
  past the camera's five. All four are read by the still path, and a person with a
  camera in their hand fixes them by moving it closer.
- **A camera loop with no bound on how much of the thread it took.** Waiting one
  scan interval after a decode bounds idle time, which is not the thing that has
  to be bounded: at 67 ms of idle, a 140 ms decode holds the thread for 68% of
  the time and a phone three to five times slower holds it for 85 to 91%, which
  is a stuttering preview on exactly the devices this work is for. The gap after
  a decode is now at least as long as that decode took, so occupancy is capped
  near half however slow the device is. The guard before that one counted
  animation frames and decayed by a quarter budget per frame, which turned one
  300 ms decode into 750 ms of dead time.
- **A superseded camera start that could leave the camera unstoppable.** Two
  starts in the same second (a re-render, a double tap) both reach getUserMedia.
  The loser used to hand back a handle whose `stop` did nothing and to emit a
  `'stopped'` status, so a caller keeping one handle could overwrite the live one
  with the dead one, after which nothing could turn the camera off and the
  indicator stayed lit for the life of the page. The loser now returns a handle
  marked `superseded` and emits no status at all, so a `'live'` status is always a
  camera that is genuinely live.
- **A dim capture spending the whole ladder on the wrong polarity.**
  `looksInverted` compared brightness against a fixed threshold, so a
  photograph taken in poor light, where every level is scaled down together,
  read as a dark-mode screenshot. It now compares against the picture's own
  light and dark levels. There is also a new ladder rung offering a downscale
  _and_ the corrected polarity, which no rung did before.
- **Module size measured from one finder** rather than from both ends of both
  axes, which on a keystone view reads three per cent low and eats the tolerance
  the dimension search exists to provide.
- **A camera left running.** A track that ends underneath the scan (an unplugged
  webcam, another application seizing the device) now stops it, rather than
  leaving the loop decoding one frozen frame. A stream that arrives after a
  later `startCameraScan` has superseded it is stopped rather than leaked.
- **"No camera on this device" for a constraints failure.** An
  `OverconstrainedError` now triggers one relaxed retry before being reported.

### Changed

- **Breaking:** `renderQrSvg` accepts `#rgb`, `#rgba`, `#rrggbb` and
  `#rrggbbaa`, the keywords `none`, `transparent` and `currentColor`, and
  `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`,
  `oklch()` and `color()` whose contents are digits, letters, dots, commas,
  spaces, slashes, signs and percent signs. Anything else throws a `TypeError`.
  Named colours are not accepted, so `black` becomes `#000000`, and neither are
  `var()`, `color-mix()` and `url()`. `url()` is the reason the check has the
  shape it does: a paint server reference is a way out of a document whose whole
  claim is that nothing leaves it. A `TypeError` rather than a `RetrieverError`,
  because `RetrieverErrorCode` is for things that happen to data and this is a
  caller passing the wrong constant, which `attempt` should rethrow rather than
  turn into a failed `Result`. The message names the option and never the value,
  so a rejected string is not handed a second route into a page.
- A fractional `quietZone` is floored to whole modules in all three renderers,
  where the SVG one used to pass it through. A half-module border is legal SVG
  and was drawn correctly, but `renderQrPng` indexed the matrix by the result and
  returned a blank code, and `renderQrImageData` produced a canvas with
  fractional dimensions whenever `quietZone * scale` was not whole. Consistency
  in the direction of the renderer that cannot be wrong quietly.
- `dark` and `light` have always been ignored by `renderQrPng` and
  `renderQrImageData`, which write black and white unconditionally. That is now
  written down in `RenderOptions` rather than left to be discovered.
- **Breaking:** `DecodeFailureReason` gains `'geometry'` and loses `'no-extract'`
  and `'empty'`. `'geometry'` means the markers were found and no grid would fit
  over them, which takes the misplaced-grid case away from `'checksum'`, and
  `'checksum'` now means what it says: a grid that fitted and data underneath it
  that was past repairing. In every failure diagnosed while investigating this,
  the modules were perfectly readable and the grid was misplaced, and the message
  told people to retake a photograph that was already good enough.
  `'unsupported'` is now reachable too, for a symbol that read cleanly and then
  turned out to use a feature this decoder refuses. The two removed members were
  declared and produced nowhere: `'geometry'` says what `'no-extract'` was
  reaching for, and a symbol whose data begins with a terminator decodes to an
  empty string rather than failing. A consumer switching exhaustively over the
  union needs the new arm and loses two; a consumer with a label map keyed by
  reason must drop its `no-extract` and `empty` entries and add `geometry`.
- **Breaking:** `CameraScanHandle` gains `superseded`. Nothing that consumes a
  handle needs a change, but anything constructing one (a test double) does.
- `QrDecodeOptions.maxPixels` caps the working image by area, and is the default
  at `MAX_WORK_PIXELS` (2,500,000, which is 1826 by 1369 at 4:3). Every stage is
  linear in area and nothing is linear in long edge, so a long-edge cap prices a
  4032 by 3024 photograph and a 4032 by 1000 panorama the same when one is four
  times the work. Four megapixels was tried and dropped: of the 408 corpus cases,
  12 exceed 2.5 megapixels, none exceed 4, and all 12 score the same at both, so
  the larger cap was an extrapolation. On the case the corpus does not contain, a
  fifteen and a twenty account export photographed at 4032 by 3024, both caps read
  every framing down to 2.65 pixels per module. The larger cap also created a
  transient nothing else in the pipeline has: the upscale rung takes a working
  image to four times its area, which at 4 megapixels is about 50 MB live at once
  on a phone, and at 2.5 is 20 MB. `maxEdge` still works and is documented as
  discouraged.
- The default `timeBudgetMs` is 1500 rather than 400. The old number was sized
  for the 800-pixel working image the halving bug produced; all nine rungs over a
  2.5 megapixel frame with nothing in it measures 177 ms in Node on a 2024 laptop,
  so a mid-range phone finishes the ladder too.
- `imageDataFromBlob` caps by area at the same ceiling and reduces in steps of
  at most 2x with `imageSmoothingQuality: 'high'`. A single `drawImage` from 4032
  to 1600 samples 4 of every 25 source pixels whatever the quality hint says.
- `imageDataFromVideo` takes `maxPixels` in place of a long edge, reuses its
  canvases while the frame size holds, and asks for `willReadFrequently`. It
  reduces in the same steps of at most 2x the still path uses, which measurably
  changes nothing for any camera anyone has (the 2.1 megapixel ceiling asks 1.00x
  of 1080p, 1.33x of 1440p and 1.99x of 4K, all one step, all one canvas) and
  matters above 4K: on an 8K frame of a screen with a visible pixel grid, one draw
  left the symbol readable only at the third ladder rung where the stepped chain
  read it at the first.
- `CameraScanOptions.maxEdge` is replaced by `maxPixels`, and `maxAttempts` is
  now settable and defaults to five. `scansPerSecond` is documented as a ceiling
  rather than a target, because the loop also holds a gap as long as the last
  decode. The `'live'` status carries the track's real settings, so a
  caller can tell whether it got 1920 by 1080 or 640 by 480.
- The `binarised` telemetry frame is decimated above
  `BINARISED_TELEMETRY_PIXELS` (1,000,000). It is a picture for a person to look
  at, not data anything decodes from, and a consumer turns it into an ImageData
  at four bytes per pixel on the main thread. Its `width` and `height` describe
  the bitmap it carries, as they always did.
- New exports: `downscaleArea`, `upscaleSmooth`, `fitPixels`, `fitToWork`,
  `moduleSizeAcross`, `MAX_WORK_PIXELS`, `MAX_CAMERA_PIXELS`,
  `BINARISED_TELEMETRY_PIXELS`, `releaseVideoCanvas`. Nothing was removed:
  `upscaleNearest`, `fitWithin` and `moduleSizeBetween` are all still there.
- Still zero runtime dependencies.

## 0.1.0

First release.

- Reads a Google Authenticator "Export accounts" QR code from an image or a live
  camera and returns every account with its base32 secret, issuer, account name,
  algorithm, digit count, type and counter.
- Zero runtime dependencies. QR decoding, QR encoding, the protobuf reader,
  base32, base64 and the one-time password functions are all in the package;
  HMAC comes from WebCrypto.
- Merges the multi-code exports Google produces for large account lists, in any
  order, refusing to combine two different exports.
- Generates a fresh `otpauth://` QR code per account, as SVG, PNG or pixels, so
  a secret can be scanned straight into another authenticator.
- Computes live TOTP and HOTP codes.
- Ships `dist/google-auth-secret-retriever.html`: the whole tool as one file,
  with a content security policy that forbids connections, openable from
  `file://` with the network off.
- Emits a decode telemetry stream, so a consumer can show what the decoder saw.
