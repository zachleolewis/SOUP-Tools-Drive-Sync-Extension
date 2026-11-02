// The UI: the settings page (account, backup, schedule, restore), the restore dialog and the header chip. Plain DOM + SOUP's Setting
// rows; the progress bar is SOUP's own kit.Progress mounted into a div.
import { type App, Modal, Notice, Setting, SettingTab } from "soup";
import type { DriveSyncController } from "./controller.ts";
import { plural } from "./env.ts";
import { userMessage } from "./errors.ts";
import type { BackupSummary } from "./restore.ts";
import { type DriveState, ago, chipText, formatBytes } from "./status.ts";

const PRIVACY_URL = "https://zachleolewis.github.io/soup-tools/privacy.html";

function fragment(...parts: Array<string | HTMLElement>): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const p of parts) f.append(p);
  return f;
}

function link(app: App, text: string, url: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = url;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    void app.process.openUrl(url);
  });
  return a;
}

/** A SOUP progress bar in `el`. Returns update() and unmount(). */
function mountProgress(app: App, el: HTMLElement): { update(percent: number | null): void; unmount(): void } {
  const { ReactDOM, createElement, kit } = app.ui.react;
  const root = ReactDOM.createRoot(el);
  const update = (percent: number | null) => root.render(createElement(kit.Progress, { value: percent }));
  update(null);
  return { update, unmount: () => root.unmount() };
}

/** "Uploading DS One.vrf: 42% (12.6 MB of 30 MB), file 2 of 5". */
export function progressLine(s: Extract<DriveState, { kind: "backingUp" | "restoring" }>): string {
  const what = s.kind === "restoring" ? s.label : s.label;
  const parts = [s.current ? `${what} ${s.current}` : what];
  if (s.percent !== null) parts.push(`${s.percent}%${s.bytesTotal > 0 ? ` (${formatBytes(s.bytesDone)} of ${formatBytes(s.bytesTotal)})` : ""}`);
  if (s.total > 0) parts.push(`file ${Math.min(s.done + 1, s.total)} of ${s.total}`);
  return parts.join(", ");
}

/** What a backup holds: "3 replays (3 replay files, 2 match files), 1 folder, settings, 34 KB". */
export function contentsLine(b: BackupSummary): string {
  const c = b.contents;
  const files = [c.replayFiles > 0 ? plural(c.replayFiles, "replay file") : "", c.matchFiles > 0 ? plural(c.matchFiles, "match file") : ""].filter(Boolean).join(", ");
  return [`${plural(c.replays, "replay")}${files ? ` (${files})` : ""}`, c.folders > 0 ? plural(c.folders, "folder") : "", c.settings ? "settings" : "no settings", formatBytes(b.bytes)].filter(Boolean).join(", ");
}

export class DriveSyncSettingTab extends SettingTab {
  private unsub: (() => void) | null = null;
  private progress: { update(p: number | null): void; unmount(): void } | null = null;
  private lastKind = "";
  private lastBusy: string | null = null;
  private lastSignedIn: boolean | null = null;
  private liveEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private resultEl: HTMLElement | null = null;

  private readonly c: DriveSyncController;
  private readonly openRestore: () => void;

  constructor(app: App, c: DriveSyncController, openRestore: () => void) {
    super(app);
    this.c = c;
    this.openRestore = openRestore;
  }

