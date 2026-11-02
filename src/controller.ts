// Ties the engines to SOUP: one backup or restore at a time, state in saveData, status for the UI, the scheduler.
import { Notice, apiVersion, type App, type Plugin } from "soup";
import { GoogleAuth } from "./auth.ts";
import { type BackupResult, runBackup } from "./backup.ts";
import type { Endpoints } from "./constants.ts";
import { DriveClient } from "./drive.ts";
import { loadEndpoints } from "./endpoints.ts";
import { type BackupProgress, type FsPort, type LibraryPort, type Logger, type ProfilesPort, plural } from "./env.ts";
import { DriveError, isCancel, userMessage } from "./errors.ts";
import { Md5Cache } from "./hashing.ts";
import { type BackupSummary, type RestoreResult, listBackups, previewRestore, runRestore } from "./restore.ts";
import type { RestorePlan } from "./restore-plan.ts";
import { Scheduler } from "./scheduler.ts";
import { type SavedState, normalizeState } from "./state.ts";
import { Status } from "./status.ts";
import { soupTransport } from "./transport.ts";
import type { LibrarySnapshot } from "./types.ts";

const CACHE_FILE = "md5-cache.json";

export class DriveSyncController {
  readonly status = new Status();
  state: SavedState = normalizeState(null);
  /** True after Google refused our stored sign-in: the person has to sign in again. */
  needsSignIn = false;
  private auth!: GoogleAuth;
  private drive!: DriveClient;
  private endpoints!: Endpoints;
  private scheduler!: Scheduler;
  private cache = new Md5Cache();
  private run: { kind: "backup" | "restore"; abort: AbortController } | null = null;
  private signInAbort: AbortController | null = null;
  private signedIn = false;
  private lastNotice = "";

  private readonly plugin: Plugin;
  private readonly onChange: () => void;

  constructor(plugin: Plugin, onChange: () => void = () => undefined) {
    this.plugin = plugin;
    this.onChange = onChange;
  }

  private get app(): App {
    return this.plugin.app;
  }

  private get log(): Logger {
    return this.app.log;
  }

  // ------------------------------------------------------------------ start / stop

  async init(): Promise<void> {
    const app = this.app;
    this.state = normalizeState(await this.plugin.loadData());
    this.endpoints = await loadEndpoints(app.fs, app.paths.machineDir, (m) => this.log.warn(m));
    const transport = soupTransport(app);
    this.auth = new GoogleAuth({ oauthPkce: (o) => app.auth.oauthPkce(o), refresh: (o) => app.auth.refresh(o), secrets: app.secrets, transport, endpoints: this.endpoints });
    this.drive = new DriveClient({ transport, tokens: this.auth, driveUrl: this.endpoints.driveUrl, uploadUrl: this.endpoints.uploadUrl });
    try {
      const text = await app.fs.readText(`${app.paths.dataDir}/${CACHE_FILE}`);
      this.cache = new Md5Cache(JSON.parse(text));
    } catch {
      this.cache = new Md5Cache();
    }
    this.signedIn = await this.auth.isSignedIn();
    if (this.signedIn && !this.state.email) {
      this.state.email = await this.auth.storedEmail();
    }
    this.publishIdle();

    this.scheduler = new Scheduler({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      settings: () => ({ auto: this.state.auto, intervalHours: this.state.intervalHours }),
      isSignedIn: () => this.signedIn && !this.needsSignIn,
      isBusy: () => this.run !== null,
      isLive: () => this.isMatchLive(),
      run: async (reason) => {
        const r = await this.backup(reason);
        return !!r?.ok;
      },
      lastSuccessAt: () => this.state.lastOk?.at ?? null,
    });
    this.scheduler.start();
    this.plugin.registerEvent(app.library.onChanged(() => this.scheduler.notifyLibraryChanged()));
  }

  dispose(): void {
    this.scheduler?.stop();
    this.run?.abort.abort();
    this.signInAbort?.abort();
  }

  // ------------------------------------------------------------------ state

  async save(): Promise<void> {
    await this.plugin.saveData(this.state);
    this.onChange();
  }

  async setSettings(patch: Partial<Pick<SavedState, "auto" | "intervalHours" | "pcName" | "options">>): Promise<void> {
    this.state = normalizeState({ ...this.state, ...patch });
    await this.save();
  }

  get email(): string | null {
    return this.state.email;
  }
  get isSignedIn(): boolean {
    return this.signedIn;
  }
  get busy(): "backup" | "restore" | null {
    return this.run?.kind ?? null;
  }

