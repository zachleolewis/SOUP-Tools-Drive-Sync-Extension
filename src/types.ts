import type { LibraryFolder, LibraryReplay } from "soup";

/** What `app.library.list()` returns (SOUP's LibrarySnapshot). */
export interface LibrarySnapshot {
  root: string;
  folders: LibraryFolder[];
  replays: LibraryReplay[];
}

export type FileKind = "vrf" | "json";

export interface BackupFile {
  size: number;
  md5: string;
  /** Drive file id of `library/<replay id>.<kind>`. */
  driveId: string;
}

export interface BackupReplay {
  id: string;
  name: string;
  matchId: string | null;
  /** The Library folder id (as it was on the PC that made the backup) or null for the root. */
  folderId: string | null;
  pinned: boolean;
  mode: string | null;
  map: string | null;
  score: string | null;
  startedAt: number | null;
  files: Partial<Record<FileKind, BackupFile>>;
}

export interface BackupFolder {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  pinned: boolean;
}

/** A replay that left the Library; its files stay in the backup until `removedAt` + 30 days. */
export interface Tombstone {
  removedAt: number;
  replay: BackupReplay;
}

/** `backup.json`, written last. */
export interface BackupManifest {
  format: 1;
  createdAt: number;
  extensionVersion: string;
  apiVersion: string;
  pcName: string;
  profile: { id: string; name: string };
  folders: BackupFolder[];
  replays: BackupReplay[];
  tombstones: Tombstone[];
  /** Drive id of settings.soupprofile when it was uploaded. */
  settingsDriveId: string | null;
  /** settings.soupprofile was switched off in "What to back up": the file stays in Drive until `removedAt` + 30 days. */
  settingsTombstone?: { removedAt: number; driveId: string } | null;
}

/** A local file the backup considers. */
export interface LocalFile {
  replayId: string;
  kind: FileKind;
  path: string;
  size: number;
  md5: string;
}

/** What Drive says about a file in the library folder. */
export interface RemoteFile {
  id: string;
  name: string;
  size: number;
  md5: string | null;
}

export const fileNameOf = (replayId: string, kind: FileKind): string => `${replayId}.${kind}`;
