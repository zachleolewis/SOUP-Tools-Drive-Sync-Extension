# Phase 0 spike (kept as documentation, not shipped)

`spike.mjs` answered one question before Drive Sync was built: **can several people's SOUP share one Google Drive folder under the
`drive.file` scope?** It was run on 2026-11-02 with two Google accounts (A and B), the folder shared with B as writer.

**Result: no.** Under `drive.file` each person's app sees only the files **its own sign-in created** (or that the person picked):

- Before B picks anything, B gets 404 on the shared folder and on A's file (B can still create a file inside the folder by its id).
- After B picks the folder in Google's desktop Picker (`trigger_onepick`, `allow_folder_selection`), B can read and list the folder, but
  the listing shows **only B's own files**. A's file stays 404 and a file A adds later is invisible too.
- A likewise never sees B's files.

So picking a folder grants the folder, not its contents, and sharing does not reach the other person's app. Team sync is therefore not
possible with `drive.file` (the alternatives are Google Drive for Desktop, the restricted `drive` scope with yearly verification and a
paid security assessment, or leaving teams out). **Decision (2026-11-02): backup and restore only; team sync is out.** Backup and
restore of one's own files are unaffected: the account that wrote a file can read it from any PC.

Tokens and state from the run (`.tokens-*.json`, `.state.json`) are git-ignored and must never be committed.
