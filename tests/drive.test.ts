// The Drive client against an in-process fake Drive HTTP server (real HTTP, real sockets).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CancelError, DriveError, userMessage } from "../src/errors.ts";
import { backoffMs, qLit } from "../src/drive.ts";
import { FOLDER_MIME } from "../src/constants.ts";
import { type Rig, bytes, makeRig, md5Of } from "./support/fakes.ts";

describe("drive client", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig({ chunkSize: 256 * 1024 });
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  test("ensureFolder creates once, then finds the same folder by name and parent", async () => {
    const a = await rig.drive.ensureFolder("SOUP Sync", "root");
    const b = await rig.drive.ensureFolder("SOUP Sync", "root");
    assert.equal(a.id, b.id);
    assert.equal(rig.g.named("SOUP Sync").length, 1);
    assert.equal(a.mimeType, FOLDER_MIME);
    const child = await rig.drive.ensureFolder("Backups", a.id);
    assert.deepEqual((await rig.drive.getFile(child.id))!.parents, [a.id]);
    assert.equal((await rig.drive.findByName("Backups", "root")), null, "same name under another parent is not found");
  });

  test("names with quotes and backslashes are escaped in the query", async () => {
    assert.equal(qLit("it's a\\b"), "'it\\'s a\\\\b'");
    const f = await rig.drive.createFolder("Ada's \\ team", "root");
    assert.equal((await rig.drive.findByName("Ada's \\ team", "root"))!.id, f.id);
  });

  test("findFolderByProperty finds a profile folder by its stored profile id", async () => {
    const f = await rig.drive.createFolder("Main (abcd1234)", "root", { soupProfileId: "abcd1234-full" });
    assert.equal((await rig.drive.findFolderByProperty("root", "soupProfileId", "abcd1234-full"))!.id, f.id);
    assert.equal(await rig.drive.findFolderByProperty("root", "soupProfileId", "other"), null);
  });

  test("list follows pages", async () => {
    rig.g.pageSize = 2;
    const parent = await rig.drive.createFolder("p", "root");
    for (let i = 0; i < 5; i++) rig.g.put({ name: `f${i}`, parents: [parent.id] });
    const all = await rig.drive.listChildren(parent.id);
    assert.equal(all.length, 5);
    assert.ok(rig.g.requests.filter((r) => r.path === "/drive/v3/files" && r.query.has("pageToken")).length >= 2);
  });

  test("multipart upload creates a file with its content, then updates it in place", async () => {
    const folder = await rig.drive.createFolder("lib", "root");
    const data = bytes(50_000);
    const f = await rig.drive.uploadMultipart({ name: "a.vrf", parentId: folder.id, mimeType: "application/octet-stream", bytes: data });
    assert.equal(f.md5Checksum, md5Of(data));
    assert.equal(Number(f.size), 50_000);
    assert.deepEqual(rig.g.files.get(f.id)!.content, data);
    const data2 = bytes(777, 2);
    const g = await rig.drive.uploadMultipart({ name: "a.vrf", fileId: f.id, mimeType: "application/octet-stream", bytes: data2 });
    assert.equal(g.id, f.id);
    assert.equal(g.md5Checksum, md5Of(data2));
    assert.equal(rig.g.named("a.vrf").length, 1);
  });

  test("an empty file uploads through multipart", async () => {
    const f = await rig.drive.uploadMultipart({ name: "empty.json", parentId: "root", mimeType: "application/json", bytes: new Uint8Array(0) });
    assert.equal(f.md5Checksum, md5Of(Buffer.alloc(0)));
  });

  test("resumable upload sends 256 KiB chunks with exact Content-Range headers and ends with the full file", async () => {
    const data = bytes(256 * 1024 * 2 + 1000); // three chunks: 256K, 256K, 1000
    const file = path.join(rig.dir, "big.vrf");
    await writeFile(file, data);
    const progress: number[] = [];
    const f = await rig.drive.uploadResumable({ name: "big.vrf", parentId: "root", mimeType: "application/octet-stream", file, total: data.length, onProgress: (d) => progress.push(d) });
    assert.equal(f.md5Checksum, md5Of(data));
    const puts = rig.g.requests.filter((r) => r.path.startsWith("/upload/session/")).map((r) => r.contentRange);
    assert.deepEqual(puts, [`bytes 0-${262143}/${data.length}`, `bytes ${262144}-${524287}/${data.length}`, `bytes ${524288}-${data.length - 1}/${data.length}`]);
    assert.equal(progress.at(-1), data.length);
    assert.deepEqual(rig.g.files.get(f.id)!.content, data);
  });

  test("resumable upload resumes after a lost acknowledgement: it asks Drive how much arrived and continues from there (308)", async () => {
    const data = bytes(256 * 1024 * 3);
    const file = path.join(rig.dir, "big.vrf");
    await writeFile(file, data);
    // The second chunk is stored, but the answer is a 503: the client cannot know and must ask.
    rig.g.fail({ match: (r) => r.method === "PUT" && r.path.startsWith("/upload/session/"), status: 503, afterStore: true, times: 1 });
    // ... except the first PUT must succeed, so skip the fault once.
    const first = rig.g.faults.pop()!;
    let seen = 0;
    first.match = (r) => r.method === "PUT" && r.path.startsWith("/upload/session/") && ++seen === 2;
    rig.g.faults.push(first);
    const f = await rig.drive.uploadResumable({ name: "big.vrf", parentId: "root", mimeType: "application/octet-stream", file, total: data.length });
    assert.deepEqual(rig.g.files.get(f.id)!.content, data);
    const ranges = rig.g.requests.filter((r) => r.path.startsWith("/upload/session/")).map((r) => r.contentRange);
    assert.equal(ranges[0], `bytes 0-262143/${data.length}`);
    assert.equal(ranges[1], `bytes 262144-524287/${data.length}`);
    assert.equal(ranges[2], `bytes */${data.length}`, "status query after the failure");
    assert.equal(ranges[3], `bytes 524288-${data.length - 1}/${data.length}`, "continues after the stored chunk, nothing is sent twice");
    assert.equal(rig.g.named("big.vrf").length, 1);
    assert.ok(rig.sleeps.length >= 1, "waited before asking");
  });

  test("resumable upload: a chunk that did NOT arrive is sent again from the offset Drive reports", async () => {
    const data = bytes(256 * 1024 * 2);
    const file = path.join(rig.dir, "big.vrf");
    await writeFile(file, data);
    let seen = 0;
    rig.g.fail({ match: (r) => r.method === "PUT" && r.path.startsWith("/upload/session/") && ++seen === 2, status: 500 });
    const f = await rig.drive.uploadResumable({ name: "big.vrf", parentId: "root", mimeType: "application/octet-stream", file, total: data.length });
    assert.deepEqual(rig.g.files.get(f.id)!.content, data);
    const ranges = rig.g.requests.filter((r) => r.path.startsWith("/upload/session/")).map((r) => r.contentRange);
    assert.deepEqual(ranges, [`bytes 0-262143/${data.length}`, `bytes 262144-524287/${data.length}`, `bytes */${data.length}`, `bytes 262144-524287/${data.length}`]);
  });

  test("resumable upload survives a dropped connection mid chunk", async () => {
    const data = bytes(256 * 1024 * 2);
    const file = path.join(rig.dir, "big.vrf");
    await writeFile(file, data);
    rig.transport.dropNextUpload = 1;
    const f = await rig.drive.uploadResumable({ name: "big.vrf", parentId: "root", mimeType: "application/octet-stream", file, total: data.length });
    assert.deepEqual(rig.g.files.get(f.id)!.content, data);
  });

  test("resumable upload updates an existing file in place and can be cancelled between chunks", async () => {
    const old = rig.g.put({ name: "big.vrf", content: Buffer.from("old") });
    const data = bytes(256 * 1024 * 2);
    const file = path.join(rig.dir, "big.vrf");
    await writeFile(file, data);
    const f = await rig.drive.uploadResumable({ name: "big.vrf", fileId: old.id, mimeType: "application/octet-stream", file, total: data.length });
    assert.equal(f.id, old.id);
    assert.deepEqual(rig.g.files.get(old.id)!.content, data);

    const ctl = new AbortController();
    const chunks = rig.g.requests.length;
    await assert.rejects(
      rig.drive.uploadResumable({ name: "c.vrf", parentId: "root", mimeType: "application/octet-stream", file, total: data.length, signal: ctl.signal, onProgress: (d) => d >= 262144 && ctl.abort() }),
      (e) => e instanceof CancelError,
    );
    assert.ok(rig.g.requests.length > chunks);
  });

  test("download writes the exact bytes, and a missing file is a not-found DriveError", async () => {
    const data = bytes(100_000);
    const f = rig.g.put({ name: "x.vrf", content: data });
    const to = path.join(rig.dir, "out", "x.vrf");
    const n = await rig.drive.download(f.id, to);
    assert.equal(n, 100_000);
    const { readFile } = await import("node:fs/promises");
    assert.deepEqual(await readFile(to), data);
    await assert.rejects(rig.drive.download("nope", path.join(rig.dir, "n")), (e) => e instanceof DriveError && e.kind === "notfound");
    assert.equal(await rig.drive.readText(rig.g.put({ name: "t", content: Buffer.from("hello") }).id), "hello");
  });

  test("delete removes the file; deleting a missing one is fine", async () => {
    const f = rig.g.put({ name: "d" });
    await rig.drive.delete(f.id);
    assert.equal(rig.g.files.has(f.id), false);
    await rig.drive.delete(f.id);
  });

  test("401: refreshes the token once and repeats the request", async () => {
    await rig.drive.ensureFolder("a", "root");
    const before = rig.tokens.refreshes;
    rig.g.expireTokens();
    const f = await rig.drive.ensureFolder("b", "root");
    assert.ok(f.id);
    assert.equal(rig.tokens.refreshes, before + 1);
    assert.equal(rig.g.named("b").length, 1);
  });

  test("401 twice in a row means 'sign in again' (kind auth), and the message says so", async () => {
    await rig.drive.ensureFolder("a", "root");
    rig.g.fail({ match: () => true, status: 401, times: 5 });
    // The fault also hides the token endpoint? No: only Drive routes. So refresh works, the retry gets 401 again.
    await assert.rejects(rig.drive.getFile("x"), (e) => e instanceof DriveError && e.kind === "auth" && /Sign in again/.test(userMessage(e)));
  });

  test("429: exponential backoff 100, 200, 400 ms (base 100) then success; Retry-After wins when sent", async () => {
    rig.g.fail({ match: (r) => r.method === "POST" && r.path === "/drive/v3/files", status: 429, times: 3 });
    const f = await rig.drive.createFolder("x", "root");
    assert.ok(f.id);
    assert.deepEqual(rig.sleeps, [100, 200, 400]);
    rig.sleeps.length = 0;
    rig.g.fail({ match: (r) => r.method === "POST" && r.path === "/drive/v3/files", status: 429, headers: { "retry-after": "7" } });
    await rig.drive.createFolder("y", "root");
    assert.deepEqual(rig.sleeps, [7000]);
    assert.equal(backoffMs(null, 10, 1000), 60_000, "capped at a minute");
  });

  test("5xx is retried at most 5 times and then reported as a server problem", async () => {
    rig.g.fail({ match: (r) => r.method === "GET" && r.path === "/drive/v3/files", status: 503, times: 99 });
    await assert.rejects(rig.drive.list("trashed = false"), (e) => e instanceof DriveError && e.kind === "server");
    const tries = rig.g.requests.filter((r) => r.method === "GET" && r.path === "/drive/v3/files").length;
    assert.equal(tries, 5);
    assert.equal(rig.sleeps.length, 4);
  });

  test("403 storageQuotaExceeded is 'Your Google Drive is full' and is not retried", async () => {
    rig.g.quotaFull = true;
    await assert.rejects(rig.drive.uploadMultipart({ name: "a", parentId: "root", mimeType: "application/json", bytes: bytes(10) }), (e) => e instanceof DriveError && e.kind === "quota" && userMessage(e) === "Your Google Drive is full.");
    assert.equal(rig.sleeps.length, 0);
  });

  test("a rate-limit 403 is retried like a 429; any other 403 is 'forbidden' at once", async () => {
    rig.g.fail({ match: (r) => r.method === "POST" && r.path === "/drive/v3/files", status: 403, body: JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }) });
    await rig.drive.createFolder("x", "root");
    assert.equal(rig.sleeps.length, 1);
    rig.g.fail({ match: (r) => r.method === "POST" && r.path === "/drive/v3/files", status: 403, body: JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } }) });
    await assert.rejects(rig.drive.createFolder("y", "root"), (e) => e instanceof DriveError && e.kind === "forbidden");
  });

  test("a request that never reaches Google is 'offline' after the tries", async () => {
    await rig.drive.getFile("warm-up-the-token");
    await rig.g.stop();
    await assert.rejects(rig.drive.getFile("x"), (e) => e instanceof DriveError && e.kind === "offline");
    // cleanup() stops again; make that harmless
    rig.g.stop = async () => undefined;
  });

  test("tokens never appear in an error message", async () => {
    rig.g.quotaFull = true;
    try {
      await rig.drive.uploadMultipart({ name: "a", parentId: "root", mimeType: "application/json", bytes: bytes(10) });
    } catch (e) {
      assert.ok(!String((e as Error).message).includes(rig.tokens.token));
    }
  });
});
