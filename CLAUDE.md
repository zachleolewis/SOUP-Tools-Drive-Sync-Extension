# SOUP-Tools-Drive-Sync-Extension - notes for maintainers and agents

Drive Sync, the Official SOUP Tools extension (id `drive-sync`) that backs up a profile's Library (replays, match files) and
settings to the user's own Google Drive and restores them. Backup only: team sync was dropped because Google's `drive.file`
scope does not let one account's app see files another account's app wrote (`spike/README.md`).

- Developer guide (layout, design, fake Google, releasing, rules): [`docs/DEVELOPING.md`](docs/DEVELOPING.md). Read it first.
- User guide and privacy summary: [`README.md`](README.md); the full privacy policy is https://zachleolewis.github.io/soup-tools/privacy.html.

## Commands

```
npm ci
npm run check     typecheck + build + tests + release-asset checks (what CI runs)
npm test          node:test on the TypeScript sources, against an in-process fake Google
```

SOUP's own end-to-end test of this extension (a real SOUP, trusted clicks, a local fake Google) lives in the private SOUP
source repository: `pnpm selftest:drive-sync`, which expects this repository next to it.

## Rules that must not break

- **Scopes are `drive.file`, `openid`, `email` and nothing else.** Any restricted or sensitive Google scope needs a paid
  security assessment and changes the privacy promise. `scripts/verify-dist.mjs` fails the build if another scope appears.
- **The Google OAuth client id and secret are never committed.** GitHub push protection blocks them. They come from the
  environment (`DRIVE_SYNC_CLIENT_ID`, `DRIVE_SYNC_CLIENT_SECRET`; repository secrets in `release.yml`) or a git-ignored
  `google-oauth-client.json`. Without them the build uses placeholders, tests pass, sign-in does not work, and
  `verify-dist.mjs --release` refuses the build.
- Never log, store or show a token; the refresh token lives only in `app.secrets` (Windows Credential Manager).
- Data goes only between the PC and Google. If that changes, update the privacy page (repository `zachleolewis/soup-tools`)
  in the same change.
- Drive Sync never changes SOUP's own settings (the Library, download or import folders); SOUP's self-test asserts it.
- `types/soup.d.ts` is a copy from `zachleolewis/SOUP-Tools-Extensions`; refresh it, do not edit it.
- Release: bump `package.json` and `manifest.json` together, tag `vX.Y.Z` equal to the manifest version. It is listed as
  Official in `zachleolewis/SOUP-Tools-Community-Extensions`; SOUP installs the latest release, so no list change is needed.
- `manifest.json` `minAppVersion` is the oldest SOUP that has every API it uses (2.3.0 today).
