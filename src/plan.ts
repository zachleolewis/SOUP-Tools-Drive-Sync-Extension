// The pure part of a backup: what to upload, keep and forget, and the next backup.json. No I/O, so it is tested directly.
import { BACKUP_FORMAT, TOMBSTONE_DAYS } from "./constants.ts";
import { fileNameOf } from "./types.ts";
import type { BackupFile, BackupFolder, BackupManifest, BackupReplay, FileKind, LocalFile, RemoteFile, Tombstone } from "./types.ts";
import type { LibraryReplay, LibraryFolder } from "soup";
import { type BackupOptions, DEFAULT_OPTIONS } from "./state.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The ids of the excluded folders and of every folder below them. */
export function excludedFolderSet(folders: ReadonlyArray<{ id: string; parentId: string | null }>, excluded: readonly string[]): Set<string> {
  const out = new Set(excluded);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (!out.has(f.id) && f.parentId && out.has(f.parentId)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** The replays a backup with these options covers (not in an excluded folder), and which kinds of file it takes. */
export function inScope(replays: LibraryReplay[], folders: LibraryFolder[], o: BackupOptions): { replays: LibraryReplay[]; kinds: Record<FileKind, boolean>; excluded: Set<string> } {
  const excluded = excludedFolderSet(folders, o.excludedFolders);
  return { replays: replays.filter((r) => !r.folderId || !excluded.has(r.folderId)), kinds: { vrf: o.vrf, json: o.json }, excluded };
}

export interface UploadJob {
  replayId: string;
  kind: FileKind;
  /** Drive name `<replay id>.<kind>`. */
  name: string;
  path: string;
  size: number;
  md5: string;
  /** Update this Drive file instead of creating one. */
  driveId?: string;
  reason: "new" | "changed" | "missing-remotely";
}

export interface BackupPlan {
  uploads: UploadJob[];
  /** Files that are already in Drive and identical. */
  keep: Array<{ replayId: string; kind: FileKind; driveId: string }>;
  /** Drive file ids to delete: expired tombstones and files whose local file is gone. */
  deleteDriveIds: string[];
  /** backup.json as it will be once every upload succeeded (driveIds of new uploads are filled in by the engine). */
  manifest: BackupManifest;
  /** The new manifest's entry for each upload job, so the engine can fill in ids or fall back after a failure. */
  slots: Map<UploadJob, { replay: BackupReplay; fallback: BackupFile | null }>;
  stats: { newFiles: number; changedFiles: number; keptFiles: number; newTombstones: number; expiredTombstones: number; bytesToUpload: number };
}

export interface PlanInput {
  replays: LibraryReplay[];
  folders: LibraryFolder[];
  /** Existing files with their size and md5, one per local file the library has (hashing is the engine's job). */
  local: LocalFile[];
  previous: BackupManifest | null;
  /** What Drive's library/ folder holds right now, by name. null when it was not listed (then only `previous` is trusted). */
  remote: Map<string, RemoteFile> | null;
  now: number;
  profile: { id: string; name: string };
  pcName: string;
  extensionVersion: string;
  apiVersion: string;
  tombstoneDays?: number;
  /** What to back up (default: everything). */
  options?: BackupOptions;
}

export function replayEntry(r: LibraryReplay): BackupReplay {
  return { id: r.id, name: r.name, matchId: r.matchId, folderId: r.folderId, pinned: r.pinned, mode: r.mode, map: r.map, score: r.score, startedAt: r.startedAt, files: {} };
}

export const folderEntry = (f: LibraryFolder): BackupFolder => ({ id: f.id, name: f.name, parentId: f.parentId, color: f.color, pinned: f.pinned });

export function planBackup(input: PlanInput): BackupPlan {
  const ttl = (input.tombstoneDays ?? TOMBSTONE_DAYS) * DAY_MS;
  const prev = input.previous;
  const prevById = new Map((prev?.replays ?? []).map((r) => [r.id, r]));
  const prevTomb = new Map((prev?.tombstones ?? []).map((t) => [t.replay.id, t]));
  const opt = input.options ?? DEFAULT_OPTIONS;
  const scope = inScope(input.replays, input.folders, opt);
  const scoped = new Map(scope.replays.map((r) => [r.id, r]));
  /** Is this file still part of the backup? (The replay exists, is outside the excluded folders, and its kind is switched on.) */
  const wants = (id: string, kind: FileKind): boolean => scoped.has(id) && scope.kinds[kind];
  const localBy = new Map<string, LocalFile>(input.local.map((l) => [fileNameOf(l.replayId, l.kind), l]));

  const uploads: UploadJob[] = [];
  const keep: BackupPlan["keep"] = [];
  const deleteDriveIds: string[] = [];
  const slots: BackupPlan["slots"] = new Map();
  const replays: BackupReplay[] = [];
  let newFiles = 0;
  let changedFiles = 0;

  for (const r of scope.replays) {
    const entry = replayEntry(r);
    // A replay that came back keeps what the backup (or its tombstone) knew about its files.
    const knownFiles = { ...prevTomb.get(r.id)?.replay.files, ...prevById.get(r.id)?.files };
    for (const kind of ["vrf", "json"] as const) {
      if (!scope.kinds[kind]) continue;
      const lf = localBy.get(fileNameOf(r.id, kind));
      const was = knownFiles[kind] ?? null;
      if (!lf) {
        // No local file: a file the backup had is dropped from it (and from Drive).
        if (was) deleteDriveIds.push(was.driveId);
        continue;
      }
      const name = fileNameOf(r.id, kind);
      const remote = input.remote?.get(name) ?? null;
      const remoteMatches = remote !== null && remote.md5 === lf.md5;
      const prevMatches = was !== null && was.md5 === lf.md5 && was.size === lf.size;

      if (input.remote) {
        if (remoteMatches) {
          // Drive has exactly this content (also adopts a file a crashed run uploaded before backup.json was written).
          entry.files[kind] = { size: lf.size, md5: lf.md5, driveId: remote!.id };
          keep.push({ replayId: r.id, kind, driveId: remote!.id });
          continue;
        }
      } else if (prevMatches) {
        entry.files[kind] = { ...was! };
        keep.push({ replayId: r.id, kind, driveId: was!.driveId });
        continue;
      }
      const driveId = remote?.id ?? (input.remote ? undefined : was?.driveId);
      const job: UploadJob = { replayId: r.id, kind, name, path: lf.path, size: lf.size, md5: lf.md5, driveId, reason: remote ? "changed" : was ? (prevMatches ? "missing-remotely" : "changed") : "new" };
      uploads.push(job);
      if (job.reason === "new" || job.reason === "missing-remotely") newFiles++;
      else changedFiles++;
      // The slot is filled with the planned file; the engine puts the real Drive id in, or restores `fallback` when the upload fails.
      const planned: BackupFile = { size: lf.size, md5: lf.md5, driveId: driveId ?? "" };
      entry.files[kind] = planned;
      slots.set(job, { replay: entry, fallback: was && !prevMatches ? { ...was } : null });
    }
    replays.push(entry);
  }

  // What left the backup's scope (a replay removed from the Library, or in a folder now left out, or a kind of file switched off) becomes a
  // tombstone and stays in Drive for the retention period; old tombstones expire. A file that is wanted again is simply adopted again.
  const tombstones: Tombstone[] = [];
  let newTombstones = 0;
  let expiredTombstones = 0;
  const gone = (r: BackupReplay): BackupReplay["files"] => {
    const files: BackupReplay["files"] = {};
    for (const kind of ["vrf", "json"] as const) if (r.files[kind] && !wants(r.id, kind)) files[kind] = r.files[kind];
    return files;
  };
  for (const p of prev?.replays ?? []) {
    const files = gone(p);
    if (scoped.has(p.id) && Object.keys(files).length === 0) continue;
    tombstones.push({ removedAt: input.now, replay: { ...p, files } });
    newTombstones++;
  }
  for (const t of prev?.tombstones ?? []) {
    const files = gone(t.replay);
    if (scoped.has(t.replay.id) && Object.keys(files).length === 0) continue; // it came back
    if (input.now - t.removedAt >= ttl) {
      expiredTombstones++;
      for (const f of Object.values(files)) if (f) deleteDriveIds.push(f.driveId);
    } else {
      tombstones.push({ ...t, replay: { ...t.replay, files } });
    }
  }

  // settings.soupprofile: switched off, the file is kept like a removed replay and deleted after the retention period.
  let settingsDriveId = prev?.settingsDriveId ?? null;
  let settingsTombstone = prev?.settingsTombstone ?? null;
  if (opt.settings) {
    settingsTombstone = null; // the engine updates the file in the profile folder by name
  } else {
    if (settingsDriveId) settingsTombstone = { removedAt: input.now, driveId: settingsDriveId };
    settingsDriveId = null;
    if (settingsTombstone && input.now - settingsTombstone.removedAt >= ttl) {
      deleteDriveIds.push(settingsTombstone.driveId);
      settingsTombstone = null;
    }
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: input.now,
    extensionVersion: input.extensionVersion,
    apiVersion: input.apiVersion,
    pcName: input.pcName,
    profile: input.profile,
    folders: input.folders.filter((f) => !scope.excluded.has(f.id)).map(folderEntry),
    replays,
    tombstones,
    settingsDriveId,
    settingsTombstone,
  };

  return {
    uploads,
    keep,
    deleteDriveIds: [...new Set(deleteDriveIds)],
    manifest,
    slots,
    stats: { newFiles, changedFiles, keptFiles: keep.length, newTombstones, expiredTombstones, bytesToUpload: uploads.reduce((s, j) => s + j.size, 0) },
  };
}

/** After an upload: put the Drive id into the manifest entry. */
export function applyUploaded(plan: BackupPlan, job: UploadJob, driveId: string): void {
  const slot = plan.slots.get(job);
  if (slot) slot.replay.files[job.kind] = { size: job.size, md5: job.md5, driveId };
}

/** After a failed upload: the manifest goes back to what the last backup knew (or leaves the file out so the next run retries it). */
export function applyFailed(plan: BackupPlan, job: UploadJob): void {
  const slot = plan.slots.get(job);
  if (!slot) return;
  if (slot.fallback) slot.replay.files[job.kind] = slot.fallback;
  else delete slot.replay.files[job.kind];
}

export function totalBytes(m: BackupManifest): number {
  let n = 0;
  for (const r of m.replays) for (const f of Object.values(r.files)) n += f?.size ?? 0;
  return n;
}
