# Drive Sync for SOUP

Back up your SOUP Library and settings to **your own Google Drive**, and restore them on this or any other PC.

Drive Sync is an official SOUP extension (id `drive-sync`). It needs SOUP 2.3.0 or newer.

## What it does

- **Back up now**, or automatically: a couple of minutes after your Library changes, and every few hours (you choose; the default is 24, and 0 turns the timed backup off). It never runs while a match is in progress, never when you are signed out, and a failed run tries again later. The first backup is always one you start yourself.
- Backs up the **active profile's Library** (every replay `.vrf` and its match `.json`, your folders, replay names) and a **settings export** of that profile (the same `.soupprofile` as Settings > Profiles > Export, without this PC's paths). You choose what goes in, see below.
- **What to back up** (in the settings page): switches for **Replay files (.vrf)**, **Match files (.json)** and **SOUP settings (.soupprofile)**, and a list of your Library folders to **leave out** (a folder you turn off takes the folders inside it with it; new folders are included). The choice is saved per SOUP profile. Something you leave out later is **not deleted from Drive at once**: it is kept for 30 days, like a replay you deleted, and then removed. Turn it back on within that time and the same files are used again.
- Uploads only what is new or changed, so the second backup takes seconds. Large replays upload in resumable pieces, so an interrupted upload continues instead of starting over.
- A replay you delete from SOUP stays in the backup for **30 days** (like a trash) before it is removed from Drive.
- **Restore** lists the backups in your Google Drive (profile, PC, time, what the backup holds: replays, replay files, match files, folders, settings, size), tells you what would happen and only offers what is in the backup, and then adds the replays to your **active** profile's Library. Folders are recreated, names come back, and replays you already have (same match or same file) are skipped. Nothing you have is changed or deleted. Optionally the settings come back as a **new profile**; nothing is overwritten and you switch to it when you like.
- A small **Drive** chip in the header shows the state: "Backed up 5 min ago", "Backing up 42% · 3 of 12" (the percentage counts bytes over the whole upload and moves during a single large replay), "Signed out" or "Error". Problems also show as a notice with the reason ("Your Google Drive is full", "Sign in again", ...).

## Setting it up

1. Settings > Extensions > Drive Sync (the cog) > **Sign in with Google**. Your browser opens on Google's own page. SOUP and this extension never see your Google password.
2. Press **Back up now**.

To restore on another PC: install SOUP and Drive Sync there, sign in with the same Google account, open **Restore...** and choose a backup.

## What Google sees, and what we see

- Drive Sync asks for exactly three permissions: `drive.file`, `openid` and `email`.
  - `drive.file` is Google's narrowest Drive permission: the extension can see **only the files and folders it created itself**, in a folder called `SOUP Sync`. It cannot see, list or read anything else in your Drive.
  - `openid` and `email` are only used to show which account is signed in.
- Your data goes **between this PC and Google, nowhere else**. There is no SOUP server in between.
- The sign-in token is kept in **Windows Credential Manager** (under `SOUP/ext/drive-sync`), never in a file, never in your profile or in a profile export, and never in the log.
- **Sign out** revokes the token at Google and deletes it from this PC. Your backups stay in your Drive; delete the `SOUP Sync` folder in Google Drive if you want them gone. You can also review or remove access at <https://myaccount.google.com/permissions>.

See the [SOUP Tools privacy page](https://zachleolewis.github.io/soup-tools/privacy.html).

## What is in your Drive

```
SOUP Sync/
  Backups/
    <profile name> (<first 8 characters of the profile id>)/
      library/            <replay id>.vrf and <replay id>.json, one flat folder
      settings.soupprofile
      backup.json         what is in the backup (written last)
```

`backup.json` lists the time, the extension version, the PC name you chose, your Library folders and for every replay its name, folder and the size and MD5 checksum of its files. Checksums let Drive Sync tell what changed and check every download.

## Limits

- **Only files SOUP created are visible to it** (the `drive.file` permission). Files you add to the `SOUP Sync` folder yourself are not seen. Please do not move or rename the `SOUP Sync` folders in Drive: Drive Sync would make new ones and upload everything again.
- **No team sync yet.** Google's `drive.file` permission does not let one person's SOUP see files another person's SOUP wrote, even in a shared folder (tested; see `spike/README.md`). A backup can be restored by the same Google account only.
- One backup or restore runs at a time, for the active profile. To back up another profile, switch to it.
- Memory: SOUP's file API has no partial reads, so a replay is read whole once to compute its checksum (replays are roughly 10 to 60 MB) and the result is remembered, so unchanged files are not read again. Uploads and downloads themselves are streamed by SOUP.
- Restoring does not bring back which replays were pinned.
- A very large first backup (many GB) takes a while and counts against your Google Drive space (15 GB free per Google account).

## Troubleshooting

| Message | What it means |
| --- | --- |
| Sign in again | Google no longer accepts the saved sign-in (you revoked access, or changed your password). Press **Sign in again**. |
| Your Google Drive is full | Free some space in Google Drive or buy storage; the next backup continues where it stopped. |
| Can't reach Google | You are offline. Scheduled backups just try again later. |
| Google is busy right now | Google asked for a pause (rate limit or a server problem); it retries with growing pauses and then tries again at the next scheduled time. |

## Building and contributing

See [docs/DEVELOPING.md](docs/DEVELOPING.md). MIT licensed.
