// The restore engine: Drive -> the ACTIVE profile's Library (and, if asked, the settings as a NEW profile).
import { BACKUPS_FOLDER_NAME, BACKUP_JSON_NAME, FOLDER_MIME, ROOT_FOLDER_NAME } from "./constants.ts";
import type { DriveClient } from "./drive.ts";
import { type FsPort, type LibraryPort, type Logger, type ProfilesPort, joinPath, nullLog, plural } from "./env.ts";
import { CancelError, isCancel, isRunFatal, userMessage } from "./errors.ts";
import { hashFile, yieldToUi } from "./hashing.ts";
import { md5Sliced } from "./md5.ts";
import { type RestorePlan, hashCandidates, pairImported, planRestore } from "./restore-plan.ts";
import { parseManifest } from "./backup.ts";
import { totalBytes } from "./plan.ts";
import type { BackupManifest } from "./types.ts";

export interface BackupSummary {
  folderId: string;
  profileName: string;
  profileId: string;
  pcName: string;
  createdAt: number;
  replayCount: number;
  bytes: number;
  settingsDriveId: string | null;
  /** What the backup holds, so the restore offers only that. */
  contents: { replays: number; replayFiles: number; matchFiles: number; folders: number; settings: boolean };
  manifest: BackupManifest;
}

export function contentsOf(m: BackupManifest): BackupSummary["contents"] {
  let replayFiles = 0;
  let matchFiles = 0;
  for (const r of m.replays) {
    if (r.files.vrf) replayFiles++;
    if (r.files.json) matchFiles++;
  }
  return { replays: m.replays.length, replayFiles, matchFiles, folders: m.folders.length, settings: !!m.settingsDriveId };
}