  private publishIdle(): void {
    if (!this.signedIn) this.status.set({ kind: "signedOut" });
    else if (this.needsSignIn) this.status.set({ kind: "error", message: "Sign in again" });
    else this.status.set({ kind: "idle", lastAt: this.state.last?.at ?? null, lastOk: this.state.last?.ok ?? true });
    this.plugin.addStatusText(this.statusText());
  }

  statusText(): string {
    if (!this.signedIn) return "Signed out";
    const l = this.state.last;
    return l ? l.message : "Signed in";
  }

  private async isMatchLive(): Promise<boolean> {
    try {
      const live = (await this.app.matches.liveState()) as { status?: string } | null;
      return !!live && !!live.status && live.status !== "idle";
    } catch {
      return false; // the match-capture module is off: nothing to wait for
    }
  }

  // ------------------------------------------------------------------ sign in / out

  async signIn(): Promise<void> {
    this.signInAbort = new AbortController();
    try {
      const email = await this.auth.signIn(this.signInAbort.signal);
      this.signedIn = true;
      this.needsSignIn = false;
      this.state.email = email;
      await this.save();
      this.publishIdle();
      new Notice(email ? `Signed in to Google as ${email}` : "Signed in to Google", 6000, "success");
    } catch (e) {
      if ((e as { code?: string }).code === "auth_cancelled") return;
      const code = (e as { code?: string }).code;
      const msg = code === "auth_denied" ? "Google sign-in was declined." : code === "auth_timeout" ? "Google sign-in timed out. Try again." : userMessage(e);
      new Notice(msg, 8000, "error");
      this.log.warn(`sign-in failed: ${code ?? "error"}`);
    } finally {
      this.signInAbort = null;
    }
  }

  cancelSignIn(): void {
    this.signInAbort?.abort();
  }

  get signingIn(): boolean {
    return this.signInAbort !== null;
  }

  async signOut(): Promise<void> {
    this.run?.abort.abort();
    const revoked = await this.auth.signOut();
    this.signedIn = false;
    this.needsSignIn = false;
    this.state.email = null;
    this.state.folders = {};
    await this.save();
    this.publishIdle();
    new Notice(revoked ? "Signed out. Drive Sync's access to your Google account was revoked." : "Signed out on this PC. Google could not be reached to revoke access; you can remove it at myaccount.google.com/permissions.", revoked ? 6000 : 10000, revoked ? "success" : "info");
  }

  // ------------------------------------------------------------------ backup

  private ports(): { fs: FsPort; library: LibraryPort; profiles: ProfilesPort } {
    const a = this.app;
    return { fs: a.fs as FsPort, library: a.library as unknown as LibraryPort & { list(): Promise<LibrarySnapshot> }, profiles: { exportTo: (p) => a.profiles.exportTo(p), importFrom: (p, c) => a.profiles.importFrom(p, c) } };
  }

  /** Back up now. Returns null when something else is running or nobody is signed in. */
  async backup(reason: "manual" | "changed" | "interval" = "manual"): Promise<BackupResult | null> {
    if (this.run || !this.signedIn) return null;
    const abort = new AbortController();
    this.run = { kind: "backup", abort };
    this.onChange();
    const { fs, library, profiles } = this.ports();
    this.status.set({ kind: "backingUp", phase: "reading", done: 0, total: 0, percent: null, bytesDone: 0, bytesTotal: 0, current: "", label: "Starting" });
    try {
      const profile = await this.app.profiles.active();
      if (!profile) throw new Error("No active SOUP profile");
      const result = await runBackup({
        drive: this.drive,
        library,
        fs,
        profiles,
        tempDir: this.app.paths.tempDir,
        profile: { id: profile.id, name: profile.name },
        pcName: this.state.pcName || "My PC",
        extensionVersion: this.plugin.manifest.version,
        apiVersion,
        cache: this.cache,
        options: this.state.options,
        folders: this.state.folders,
        signal: abort.signal,
        log: this.log,
        onProgress: (p) => this.onBackupProgress(p),
      });
      this.state.folders = result.folders;
      const run = { at: result.at, ok: result.ok, message: result.message, uploaded: result.uploaded, bytes: result.bytesUploaded, replays: result.replays };
      this.state.last = run;
      if (result.ok) this.state.lastOk = run;
      await this.saveCache();
      await this.save();
      if (result.cancelled) new Notice("Backup cancelled", 4000, "info");
      else if (!result.ok) this.notifyError(`Drive Sync: ${result.message}`, reason);
      else if (reason === "manual") new Notice(result.uploaded === 0 ? "Drive Sync: everything is already backed up" : `Drive Sync: backed up ${plural(result.uploaded, "file")}`, 5000, "success");
      return result;
    } catch (e) {
      await this.handleFailure(e, reason);
      return null;
    } finally {
      this.run = null;
      this.publishIdle();
      this.onChange();
    }
  }

