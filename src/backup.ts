// The backup engine: Library -> Drive. Nothing here knows about the UI; progress comes out through a callback.
import { BACKUP_FORMAT, BACKUP_JSON_NAME, RESUMABLE_THRESHOLD, SETTINGS_FILE_NAME } from "./constants.ts";
import type { DriveClient } from "./drive.ts";
import { type BackupProgress, type FsPort, type LibraryPort, type Logger, type ProfilesPort, joinPath, nullLog, plural } from "./env.ts";
import { CancelError, isCancel, isRunFatal, userMessage } from "./errors.ts";
import { type Md5Cache, hashFile, yieldToUi } from "./hashing.ts";
import { type DriveFolders, resolveFolders } from "./layout.ts";
import { md5Sliced } from "./md5.ts";
import { applyFailed, applyUploaded, inScope, planBackup } from "./plan.ts";
import { type BackupOptions, DEFAULT_OPTIONS } from "./state.ts";
import type { BackupManifest, LocalFile, RemoteFile } from "./types.ts";

export interface BackupDeps {
  drive: DriveClient;
  library: Pick<LibraryPort, "list">;
  fs: FsPort;
  profiles: Pick<ProfilesPort, "exportTo">;
  tempDir: string;
  profile: { id: string; name: string };
  pcName: string;
  extensionVersion: string;
  apiVersion: string;
  cache: Md5Cache;
  /** What to back up (default: everything). */
  options?: BackupOptions;
  /** Folder ids remembered from the last run. */
  folders?: Partial<DriveFolders>;
  now?: () => number;
  onProgress?: (p: BackupProgress) => void;
  signal?: AbortSignal;
  log?: Logger;
}

export interface BackupResult {
  ok: boolean;
  cancelled: boolean;
  at: number;
  uploaded: number;
  kept: number;
  deleted: number;
  failed: number;
  bytesUploaded: number;
  replays: number;
  tombstones: number;
  /** A line for the status text. */
  message: string;
  errors: string[];
  folders: DriveFolders;
  manifest: BackupManifest;
}

const MIME = { vrf: "application/octet-stream", json: "application/json" } as const;

