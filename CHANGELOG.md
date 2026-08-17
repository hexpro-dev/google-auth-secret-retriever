# Changelog

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