  display(): void {
    const el = this.containerEl;
    const app = this.app as App;
    const c = this.c;
    this.lastBusy = c.busy;
    this.lastSignedIn = c.isSignedIn;
    this.lastKind = c.status.get().kind;

    // ---- account
    new Setting(el).setName("Google account").setHeading();
    const account = new Setting(el).setName(c.isSignedIn ? (c.needsSignIn ? "Sign-in expired" : `Signed in as ${c.email ?? "your Google account"}`) : "Not signed in");
    account.setDesc(
      c.isSignedIn ? (c.needsSignIn ? "Google no longer accepts the saved sign-in. Sign in again to continue." : "Backups go to your own Google Drive.") : "Sign-in opens your browser. SOUP never sees your Google password.",
    );
    if (!c.isSignedIn || c.needsSignIn) {
      account.addButton((b) =>
        b
          .setButtonText(c.signingIn ? "Cancel sign-in" : c.needsSignIn ? "Sign in again" : "Sign in with Google")
          .setCta()
          .onClick(() => {
            if (c.signingIn) c.cancelSignIn();
            else void c.signIn().then(() => this.redraw());
            if (c.signingIn) this.redraw();
          }),
      );
    }
    if (c.isSignedIn) {
      account.addButton((b) =>
        b.setButtonText("Sign out").setWarning().onClick(async () => {
          const ok = await app.ui.confirm({ title: "Sign out of Google?", message: "This PC will stop backing up and Drive Sync's access to your Google account is revoked. Your backups stay in your Google Drive.", confirmLabel: "Sign out", destructive: true });
          if (ok) {
            await c.signOut();
            this.redraw();
          }
        }),
      );
    }
    if (!c.isSignedIn) {
      new Setting(el).setName("What this sees").setDesc("Only the files Drive Sync creates in your Google Drive (a folder called SOUP Sync), and your email address to show who is signed in. Nothing else in your Drive.");
    }

    // ---- backup
    new Setting(el).setName("Backup").setHeading();
    const now = new Setting(el).setName("Back up now");
    const last = c.state.last;
    this.resultEl = now.descEl;
    this.resultEl.textContent = c.busy ? (c.busy === "backup" ? "Backing up now..." : "Restoring now...") : last ? `${last.ok ? "Last backup" : "Last attempt"} ${ago(last.at, Date.now())}: ${last.message}` : "Not backed up yet.";
    now.addButton((b) => {
      const busy = c.busy === "backup";
      b.setButtonText(busy ? "Cancel" : "Back up now").setDisabled(!c.isSignedIn || c.needsSignIn || c.busy === "restore");
      if (!busy) b.setCta();
      b.onClick(() => {
        if (c.busy === "backup") c.cancel();
        else void c.backup("manual");
      });
    });
    const prog = new Setting(el).setName("Progress");
    prog.settingEl.style.display = c.busy !== null ? "" : "none";
    // The bar goes under the text (the controls column is too narrow for it).
    this.barEl = document.createElement("div");
    this.barEl.style.cssText = "width:100%;margin-top:6px";
    prog.infoEl.append(this.barEl);
    this.liveEl = prog.descEl;
    this.progress?.unmount();
    this.progress = mountProgress(app, this.barEl);

    new Setting(el)
      .setName("Automatic backup")
      .setDesc("After your Library changes (a couple of minutes later) and every few hours. Never while a match is running. The first backup is always started by you.")
      .addToggle((t) => t.setValue(c.state.auto).onChange((v) => void c.setSettings({ auto: v })));
    new Setting(el)
      .setName("Back up every (hours)")
      .setDesc("0 turns the timed backup off (changes still trigger one while Automatic backup is on).")
      .addText((t) => {
        t.setValue(String(c.state.intervalHours)).onChange((v) => {
          const n = Number(v);
          if (v.trim() !== "" && Number.isFinite(n) && n >= 0) void c.setSettings({ intervalHours: n });
        });
        (t.inputEl as HTMLInputElement).type = "number";
        (t.inputEl as HTMLInputElement).min = "0";
      });
    new Setting(el)
      .setName("This PC's name")
      .setDesc("Shown next to your backup when you restore on another PC.")
      .addText((t) => t.setPlaceholder("My PC").setValue(c.state.pcName).onChange((v) => void c.setSettings({ pcName: v.trim() })));

    // ---- what to back up
    new Setting(el).setName("What to back up").setHeading();
    const opts = c.state.options;
    const choice = (name: string, desc: string, key: "vrf" | "json" | "settings") =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(opts[key]).onChange((v) => void c.setSettings({ options: { ...c.state.options, [key]: v } })));
    choice("Replay files (.vrf)", "The replays themselves. Usually the biggest part of a backup.", "vrf");
    choice("Match files (.json)", "The match data next to each replay.", "json");
    choice("SOUP settings (.soupprofile)", "Your settings for this profile, restorable as a new profile.", "settings");
    new Setting(el).setName("Library folders to leave out").setDesc(
      "Turn a folder off to leave its replays (and the folders inside it) out of backups. New folders are included. Anything you leave out later stays in Google Drive for 30 days, like a replay you deleted, and is then removed from it.",
    );
    const foldersEl = document.createElement("div");
    el.append(foldersEl);
    void this.drawFolders(foldersEl);

