import assert from "node:assert/strict";
import { test } from "node:test";
import { allChunks, chunkAt, nextOffsetFromRange, statusRange } from "../src/chunks.ts";
import { CHUNK_QUANTUM, CHUNK_SIZE } from "../src/constants.ts";

test("chunk size is 8 MiB, a multiple of Drive's 256 KiB quantum", () => {
  assert.equal(CHUNK_SIZE, 8 * 1024 * 1024);
  assert.equal(CHUNK_SIZE % CHUNK_QUANTUM, 0);
});

test("a 20 MB file is three chunks: 8 MiB, 8 MiB and the rest, with exact Content-Range headers", () => {
  const total = 20 * 1000 * 1000;
  const c = allChunks(total);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => x.length), [CHUNK_SIZE, CHUNK_SIZE, total - 2 * CHUNK_SIZE]);
  assert.equal(c[0].contentRange, `bytes 0-${CHUNK_SIZE - 1}/${total}`);
  assert.equal(c[1].contentRange, `bytes ${CHUNK_SIZE}-${2 * CHUNK_SIZE - 1}/${total}`);
  assert.equal(c[2].contentRange, `bytes ${2 * CHUNK_SIZE}-${total - 1}/${total}`);
  assert.deepEqual(c.map((x) => x.last), [false, false, true]);
  assert.equal(c.reduce((s, x) => s + x.length, 0), total);
});

test("a file of exactly one chunk, and one byte more", () => {
  assert.equal(allChunks(CHUNK_SIZE).length, 1);
  assert.equal(allChunks(CHUNK_SIZE)[0].last, true);
  const two = allChunks(CHUNK_SIZE + 1);
  assert.equal(two.length, 2);
  assert.equal(two[1].contentRange, `bytes ${CHUNK_SIZE}-${CHUNK_SIZE}/${CHUNK_SIZE + 1}`);
});

test("chunkAt resumes from any offset", () => {
  const c = chunkAt(10_000_000, 3_000_000);
  assert.equal(c.offset, 3_000_000);
  assert.equal(c.length, 7_000_000 < CHUNK_SIZE ? 7_000_000 : CHUNK_SIZE);
  assert.equal(c.last, true);
});

test("invalid arguments are refused", () => {
  assert.throws(() => chunkAt(0, 0));
  assert.throws(() => chunkAt(100, 100));
  assert.throws(() => chunkAt(100, -1));
  assert.throws(() => chunkAt(1000, 0, 1000)); // not a multiple of 256 KiB
});

test("Range header: where to continue after a 308", () => {
  assert.equal(nextOffsetFromRange(undefined), 0);
  assert.equal(nextOffsetFromRange("bytes=0-262143"), 262144);
  assert.equal(nextOffsetFromRange(" bytes=0-0 "), 1);
  assert.throws(() => nextOffsetFromRange("bytes=5-9"));
});

test("status query header", () => {
  assert.equal(statusRange(1234), "bytes */1234");
});
