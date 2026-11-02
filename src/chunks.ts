// The arithmetic of Drive's resumable upload (https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable).
import { CHUNK_QUANTUM, CHUNK_SIZE } from "./constants.ts";

export interface Chunk {
  offset: number;
  length: number;
  /** `Content-Range` header value. */
  contentRange: string;
  last: boolean;
}

/** The chunk that starts at `offset` in a file of `total` bytes. Every chunk but the last is `chunkSize` (a multiple of 256 KiB). */
export function chunkAt(total: number, offset: number, chunkSize = CHUNK_SIZE): Chunk {
  if (chunkSize <= 0 || chunkSize % CHUNK_QUANTUM !== 0) throw new Error("chunk size must be a positive multiple of 256 KiB");
  if (total <= 0) throw new Error("a resumable upload needs at least one byte");
  if (offset < 0 || offset >= total) throw new Error(`offset ${offset} is outside a file of ${total} bytes`);
  const length = Math.min(chunkSize, total - offset);
  return { offset, length, contentRange: `bytes ${offset}-${offset + length - 1}/${total}`, last: offset + length >= total };
}

/** Every chunk from the start (for tests and progress totals). */
export function allChunks(total: number, chunkSize = CHUNK_SIZE): Chunk[] {
  const out: Chunk[] = [];
  for (let o = 0; o < total; ) {
    const c = chunkAt(total, o, chunkSize);
    out.push(c);
    o += c.length;
  }
  return out;
}

/** The `Content-Range` that asks Drive how much it has: `bytes *\/total`. */
export const statusRange = (total: number): string => `bytes */${total}`;

/**
 * Where to continue after a 308: the `Range` header says `bytes=0-<last persisted byte>`; no header means nothing was kept.
 * Returns the next offset to send.
 */
export function nextOffsetFromRange(range: string | undefined | null): number {
  if (!range) return 0;
  const m = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!m) throw new Error(`unexpected Range header from Drive: ${range}`);
  return Number(m[1]) + 1;
}