    // ---- restore
    new Setting(el).setName("Restore").setHeading();
    new Setting(el)
      .setName("Restore from Google Drive")
      .setDesc("Adds the replays of a backup to your Library (ones you already have are skipped). Settings can come back as a new profile.")
      .addButton((b) => b.setButtonText("Restore...").setDisabled(!c.isSignedIn || c.needsSignIn || c.busy !== null).onClick(() => this.openRestore()));

    new Setting(el).setName("Privacy").setDesc(
      fragment("Only files Drive Sync creates in your Google Drive are visible to it. Your data goes between this PC and Google, nowhere else; the sign-in token stays in Windows Credential Manager. ", link(app, "Privacy details", PRIVACY_URL)),
    );

    this.unsub?.();
    this.unsub = c.status.subscribe((s) => this.onStatus(s));
    this.onStatus(c.status.get());
  }

  /** One toggle per Library folder (a folder below a left-out one follows it). */
  private async drawFolders(host: HTMLElement): Promise<void> {
    const c = this.c;
    let folders: Awaited<ReturnType<DriveSyncController["libraryFolders"]>>;
    try {
      folders = await c.libraryFolders();
    } catch {
      host.append(new Setting(host).setName("Folders").setDesc("Could not read your Library.").settingEl);
      return;
    }
    if (!host.isConnected) return;
    if (folders.length === 0) {
      new Setting(host).setName("No folders in your Library yet").setDesc("New folders are included in backups unless you turn them off here.");
      return;
    }
    const byParent = new Map<string | null, typeof folders>();
    const known = new Set(folders.map((f) => f.id));
    for (const f of folders) {
      const p = f.parentId && known.has(f.parentId) ? f.parentId : null;
      byParent.set(p, [...(byParent.get(p) ?? []), f]);
    }
    const left = new Set(c.state.options.excludedFolders);
    const walk = (parent: string | null, depth: number, parentOut: string | null): void => {
      for (const f of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
        const out = parentOut ?? (left.has(f.id) ? f.name : null);
        const row = new Setting(host).setName("00A000A000A000A0".repeat(depth) + f.name);
        if (parentOut) row.setDesc(`Left out with "${parentOut}"`).setDisabled(true);
        row.addToggle((t) =>
          t.setValue(!out).onChange((v) => {
            const next = new Set(c.state.options.excludedFolders);
            if (v) next.delete(f.id);
            else next.add(f.id);
            void c.setSettings({ options: { ...c.state.options, excludedFolders: [...next] } }).then(() => {
              if (host.isConnected) {
                host.replaceChildren();
                void this.drawFolders(host);
              }
            });
          }),
        );
        walk(f.id, depth + 1, out);
      }
    };
    walk(null, 0, null);
  }

  /** Update in place while a backup runs; redraw only when the buttons have to change. */
  private onStatus(s: DriveState): void {
    if (this.c.busy !== this.lastBusy || this.c.isSignedIn !== this.lastSignedIn || (s.kind === "error") !== (this.lastKind === "error")) {
      // The page may have been closed in between.
      if (this.containerEl.isConnected) this.redraw();
      return;
    }
    this.lastKind = s.kind;
    if (!this.liveEl) return;
    if (s.kind === "backingUp" || s.kind === "restoring") {
      this.progress?.update(s.percent);
      this.liveEl.textContent = progressLine(s);
    } else if (s.kind === "idle" && this.resultEl && this.c.state.last) {
      this.resultEl.textContent = `${this.c.state.last.ok ? "Last backup" : "Last attempt"} ${ago(this.c.state.last.at, Date.now())}: ${this.c.state.last.message}`;
    }
  }

  hide(): void {
    this.unsub?.();
    this.unsub = null;
    this.progress?.unmount();
    this.progress = null;
  }
}

// ---------------------------------------------------------------------------------------------------- restore dialog

export class RestoreModal extends Modal {
  private readonly c: DriveSyncController;

  constructor(app: App, c: DriveSyncController) {
    super(app);
    this.c = c;
  }

  onOpen(): void {
    this.setTitle("Restore from Google Drive");
    void this.showList();
  }