  private onBackupProgress(p: BackupProgress): void {
    const uploading = p.phase === "uploading";
    const percent = uploading && p.bytesTotal > 0 ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100)) : p.phase === "checking" && p.total > 0 ? Math.floor((p.done / p.total) * 100) : null;
    const label = { reading: "Reading your Library", checking: "Checking files", uploading: "Uploading", settings: "Saving your settings", finishing: "Finishing" }[p.phase];
    this.status.set({
      kind: "backingUp",
      phase: p.phase,
      done: uploading ? p.done : 0,
      total: uploading ? p.total : 0,
      percent,
      bytesDone: p.bytesDone,
      bytesTotal: p.bytesTotal,
      current: p.current ?? "",
      label,
    });
  }

  private async saveCache(): Promise<void> {
    if (!this.cache.dirty) return;
    try {
      await this.app.fs.write(`${this.app.paths.dataDir}/${CACHE_FILE}`, JSON.stringify(this.cache));
      this.cache.dirty = false;
    } catch (e) {
      this.log.warn(`could not save the checksum cache: ${userMessage(e)}`);
    }
  }

  /** The Library's folders (for the "what to back up" list). */
  async libraryFolders(): Promise<LibrarySnapshot["folders"]> {
    return (await this.ports().library.list()).folders;
  }

  cancel(): void {
    this.run?.abort.abort();
  }

  private async handleFailure(e: unknown, reason: string, recordAsBackup = true): Promise<void> {
    if (isCancel(e)) {
      new Notice("Cancelled", 3000, "info");
      return;
    }
    const msg = userMessage(e);
    if (e instanceof DriveError && e.kind === "auth") this.needsSignIn = true;
    if (recordAsBackup) {
      this.state.last = { at: Date.now(), ok: false, message: msg, uploaded: 0, bytes: 0, replays: this.state.last?.replays ?? 0 };
      await this.save();
    }
    this.log.warn(`drive sync failed (${e instanceof DriveError ? e.kind : "error"}): ${msg}`);
    // Offline is routine for a scheduled run: it just tries again later.
    if (reason !== "manual" && e instanceof DriveError && e.kind === "offline") return;
    this.notifyError(`Drive Sync: ${msg}`, reason);
  }

  private notifyError(msg: string, reason: string): void {
    if (reason !== "manual" && msg === this.lastNotice) return; // do not repeat the same scheduled failure
    this.lastNotice = msg;
    new Notice(msg, 10000, "error");
  }

  // ------------------------------------------------------------------ restore

  async backups(): Promise<BackupSummary[]> {
    try {
      return await listBackups(this.drive);
    } catch (e) {
      if (e instanceof DriveError && e.kind === "auth") this.needsSignIn = true;
      throw e;
    }
  }

  async preview(b: BackupSummary): Promise<RestorePlan> {
    const { fs, library } = this.ports();
    return previewRestore({ fs, library }, b);
  }

  async restore(b: BackupSummary, settings: boolean, onProgress: (text: string) => void): Promise<RestoreResult | null> {
    if (this.run || !this.signedIn) return null;
    const abort = new AbortController();
    this.run = { kind: "restore", abort };
    this.onChange();
    const { fs, library, profiles } = this.ports();
    try {
      const result = await runRestore(
        {
          drive: this.drive,
          library,
          fs,
          profiles,
          tempDir: this.app.paths.tempDir,
          settings,
          signal: abort.signal,
          log: this.log,
          onProgress: (p) => {
            const percent = p.bytesTotal > 0 ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100)) : null;
            this.status.set({ kind: "restoring", label: p.phase, done: p.done, total: p.total, percent, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, current: p.current ?? "" });
            onProgress(p.total > 0 ? `${p.phase}: ${Math.min(p.done + 1, p.total)} of ${p.total}${percent !== null ? ` (${percent}%)` : ""}${p.current ? ` - ${p.current}` : ""}` : p.phase);
          },
        },
        b,
      );
      return result;
    } catch (e) {
      await this.handleFailure(e, "manual", false);
      return null;
    } finally {
      this.run = null;
      this.publishIdle();
      this.onChange();
    }
  }
}
