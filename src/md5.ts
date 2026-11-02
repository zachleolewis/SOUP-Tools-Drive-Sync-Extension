// A small pure-JS MD5 (RFC 1321), incremental, so the same code hashes a whole file or one chunk at a time.
// Drive reports `md5Checksum` for every file it stores; we compute the same value locally to decide what changed and to
// cross-check uploads and downloads. (MD5 is used as a checksum here, not for security.)

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

export class Md5 {
  private a = 0x67452301 | 0;
  private b = 0xefcdab89 | 0;
  private c = 0x98badcfe | 0;
  private d = 0x10325476 | 0;
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private done = false;
  private readonly m = new Int32Array(16);

  update(data: Uint8Array): this {
    if (this.done) throw new Error("md5: already finished");
    this.total += data.length;
    let i = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = data.length - i;
    }
    return this;
  }

  /** Lower-case hex digest. */
  digest(): string {
    if (!this.done) {
      const bits = this.total * 8;
      const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
      const pad = new Uint8Array(padLen + 8);
      pad[0] = 0x80;
      const view = new DataView(pad.buffer);
      view.setUint32(padLen, bits >>> 0, true);
      view.setUint32(padLen + 4, Math.floor(bits / 4294967296) >>> 0, true);
      const t = this.total;
      this.update(pad);
      this.total = t;
      this.done = true;
    }
    const out = new Uint8Array(16);
    const v = new DataView(out.buffer);
    v.setInt32(0, this.a, true);
    v.setInt32(4, this.b, true);
    v.setInt32(8, this.c, true);
    v.setInt32(12, this.d, true);
    return Array.from(out, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  private block(data: Uint8Array, off: number): void {
    const m = this.m;
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      m[j] = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
    }
    let a = this.a, b = this.b, c = this.c, d = this.d;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + m[g]) | 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

export function md5Hex(data: Uint8Array | string): string {
  return new Md5().update(typeof data === "string" ? new TextEncoder().encode(data) : data).digest();
}

/** Hash big data in slices (keeps each `update` small; the caller may yield between slices). */
export function md5Sliced(data: Uint8Array, slice = 4 * 1024 * 1024): string {
  const h = new Md5();
  for (let i = 0; i < data.length; i += slice) h.update(data.subarray(i, Math.min(data.length, i + slice)));
  return h.digest();
}
