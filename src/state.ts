// What the extension keeps with saveData (per SOUP profile, never a token): settings, remembered Drive folder ids, the last result.
import { DEFAULT_INTERVAL_HOURS } from "./constants.ts";
import type { DriveFolders } from "./layout.ts";

export interface LastRun {
  at: number;
  ok: boolean;
  message: string;
  uploaded: number;
  bytes: number;
  replays: number;
}

/** What to back up. Folder ids in `excludedFolders` leave out their replays and everything below them; new folders are included. */
export interface BackupOptions {
  vrf: boolean;
  json: boolean;
  settings: boolean;
  excludedFolders: string[];
}

export const DEFAULT_OPTIONS: BackupOptions = { vrf: true, json: true, settings: true, excludedFolders: [] };

export interface SavedState {
  email: string | null;
  folders: Partial<DriveFolders>;
  auto: boolean;
  intervalHours: number;
  pcName: string;
  options: BackupOptions;
  /** The last backup that finished without problems. */
  lastOk: LastRun | null;
  /** The last attempt, successful or not. */
  last: LastRun | null;
}

export const DEFAULT_STATE: SavedState = { email: null, folders: {}, auto: true, intervalHours: DEFAULT_INTERVAL_HOURS, pcName: "", options: DEFAULT_OPTIONS, lastOk: null, last: null };

export function normalizeState(raw: unknown): SavedState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<SavedState>;
  const hours = Number(o.intervalHours);
  return {
    email: typeof o.email === "string" ? o.email : null,
    folders: o.folders && typeof o.folders === "object" ? o.folders : {},
    auto: typeof o.auto === "boolean" ? o.auto : DEFAULT_STATE.auto,
    intervalHours: Number.isFinite(hours) && hours >= 0 ? Math.min(hours, 24 * 30) : DEFAULT_INTERVAL_HOURS,
    pcName: typeof o.pcName === "string" ? o.pcName.slice(0, 60) : "",
    options: normalizeOptions(o.options),
    lastOk: o.lastOk ?? null,
    last: o.last ?? null,
  };
}

export function normalizeOptions(raw: unknown): BackupOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<BackupOptions>;
  const flag = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    vrf: flag(o.vrf, true),
    json: flag(o.json, true),
    settings: flag(o.settings, true),
    excludedFolders: Array.isArray(o.excludedFolders) ? [...new Set(o.excludedFolders.filter((x): x is string => typeof x === "string"))] : [],
  };
}