/** Every backup in `SOUP Sync/Backups/`, newest first. */
export async function listBackups(drive: DriveClient): Promise<BackupSummary[]> {
  const root = await drive.findByName(ROOT_FOLDER_NAME, "root", FOLDER_MIME);
  if (!root) return [];
  const backups = await drive.findByName(BACKUPS_FOLDER_NAME, root.id, FOLDER_MIME);
  if (!backups) return [];
  const out: BackupSummary[] = [];
  for (const f of await drive.listChildren(backups.id)) {
    if (f.mimeType !== FOLDER_MIME) continue;
    const json = await drive.findByName(BACKUP_JSON_NAME, f.id);
    if (!json) continue;
    const m = parseManifest(await drive.readText(json.id));
    if (!m) continue;
    out.push({ folderId: f.id, profileName: m.profile?.name ?? f.name, profileId: m.profile?.id ?? "", pcName: m.pcName ?? "", createdAt: m.createdAt, replayCount: m.replays.length, bytes: totalBytes(m), settingsDriveId: m.settingsDriveId, contents: contentsOf(m), manifest: m });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export interface RestoreDeps {
  drive: DriveClient;
  library: LibraryPort;
  fs: FsPort;
  profiles: Pick<ProfilesPort, "importFrom">;
  tempDir: string;
  /** Also restore the settings as a new profile. */
  settings: boolean;
  now?: () => number;
  onProgress?: (p: { phase: string; done: number; total: number; bytesDone: number; bytesTotal: number; current?: string }) => void;
  signal?: AbortSignal;
  log?: Logger;
}

export interface RestoreResult {
  ok: boolean;
  cancelled: boolean;
  restored: number;
  skipped: number;
  failed: number;
  foldersCreated: number;
  settingsProfile: string | null;
  errors: string[];
  message: string;
}

/** What a restore would do, without changing anything (for the confirmation dialog). */
export async function previewRestore(d: Pick<RestoreDeps, "library" | "fs" | "signal">, backup: BackupSummary): Promise<RestorePlan> {
  const snap = await d.library.list();
  const info = [];
  for (const r of snap.replays) {
    for (const kind of ["vrf", "json"] as const) {
      const path = kind === "vrf" ? r.vrfPath : r.jsonPath;
      if (!path) continue;
      const st = await d.fs.stat(path);
      if (st.exists && st.isFile) info.push({ replayId: r.id, kind, path, size: st.size });
    }
  }
  const md5 = new Set<string>();
  for (const l of hashCandidates(backup.manifest, info)) {
    if (d.signal?.aborted) throw new CancelError();
    const h = await hashFile(d.fs, l.path);
    if (h) md5.add(h.md5);
    await yieldToUi();
  }
  return planRestore({ backup: backup.manifest, localFolders: snap.folders, localReplays: snap.replays, localMd5: md5 });
}

const BATCH = 10;

export async function runRestore(d: RestoreDeps, backup: BackupSummary): Promise<RestoreResult> {
  const log = d.log ?? nullLog;
  const guard = () => {
    if (d.signal?.aborted) throw new CancelError();
  };
  let bytesBase = 0;
  let bytesTotal = 0;
  const progress = (phase: string, done: number, total: number, current?: string, bytes = 0) => d.onProgress?.({ phase, done, total, bytesDone: bytesBase + bytes, bytesTotal, current });
  const errors: string[] = [];
  let restored = 0;
  let failed = 0;
  let foldersCreated = 0;
  let settingsProfile: string | null = null;
  let cancelled = false;

  try {
    progress("Checking your Library", 0, 1);
    const plan = await previewRestore(d, backup);
    bytesTotal = plan.bytes;
    guard();

    // ---- folders (only when something is to be restored), parents first
    const local = new Map<string, string | null>(); // backup folder id -> local folder id
    if (plan.toRestore.length > 0) {
      const colors = new Map(backup.manifest.folders.map((f) => [f.id, f.color]));
      for (const step of plan.folders) {
        guard();
        if (step.existingLocalId) {
          local.set(step.backupId, step.existingLocalId);
          continue;
        }
        const parent = step.parentBackupId ? (local.get(step.parentBackupId) ?? null) : null;
        const made = await d.library.createFolder(step.name, parent, colors.get(step.backupId) ?? null);
        local.set(step.backupId, made.id);
        foldersCreated++;
      }
    }

    // ---- replays, in batches per target folder
    const groups = new Map<string | null, typeof plan.toRestore>();
    for (const item of plan.toRestore) {
      const target = item.replay.folderId ? (local.get(item.replay.folderId) ?? null) : null;
      groups.set(target, [...(groups.get(target) ?? []), item]);
    }
    const dir = joinPath(d.tempDir, "drive-sync", "restore");
    await d.fs.mkdir(dir);
    let done = 0;
    for (const [target, items] of groups) {
      for (let b = 0; b < items.length; b += BATCH) {
        guard();
        const batch = items.slice(b, b + BATCH);
        const paths: string[] = [];
        const okItems: typeof batch = [];
        try {
          for (const item of batch) {
            guard();
            progress("Restoring", done, plan.toRestore.length, item.replay.name);
            try {
              const got: string[] = [];
              for (const f of item.files) {
                const to = joinPath(dir, `${item.replay.id}.${f.kind}`);
                await d.drive.download(f.driveId, to, (got) => progress("Restoring", done, plan.toRestore.length, item.replay.name, got));
                const bytes = await d.fs.read(to);
                if (md5Sliced(bytes) !== f.md5) throw new Error("the downloaded file does not match the backup (checksum)");
                bytesBase += f.size;
                got.push(to);
              }
              paths.push(...got);
              okItems.push(item);
            } catch (e) {
              if (isCancel(e) || isRunFatal(e)) throw e;
              failed++;
              errors.push(`${item.replay.name}: ${userMessage(e)}`);
              log.warn(`restore of ${item.replay.id} failed: ${userMessage(e)}`);
            }
            done++;
          }
          if (paths.length > 0) {
            const before = (await d.library.list()).replays;
            const res = await d.library.importFiles(paths, target);
            for (const s of res.skipped) {
              failed++;
              errors.push(`${s.path.split(/[\\/]/).pop()}: ${s.error}`);
            }
            const after = (await d.library.list()).replays;
            const made = pairImported(okItems, target, before, after);
            for (const item of okItems) {
              const id = made.get(item.replay.id);
              if (!id) continue;
              restored++;
              const now = after.find((r) => r.id === id);
              if (now && now.name !== item.replay.name && item.replay.name) await d.library.renameReplay(id, item.replay.name).catch((e) => log.warn(`rename failed: ${userMessage(e)}`));
            }
            // Replays SOUP imported that we could not tell apart still count as restored.
            const unmatched = okItems.length - made.size;
            if (unmatched > 0) restored += Math.max(0, Math.min(unmatched, res.imported - made.size));
          }
        } finally {
          for (const p of paths) await d.fs.remove(p).catch(() => undefined);
        }
      }
    }

    // ---- settings as a NEW profile
    if (d.settings && backup.settingsDriveId) {
      guard();
      progress("Restoring settings", 0, 1);
      try {
        const to = joinPath(d.tempDir, "drive-sync", "restore", "settings.soupprofile");
        await d.drive.download(backup.settingsDriveId, to);
        const made = await d.profiles.importFrom(to, { name: `${backup.profileName} (restored)` });
        settingsProfile = made.name;
        await d.fs.remove(to).catch(() => undefined);
      } catch (e) {
        if (isCancel(e) || isRunFatal(e)) throw e;
        errors.push(`settings: ${userMessage(e)}`);
      }
    }

    const skipped = plan.skipped.length;
    return { ok: errors.length === 0, cancelled: false, restored, skipped, failed, foldersCreated, settingsProfile, errors, message: `Restored ${plural(restored, "replay")}, skipped ${skipped} already in your Library${failed ? `, ${failed} failed` : ""}` };
  } catch (e) {
    if (isCancel(e)) cancelled = true;
    else throw e;
    return { ok: false, cancelled, restored, skipped: 0, failed, foldersCreated, settingsProfile, errors, message: `Cancelled after restoring ${plural(restored, "replay")}` };
  }
}
