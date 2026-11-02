// Hashing local files without hashing them twice: results are remembered by (path, size, modified time).
import type { FsPort } from "./env.ts";
import { md5Sliced } from "./md5.ts";

export interface CacheEntry {
  size: number;
  mtime: number;
  md5: string;
}

export class Md5Cache {
  private map: Map<string, CacheEntry>;
  dirty = false;

  constructor(entries?: Record<string, CacheEntry>) {
    this.map = new Map(Object.entries(entries ?? {}));
  }

  get(path: string, size: number, mtime: number): string | null {
    const e = this.map.get(path);
    return e && e.size === size && e.mtime === mtime ? e.md5 : null;
  }

  set(path: string, size: number, mtime: number, md5: string): void {
    this.map.set(path, { size, mtime, md5 });
    this.dirty = true;
  }

  /** Forget paths that are no longer in `keep` (so the cache does not grow forever). */
  prune(keep: Set<string>): void {
    for (const k of [...this.map.keys()]) if (!keep.has(k)) (this.map.delete(k), (this.dirty = true));
  }

  toJSON(): Record<string, CacheEntry> {
    return Object.fromEntries(this.map);
  }
}

/**
 * md5 of a file. SOUP's `app.fs` has no ranged read, so the whole file is read once (a replay is roughly 10 to 60 MB) and hashed in
 * slices; the bytes are dropped before the next file. Returns null when the file is not there.
 */
export async function hashFile(fs: FsPort, path: string, cache?: Md5Cache): Promise<{ size: number; mtime: number; md5: string } | null> {
  const st = await fs.stat(path);
  if (!st.exists || !st.isFile) return null;
  const cached = cache?.get(path, st.size, st.modifiedMs);
  if (cached) return { size: st.size, mtime: st.modifiedMs, md5: cached };
  const bytes = await fs.read(path);
  const md5 = md5Sliced(bytes);
  cache?.set(path, bytes.length, st.modifiedMs, md5);
  return { size: bytes.length, mtime: st.modifiedMs, md5 };
}

/** Let the UI breathe between big files. */
export const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
