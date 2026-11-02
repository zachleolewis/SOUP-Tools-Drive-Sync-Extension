// The pure part of a restore: which folders to recreate, which replays to skip because the Library already has them,
// and how to find the replays SOUP made from the files we imported (importFiles does not return their ids).
import type { LibraryFolder, LibraryReplay } from "soup";
import type { BackupFolder, BackupManifest, BackupReplay, FileKind } from "./types.ts";

export interface LocalFileInfo {
  replayId: string;
  kind: FileKind;
  path: string;
  size: number;
}

export interface FolderStep {
  /** The folder's id in the backup. */
  backupId: string;
  name: string;
  /** The backup id of the parent (null: the Library root). */
  parentBackupId: string | null;
  /** The existing local folder with this name under the same (mapped) parent, if any. Otherwise it is created. */
  existingLocalId: string | null;
}

export interface RestoreItem {
  replay: BackupReplay;
  /** Drive file ids to download, by kind. */
  files: Array<{ kind: FileKind; driveId: string; size: number; md5: string }>;
}

export interface RestorePlan {
  /** Parents come before their children. */
  folders: FolderStep[];
  toRestore: RestoreItem[];
  skipped: Array<{ replay: BackupReplay; why: "same match" | "same file" }>;
  /** A backup replay without any downloadable file (metadata only). */
  withoutFiles: BackupReplay[];
  bytes: number;
}

/** Folders in an order where every parent precedes its children (cycles and orphans are attached to the root). */
export function orderFolders(folders: BackupFolder[]): BackupFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: BackupFolder[] = [];
  const seen = new Set<string>();
  const visit = (f: BackupFolder, stack: Set<string>): void => {
    if (seen.has(f.id)) return;
    if (stack.has(f.id)) return; // a cycle: stop
    stack.add(f.id);
    const parent = f.parentId ? byId.get(f.parentId) : undefined;
    if (parent) visit(parent, stack);
    seen.add(f.id);
    out.push(f);
  };
  for (const f of folders) visit(f, new Set());
  return out;
}

/** Local replays whose files could be the same as a backup replay's, by size: only these need hashing. */
export function hashCandidates(backup: BackupManifest, local: LocalFileInfo[]): LocalFileInfo[] {
  const wanted = new Set<string>();
  for (const r of backup.replays) for (const [kind, f] of Object.entries(r.files)) if (f) wanted.add(`${kind}:${f.size}`);
  return local.filter((l) => wanted.has(`${l.kind}:${l.size}`));
}

export interface RestoreInput {
  backup: BackupManifest;
  localFolders: LibraryFolder[];
  localReplays: LibraryReplay[];
  /** md5 of local files (only the ones `hashCandidates` named need to be there). */
  localMd5: Set<string>;
}

export function planRestore(input: RestoreInput): RestorePlan {
  const { backup, localFolders, localReplays, localMd5 } = input;

  // Folders: match by name under the same parent (a parent that is being created has no local children yet).
  const mapped = new Map<string, string | null>(); // backup id -> local id (null: will be created)
  const steps: FolderStep[] = [];
  for (const f of orderFolders(backup.folders)) {
    const parentLocal = f.parentId && backup.folders.some((x) => x.id === f.parentId) ? mapped.get(f.parentId) ?? null : null;
    const parentIsNew = !!f.parentId && backup.folders.some((x) => x.id === f.parentId) && parentLocal === null;
    const existing = parentIsNew ? undefined : localFolders.find((l) => l.name === f.name && (l.parentId ?? null) === (parentLocal ?? null));
    mapped.set(f.id, existing?.id ?? null);
    steps.push({ backupId: f.id, name: f.name, parentBackupId: f.parentId && backup.folders.some((x) => x.id === f.parentId) ? f.parentId : null, existingLocalId: existing?.id ?? null });
  }

  const matchIds = new Set(localReplays.map((r) => r.matchId).filter((m): m is string => !!m));
  const toRestore: RestoreItem[] = [];
  const skipped: RestorePlan["skipped"] = [];
  const withoutFiles: BackupReplay[] = [];
  let bytes = 0;
  const seenMatches = new Set<string>();
  for (const r of backup.replays) {
    const files = (Object.entries(r.files) as Array<[FileKind, NonNullable<BackupReplay["files"][FileKind]>]>).map(([kind, f]) => ({ kind, driveId: f.driveId, size: f.size, md5: f.md5 }));
    if (files.length === 0) {
      withoutFiles.push(r);
      continue;
    }
    if (r.matchId && matchIds.has(r.matchId)) {
      skipped.push({ replay: r, why: "same match" });
      continue;
    }
    const vrf = r.files.vrf ?? r.files.json;
    if (vrf && localMd5.has(vrf.md5)) {
      skipped.push({ replay: r, why: "same file" });
      continue;
    }
    // The backup itself may hold two replays of one match; restore the first only.
    if (r.matchId) {
      if (seenMatches.has(r.matchId)) {
        skipped.push({ replay: r, why: "same match" });
        continue;
      }
      seenMatches.add(r.matchId);
    }
    toRestore.push({ replay: r, files });
    bytes += files.reduce((s, f) => s + f.size, 0);
  }
  return { folders: steps, toRestore, skipped, withoutFiles, bytes };
}

/**
 * Which of the replays that appeared after an import is which backup replay: by match id, then by size in the same folder
 * (each new replay is used once). Returns backup replay id -> new local replay id.
 */
export function pairImported(batch: RestoreItem[], folderId: string | null, before: LibraryReplay[], after: LibraryReplay[]): Map<string, string> {
  const had = new Set(before.map((r) => r.id));
  const fresh = after.filter((r) => !had.has(r.id));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const item of batch) {
    const hit = item.replay.matchId ? fresh.find((r) => !used.has(r.id) && r.matchId === item.replay.matchId) : undefined;
    if (hit) {
      used.add(hit.id);
      out.set(item.replay.id, hit.id);
    }
  }
  for (const item of batch) {
    if (out.has(item.replay.id)) continue;
    const vrfSize = item.files.find((f) => f.kind === "vrf")?.size;
    const total = item.files.reduce((s, f) => s + f.size, 0);
    const hit = fresh.find((r) => !used.has(r.id) && (r.folderId ?? null) === folderId && (r.sizeBytes === vrfSize || r.sizeBytes === total));
    if (hit) {
      used.add(hit.id);
      out.set(item.replay.id, hit.id);
    }
  }
  return out;
}
