// The slices of SOUP's `app` that the engines use, as small interfaces. In SOUP they are `app.fs`, `app.library`, ... and in
// tests they are fakes.
import type { LibraryFolder } from "soup";
import type { LibrarySnapshot } from "./types.ts";

export interface FsPort {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<{ exists: boolean; isFile: boolean; size: number; modifiedMs: number }>;
  mkdir(path: string): Promise<void>;
  remove(path: string, o?: { recursive?: boolean }): Promise<void>;
}

export interface LibraryPort {
  list(): Promise<LibrarySnapshot>;
  importFiles(paths: string[], folderId?: string | null): Promise<{ imported: number; skipped: Array<{ path: string; error: string }> }>;
  createFolder(name: string, parentId?: string | null, color?: string | null): Promise<LibraryFolder>;
  renameReplay(replayId: string, name: string): Promise<void>;
}

export interface ProfilesPort {
  exportTo(path: string): Promise<string>;
  importFrom(path: string, choices?: { name?: string }): Promise<{ id: string; name: string }>;
}

export type BackupPhase = "reading" | "checking" | "uploading" | "settings" | "finishing";

export interface BackupProgress {
  phase: BackupPhase;
  /** Files handled so far / in all, in the current phase. */
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  current?: string;
}

export interface Logger {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Join with forward slashes (SOUP accepts them on Windows). */
export const joinPath = (...parts: string[]): string => parts.join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/");

/** "1 file", "2 files". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
