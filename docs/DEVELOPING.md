# Developing Drive Sync

## Layout

```
manifest.json            id drive-sync, minAppVersion 2.3.0, uses: accounts, network, filesystem
src/
  main.ts                the Plugin: settings page, header chip, commands
  controller.ts          ties the engines to SOUP: one run at a time, saveData, status, scheduler
  ui.ts                  settings tab (Setting rows + kit.Progress), restore dialog, header chip
  auth.ts                oauthPkce / refresh / revoke; refresh token in app.secrets (google.refresh)
  drive.ts               Drive v3 client: list by name+parent, folders, multipart + resumable upload, download, delete,
                         401 -> refresh once, 429/5xx -> backoff (max 5 tries), quota / offline errors
  transport.ts           the only door to the network (app.requestUrl / app.net.upload / app.net.download); injectable
  chunks.ts              resumable-upload arithmetic (8 MiB chunks, Content-Range, Range -> next offset)
  md5.ts                 incremental pure-JS MD5
  hashing.ts             hash a file once; cache by (path, size, mtime)
  plan.ts                PURE backup plan: upload / keep / tombstones (30 days) / next backup.json
  backup.ts              the backup engine (Library -> Drive), progress, cancel
  restore-plan.ts        PURE restore plan: folders, duplicates, pairing imported replays with backup entries
  restore.ts             list backups, restore (download -> checksum -> importFiles -> renameReplay), settings as a new profile
  layout.ts              SOUP Sync / Backups / <profile> / library, remembered folder ids
  scheduler.ts           2-minute debounce after Library changes, every N hours, not while live / signed out
  endpoints.ts           Google's addresses + the loopback-only test override
  constants.ts           client id/secret (public by design), scopes, limits
  status.ts, state.ts, env.ts, errors.ts, types.ts
tests/                   node:test, run on TypeScript directly (no build)
  support/fake-google.ts an in-process Google: OAuth + Drive v3 (list q, get, create, update, delete, multipart, resumable with 308)
  support/fakes.ts       Transport over fetch, an fs on a temp folder, an in-memory Library
scripts/
  fake-google.ts         the same fake as a standalone server (for a SOUP self-test)
  verify-dist.mjs        release-asset checks after the build
spike/                   the Phase 0 result (documentation only)
```

## Commands

```
npm ci
npm run check        typecheck + build + tests + release-asset checks (what CI runs)
npm run typecheck
npm run build        dist/main.js, dist/manifest.json, dist/styles.css
npm test             node --experimental-strip-types --test "tests/*.test.ts"
```

