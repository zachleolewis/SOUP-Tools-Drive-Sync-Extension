import { Notice, Plugin } from "soup";
import { DriveSyncController } from "./controller.ts";
import { DriveSyncSettingTab, RestoreModal, mountChip } from "./ui.ts";
import "./styles.css";

export default class DriveSyncPlugin extends Plugin {
  private controller!: DriveSyncController;

  async onload() {
    this.controller = new DriveSyncController(this);
    await this.controller.init();
    const c = this.controller;

    this.addSettingTab(new DriveSyncSettingTab(this.app, c, () => new RestoreModal(this.app, c).open()));
    this.addHeaderItem({ id: "status", mount: (el) => mountChip(el, c, () => this.openSettings()) });

    this.addCommand({
      id: "backup-now",
      name: "Drive Sync: Back up now",
      callback: () => {
        if (!c.isSignedIn) {
          new Notice("Drive Sync: sign in with Google first (Settings > Extensions > Drive Sync)", 6000, "info");
          this.openSettings();
        } else if (c.busy) new Notice("Drive Sync: already running", 3000, "info");
        else void c.backup("manual");
      },
    });
    this.addCommand({ id: "restore", name: "Drive Sync: Restore from Google Drive", callback: () => (c.isSignedIn ? new RestoreModal(this.app, c).open() : this.openSettings()) });
    this.addCommand({ id: "settings", name: "Drive Sync: Open settings", callback: () => this.openSettings() });
  }

  onunload() {
    this.controller?.dispose();
  }
}