  private clear(): HTMLElement {
    this.contentEl.replaceChildren();
    return this.contentEl;
  }

  private note(...lines: string[]): void {
    for (const text of lines) {
      const p = document.createElement("p");
      p.textContent = text;
      this.contentEl.append(p);
    }
  }

  private async showList(): Promise<void> {
    this.clear();
    this.note("Looking for backups in your Google Drive...");
    let list: BackupSummary[];
    try {
      list = await this.c.backups();
    } catch (e) {
      this.clear();
      this.note(`Could not list your backups: ${userMessage(e)}`);
      return;
    }
    const el = this.clear();
    if (list.length === 0) {
      this.note("No backups found. Back up on this or another PC first (only backups made with Drive Sync in this Google account are listed).");
      return;
    }
    for (const b of list) {
      new Setting(el)
        .setName(`${b.profileName} (profile) on ${b.pcName || "a PC"}`)
        .setDesc(`${new Date(b.createdAt).toLocaleString()}  -  ${contentsLine(b)}`)
        .addButton((btn) => btn.setButtonText("Choose").setCta().onClick(() => void this.showDetail(b)));
    }
  }

  private async showDetail(b: BackupSummary): Promise<void> {
    this.clear();
    this.note("Comparing with your Library...");
    let plan;
    try {
      plan = await this.c.preview(b);
    } catch (e) {
      this.clear();
      this.note(`Could not read your Library: ${userMessage(e)}`);
      return;
    }
    const el = this.clear();
    const newFolders = plan.folders.filter((f) => !f.existingLocalId).length;
    this.note(
      `Backup of "${b.profileName}" from ${b.pcName || "a PC"}, ${new Date(b.createdAt).toLocaleString()}. It holds ${contentsLine(b)}.\n` +
        `${plural(plan.toRestore.length, "replay")} will be added to your active profile's Library (${formatBytes(plan.bytes)} to download), ${plan.skipped.length} already in your Library will be skipped, ${plural(newFolders, "folder")} will be created.`,
    );
    let withSettings = false;
    if (b.settingsDriveId) {
      new Setting(el).setName("Also restore settings as a new profile").setDesc("Nothing is overwritten. You switch to the new profile when you want.").addToggle((t) => t.setValue(false).onChange((v) => (withSettings = v)));
    }
    const status = document.createElement("p");
    el.append(status);
    new Setting(el)
      .addButton((btn) => btn.setButtonText("Back").onClick(() => void this.showList()))
      .addButton((btn) =>
        btn
          .setButtonText("Restore")
          .setCta()
          .setDisabled(plan.toRestore.length === 0 && !withSettings)
          .onClick(async () => {
            const ok = await (this.app as App).ui.confirm({
              title: "Restore this backup?",
              message: `${plural(plan.toRestore.length, "replay")} will be added to your Library, nothing you have is changed or removed${withSettings ? ", and the settings come back as a NEW profile" : ""}.`,
              confirmLabel: "Restore",
            });
            if (!ok) return;
            btn.setDisabled(true);
            const r = await this.c.restore(b, withSettings, (t) => (status.textContent = t));
            if (!r) {
              status.textContent = "The restore did not finish. See the notice for the reason.";
              return;
            }
            status.textContent = `${r.message}${r.settingsProfile ? `. Settings restored as the profile "${r.settingsProfile}".` : ""}${r.errors.length ? ` ${plural(r.errors.length, "problem")}: ${r.errors[0]}` : ""}`;
            new Notice(r.message, 8000, r.ok ? "success" : "info");
          }),
      );
  }
}

// ---------------------------------------------------------------------------------------------------- header chip

export function mountChip(el: HTMLElement, c: DriveSyncController, open: () => void): () => void {
  const b = document.createElement("button");
  b.className = "drive-sync-chip";
  b.type = "button";
  b.addEventListener("click", open);
  el.append(b);
  const paint = () => {
    const s = c.status.get();
    b.textContent = chipText(s, Date.now());
    b.dataset.state = s.kind;
    b.title = s.kind === "error" ? s.message : "Drive Sync: open settings";
  };
  const unsub = c.status.subscribe(paint);
  const timer = setInterval(paint, 30_000);
  paint();
  return () => {
    unsub();
    clearInterval(timer);
    b.remove();
  };
}
