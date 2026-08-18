# Releasing

## Before tagging

```
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build:all
```

Then the checks a machine cannot do. Open
`dist/google-auth-secret-retriever.html` directly from disk, with the network
off, in Chrome, Firefox and Safari, and in each one:

- Drop a screenshot of an export code on the page and confirm the accounts
  appear.
- Paste a screenshot with the keyboard and confirm the same.
- Reveal a secret, copy it, and open the re-import QR code.
- Compare one generated code against the phone. If they disagree the extraction
  is wrong and nothing else matters.
- Open the network panel and confirm it stays empty throughout.

Use a throwaway account for this, not your own.

The camera cannot be tested from `file://` on every browser, which is expected
and documented. Test it by serving the file over http instead:
`python3 -m http.server` in `dist/`.

## Tagging

1. Update the version in `package.json`.
2. Add a section to `CHANGELOG.md`.
3. Commit, then tag from `main`. Both `v0.1.0` and
   `@hexpro/google-auth-secret-retriever@0.1.0` are accepted.
4. Push the tag. The publish workflow verifies the tag matches `package.json`,
   runs the whole gate again, publishes to npm with provenance, and attaches the
   single-file app and its SHA-256 to a GitHub release so a downloader can check
   what they got.

Requires no secret. The workflow authenticates to npm with OIDC, against the
trusted publisher configured on the package at npmjs.com, which names this
repository and the workflow filename. If publishing ever fails with an
authentication error, check that configuration first: renaming
`.github/workflows/publish-npm.yml` or moving the repository invalidates it.

The publish step is the one place here that runs `npm` rather than `pnpm`. pnpm
gained OIDC publishing in its 11 line and this repository is pinned to pnpm 10,
so `pnpm publish` would look for a token, find none, and fail.

## Never in a release

No real Google Authenticator export, and no real secret, in the repository, in a
release artefact, or in a release note. See the top of `CLAUDE.md`.
