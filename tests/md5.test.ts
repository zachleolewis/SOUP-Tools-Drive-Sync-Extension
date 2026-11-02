import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Md5, md5Hex, md5Sliced } from "../src/md5.ts";

test("md5: RFC 1321 test vectors", () => {
  const v: Array<[string, string]> = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
  ];
  for (const [input, want] of v) assert.equal(md5Hex(input), want, JSON.stringify(input));
});

test("md5: matches node's crypto around every block boundary", () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 4096, 65537]) {
    const data = randomBytes(n);
    assert.equal(md5Hex(data), createHash("md5").update(data).digest("hex"), `length ${n}`);
  }
});

test("md5: incremental updates in odd pieces equal one update", () => {
  const data = randomBytes(10_000);
  const h = new Md5();
  for (let i = 0, step = 1; i < data.length; i += step, step = (step * 3 + 1) % 211 || 1) h.update(data.subarray(i, Math.min(data.length, i + step)));
  assert.equal(h.digest(), createHash("md5").update(data).digest("hex"));
  assert.equal(md5Sliced(data, 777), createHash("md5").update(data).digest("hex"));
});

test("md5: a 12 MB buffer (a replay-sized file) hashes correctly", () => {
  const data = randomBytes(12 * 1024 * 1024);
  assert.equal(md5Sliced(data), createHash("md5").update(data).digest("hex"));
});

test("md5: digest is stable when called twice, and update after digest is refused", () => {
  const h = new Md5().update(new TextEncoder().encode("abc"));
  assert.equal(h.digest(), h.digest());
  assert.throws(() => h.update(new Uint8Array(1)));
});