Tests run TypeScript with Node's built-in type stripping, so source files may not use parameter properties (`constructor(private x)`), enums or namespaces.
`soup` and `react` are never bundled: `soup-externals.mjs` reads them from what SOUP provides (same as the SOUP extension template). Types for the `soup`
module are in `types/soup.d.ts` (copied from the SOUP-Tools-Extensions repository; refresh it when SOUP's API changes).

Try it in SOUP: `npm run build`, then Settings > Extensions > Install > From a folder > `dist/`.

## Design in short

- **Backup** (`runBackup`): `app.library.list()` -> hash every file (cached) -> resolve the Drive folders -> list `library/` and download the last
  `backup.json` -> `planBackup` -> upload one file at a time (multipart up to 5 MB, resumable in 8 MiB chunks above) -> export `settings.soupprofile` ->
  write `backup.json` **last** -> delete only what the new `backup.json` no longer mentions (expired tombstones). The plan trusts Drive's listing
  (`md5Checksum`) over `backup.json`, so a run that died before writing `backup.json` is adopted on the next run, never duplicated. A file that fails
  on its own is left out of `backup.json` and retried next time; auth, quota and network errors end the run.
- **Restore** (`runRestore`): folders matched by name under the same parent or created; replays skipped when the Library has the same match id or a file with the
  same MD5 (only local files of the same size are hashed); downloads go to `tempDir`, are verified against the backup's MD5, imported per folder with
  `importFiles`; because `importFiles` returns no ids the new replays are found by diffing `library.list()` (match id, then size) and renamed. Settings only
  through `profiles.importFrom` as a new profile.
- **No tokens in logs, saveData or files**: the refresh token is in `app.secrets` only, the access token in memory. Errors carry status and reason, never headers.
- **Scopes** are fixed in `constants.ts` (`drive.file`, `openid`, `email`); `scripts/verify-dist.mjs` fails the build if any other Google scope appears in `main.js`.

### Memory

`app.fs` has no ranged read, so MD5 of a file needs the whole file in memory once (a replay is roughly 10 to 60 MB; one file at a time, hashed in 4 MB slices
and dropped). Results are cached in `md5-cache.json` (by path, size, modified time) so unchanged files are never read again. Uploads (`app.net.upload` with
`offset`/`length`) and downloads (`app.net.download`) are streamed by SOUP. Files up to 5 MB are read whole for the multipart upload.

## Testing against a fake Google

Unit tests start `FakeGoogle` (real HTTP on 127.0.0.1) and drive the real Drive client and engines: folder create/find, multipart and resumable uploads
(including a 308 resume after a lost acknowledgement and after a chunk that never arrived), downloads, 401 -> refresh, 429 backoff, `Retry-After`, 5xx limit, quota
errors, plus backup (first, no-op, changed, tombstones, crash recovery, cancel), restore (folders, duplicates, checksum mismatch, settings) and the scheduler
with a fake clock. `tests/smoke.test.ts` loads the **built** `dist/main.js` into a stub SOUP runtime and runs sign-in, backup, token expiry and sign-out through
the real controller.

### Pointing a real SOUP at a local fake Google (self-test)

The extension honours one test hook: a file `drive-sync-test-endpoints.json` in the extension's machine folder
(`app.paths.machineDir`, i.e. `<SOUP data dir>\extensions-data\drive-sync\`) replacing Google's five addresses. It is accepted **only when every address is
on 127.0.0.1, localhost or [::1]**; otherwise it is ignored with a warning, so the file can never send tokens or backups to another host. The sign-in
address is `http://127.0.0.1:...`, which SOUP itself only accepts in a debug build started with `SOUP_EXT_AUTH_ALLOW_LOOPBACK=1`; Drive and upload calls to
loopback are not special in SOUP. A release SOUP therefore always talks to Google.

```
node --experimental-strip-types scripts/fake-google.ts --port 18080 --write "<machineDir>\drive-sync-test-endpoints.json"
```

It prints the endpoints and serves `/__control/throttle?bps=N` (accept uploads and send downloads at N bytes per second, 0 for unlimited, so a self-test can watch a large transfer), `/__control/expire-tokens`, `/__control/quota?full=1|0`, `/__control/state` (files with md5, revoke and token-request
counts, the authorize requests, the request log) and `/__control/content?name=backup.json` (a file's bytes).

SOUP's `pnpm selftest:drive-sync` (in the SoupScrimTracker repository, `app/scripts/selftest/drive-sync*.mjs`) does exactly this: builds this repository, starts
the fake with `--write` into `<SOUP_DATA>\extensions-data\drive-sync\` (which is what `app.paths.machineDir` returns), installs `dist\` into a debug SOUP
on a throwaway profile and drives the settings page and the restore dialog with trusted clicks (sign-in, backup, no-op rerun, expired tokens, full Drive,
tombstone, restore with settings as a new profile, sign-out). It expects this repository next to SoupScrimTracker (or `SOUP_DRIVE_SYNC_DIR`).

### What to back up, progress

- `state.ts` `options` (`vrf`, `json`, `settings`, `excludedFolders`) is saved per profile with saveData. `plan.ts` `inScope()` decides what a backup covers (replays outside the excluded folders and their descendants, kinds that are switched on); `planBackup` turns everything that left that scope (a deleted replay, a folder now left out, a kind switched off) into a tombstone **per kind of file**, kept 30 days and then deleted; a file that is wanted again is adopted from Drive by md5 (no upload) and leaves the tombstones. `settings.soupprofile` switched off is kept in `backup.json` as `settingsTombstone`. Tests: the "What to back up" block of `tests/plan.test.ts`.
- Progress is byte-based: `BackupProgress` carries `bytesDone/bytesTotal` and the file's name; `app.net.upload`'s `onProgress` runs inside each resumable chunk, so a single large file moves the bar. `status.ts` `DriveState` (`backingUp`, `restoring`) holds the percentage, bytes and the file; the header chip reads "Backing up 42% · 2 of 5" and the settings page shows the same in its Progress row (also after closing and reopening the page mid-run). Restore downloads report the same way.

## Releasing

1. Bump `version` in `package.json` **and** `manifest.json` (they must agree; `verify-dist` checks).
2. `npm run check`, commit, push `main`.
3. Tag `vX.Y.Z` (the tag must equal the manifest version) and push the tag. `.github/workflows/release.yml` runs the checks and creates a GitHub release with
   `manifest.json`, `main.js` and `styles.css` attached. That is what SOUP's GitHub installer downloads (`package.rs`: the latest release's assets;
   `manifest.json` + `main.js` (+ `styles.css`); tag == manifest version, a leading `v` allowed).
4. The extension is listed in the community directory (`zachleolewis/SOUP-Tools-Community-Extensions`) as Official.

## Rules to keep

- Never add a Google scope beyond `drive.file`, `openid`, `email`.
- Never log, store or display a token. Do not put one in an error message.
- Data goes only between the PC and Google. The privacy page (zachleolewis.github.io/soup-tools/privacy.html) must stay true.
- Do not commit `spike/.tokens-*.json` or `spike/.state.json`.

## The Google client (kept out of git)

`src/constants.ts` reads the OAuth client id and secret from the build (`vite.config.ts` defines them): the environment
variables `DRIVE_SYNC_CLIENT_ID` / `DRIVE_SYNC_CLIENT_SECRET` (the release workflow takes them from repository secrets of the
same names), else a git-ignored `google-oauth-client.json` (`{ "client_id", "client_secret" }`) next to `package.json`. Without
either the build uses placeholders: tests and CI pass, sign-in does not work, and `node scripts/verify-dist.mjs --release`
refuses it. A Desktop client's secret is public by design and the released `main.js` contains it; it is kept out of git only
because GitHub push protection reports Google client secrets to Google, which may disable the client.