export function parseManifest(text: string): BackupManifest | null {
  try {
    const m = JSON.parse(text) as Partial<BackupManifest>;
    if (m && m.format === BACKUP_FORMAT && Array.isArray(m.replays) && Array.isArray(m.folders)) {
      return { ...(m as BackupManifest), tombstones: Array.isArray(m.tombstones) ? m.tombstones : [], settingsDriveId: m.settingsDriveId ?? null };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function runBackup(d: BackupDeps): Promise<BackupResult> {
  const log = d.log ?? nullLog;
  const now = d.now ?? Date.now;
  const started = now();
  const cancelled = () => d.signal?.aborted === true;
  const guard = () => {
    if (cancelled()) throw new CancelError();
  };
  const progress = (p: BackupProgress) => d.onProgress?.(p);
  const errors: string[] = [];
  const base: BackupProgress = { phase: "reading", done: 0, total: 0, bytesDone: 0, bytesTotal: 0 };

  // ---- 1. the Library, and md5 of each file (remembered between runs)
  progress({ ...base, phase: "reading" });
  const snap = await d.library.list();
  guard();
  const options = d.options ?? DEFAULT_OPTIONS;
  const replayNames = new Map(snap.replays.map((r) => [r.id, r.name]));
  const scope = inScope(snap.replays, snap.folders, options);
  const wanted: Array<{ replayId: string; kind: "vrf" | "json"; path: string }> = [];
  for (const r of scope.replays) {
    if (options.vrf && r.vrfPath) wanted.push({ replayId: r.id, kind: "vrf", path: r.vrfPath });
    if (options.json && r.jsonPath) wanted.push({ replayId: r.id, kind: "json", path: r.jsonPath });
  }
  const local: LocalFile[] = [];
  for (let i = 0; i < wanted.length; i++) {
    guard();
    progress({ ...base, phase: "checking", done: i, total: wanted.length, current: wanted[i].path });
    try {
      const h = await hashFile(d.fs, wanted[i].path, d.cache);
      if (h) local.push({ ...wanted[i], size: h.size, md5: h.md5 });
    } catch (e) {
      log.warn(`could not read ${wanted[i].path}: ${userMessage(e)}`);
      errors.push(`${wanted[i].replayId}.${wanted[i].kind}: could not be read`);
    }
    if (i % 8 === 7) await yieldToUi();
  }
  d.cache.prune(new Set(wanted.map((w) => w.path)));

  // ---- 2. Drive: folders, what is there, the last backup.json
  const folders = await resolveFolders(d.drive, d.folders, d.profile);
  guard();
  const remoteFiles = await d.drive.listChildren(folders.library);
  const remote = new Map<string, RemoteFile>();
  for (const f of remoteFiles) {
    if (f.mimeType === "application/vnd.google-apps.folder") continue;
    remote.set(f.name, { id: f.id, name: f.name, size: Number(f.size ?? 0), md5: f.md5Checksum ?? null });
  }
  const prevFile = await d.drive.findByName(BACKUP_JSON_NAME, folders.profile);
  let previous: BackupManifest | null = null;
  if (prevFile) {
    previous = parseManifest(await d.drive.readText(prevFile.id));
    if (!previous) log.warn("backup.json in Drive could not be read; treating this as a first backup");
  }
  guard();

  // ---- 3. the plan
  const plan = planBackup({
    replays: snap.replays,
    folders: snap.folders,
    local,
    previous,
    remote,
    now: started,
    profile: d.profile,
    pcName: d.pcName,
    extensionVersion: d.extensionVersion,
    apiVersion: d.apiVersion,
    options,
  });
  log.info(`plan: ${plan.stats.newFiles} new, ${plan.stats.changedFiles} changed, ${plan.stats.keptFiles} unchanged, ${plan.stats.newTombstones} newly removed`);

  // ---- 4. uploads, one at a time
  let uploaded = 0;
  let failed = 0;
  let bytesUploaded = 0;
  let fatal: unknown = null;
  let wasCancelled = false;
  const bytesTotal = plan.stats.bytesToUpload;
  for (let i = 0; i < plan.uploads.length; i++) {
    const job = plan.uploads[i];
    if (fatal || wasCancelled) {
      applyFailed(plan, job);
      continue;
    }
    if (cancelled()) {
      wasCancelled = true;
      applyFailed(plan, job);
      continue;
    }
    const shown = `${replayNames.get(job.replayId) ?? job.replayId}.${job.kind}`;
    const emit = (bytes: number) => progress({ phase: "uploading", done: i, total: plan.uploads.length, bytesDone: bytesUploaded + bytes, bytesTotal, current: shown });
    emit(0);
    try {
      let file;
      if (job.size <= RESUMABLE_THRESHOLD) {
        const bytes = await d.fs.read(job.path);
        // The file may have changed since it was hashed: trust what is being sent.
        job.md5 = md5Sliced(bytes);
        job.size = bytes.length;
        file = await d.drive.uploadMultipart({ name: job.name, parentId: folders.library, fileId: job.driveId, mimeType: MIME[job.kind], bytes });
      } else {
        file = await d.drive.uploadResumable({ name: job.name, parentId: folders.library, fileId: job.driveId, mimeType: MIME[job.kind], file: job.path, total: job.size, onProgress: (done) => emit(done), signal: d.signal });
      }
      if (file.md5Checksum && file.md5Checksum !== job.md5) {
        throw new Error("the file changed while it was being uploaded (will be retried next time)");
      }
      applyUploaded(plan, job, file.id);
      uploaded++;
      bytesUploaded += job.size;
      progress({ phase: "uploading", done: i + 1, total: plan.uploads.length, bytesDone: bytesUploaded, bytesTotal, current: shown });
    } catch (e) {
      applyFailed(plan, job);
      if (isCancel(e)) {
        wasCancelled = true;
      } else if (isRunFatal(e)) {
        fatal = e;
      } else {
        failed++;
        errors.push(`${job.name}: ${userMessage(e)}`);
        log.warn(`upload of ${job.name} failed: ${userMessage(e)}`);
      }
    }
  }
  if (fatal) throw fatal; // nothing consistent to write (no network, signed out, Drive full)

  // ---- 5. settings.soupprofile (not when cancelled)
  if (!wasCancelled && options.settings) {
    progress({ phase: "settings", done: 0, total: 1, bytesDone: bytesUploaded, bytesTotal });
    try {
      const dir = joinPath(d.tempDir, "drive-sync");
      await d.fs.mkdir(dir);
      const path = await d.profiles.exportTo(joinPath(dir, SETTINGS_FILE_NAME));
      const bytes = await d.fs.read(path);
      const existing = plan.manifest.settingsDriveId ? await d.drive.getFile(plan.manifest.settingsDriveId) : await d.drive.findByName(SETTINGS_FILE_NAME, folders.profile);
      const f = await d.drive.uploadMultipart({ name: SETTINGS_FILE_NAME, parentId: folders.profile, fileId: existing && !existing.trashed ? existing.id : undefined, mimeType: "application/json", bytes });
      plan.manifest.settingsDriveId = f.id;
      await d.fs.remove(path).catch(() => undefined);
    } catch (e) {
      if (isRunFatal(e)) throw e;
      errors.push(`settings: ${userMessage(e)}`);
      log.warn(`settings export failed: ${userMessage(e)}`);
    }
  }

  // ---- 6. backup.json, written after everything it describes
  progress({ phase: "finishing", done: 0, total: 1, bytesDone: bytesUploaded, bytesTotal });
  plan.manifest.createdAt = now();
  const body = new TextEncoder().encode(JSON.stringify(plan.manifest));
  await d.drive.uploadMultipart({ name: BACKUP_JSON_NAME, parentId: folders.profile, fileId: prevFile && !prevFile.trashed ? prevFile.id : undefined, mimeType: "application/json", bytes: body });

  // ---- 7. clean-up of what the new backup.json no longer mentions
  let deleted = 0;
  for (const id of plan.deleteDriveIds) {
    try {
      await d.drive.delete(id);
      deleted++;
    } catch (e) {
      if (isRunFatal(e)) break;
      log.warn(`could not delete an old file: ${userMessage(e)}`);
    }
  }

  const ok = !wasCancelled && failed === 0 && errors.length === 0;
  const message = wasCancelled
    ? `Cancelled after ${plural(uploaded, "file")}`
    : ok
      ? uploaded === 0
        ? "Backed up: nothing new"
        : `Backed up ${plural(uploaded, "file")}`
      : `Backed up with ${plural(errors.length, "problem")}: ${errors[0]}`;
  return {
    ok,
    cancelled: wasCancelled,
    at: now(),
    uploaded,
    kept: plan.stats.keptFiles,
    deleted,
    failed,
    bytesUploaded,
    replays: plan.manifest.replays.length,
    tombstones: plan.manifest.tombstones.length,
    message,
    errors,
    folders,
    manifest: plan.manifest,
  };
}
