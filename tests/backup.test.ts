// The backup engine end to end: a real temp folder as the Library's files, the fake Drive over real HTTP.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type BackupDeps, parseManifest, runBackup } from "../src/backup.ts";
import { BACKUP_JSON_NAME, RESUMABLE_THRESHOLD, SETTINGS_FILE_NAME } from "../src/constants.ts";
import { DAY_MS } from "../src/plan.ts";
import { DriveError } from "../src/errors.ts";
import { Md5Cache } from "../src/hashing.ts";
import type { FsPort } from "../src/env.ts";
import { FakeLibrary, FakeProfiles, type Rig, bytes, makeRig, md5Of, nodeFs } from "./support/fakes.ts";

describe("backup engine", () => {
  let rig: Rig;
  let lib: FakeLibrary;
  let libDir: string;
  let cache: Md5Cache;
  let reads: string[];
  let clock: number;
  let folders: BackupDeps["folders"];

  const countingFs: FsPort = {
    ...nodeFs,
    read: async (p) => {
      reads.push(p);
      return nodeFs.read(p);
    },
  };
  const deps = (o: Partial<BackupDeps> = {}): BackupDeps => ({
    drive: rig.drive,
    library: lib,
    fs: countingFs,
    profiles: new FakeProfiles(),
    tempDir: path.join(rig.dir, "tmp"),
    profile: { id: "p1234567-aaaa", name: "Main" },
    pcName: "Test PC",
    extensionVersion: "1.0.0",
    apiVersion: "1.0",
    cache,
    folders,
    now: () => clock,
    ...o,
  });
  const run = async (o: Partial<BackupDeps> = {}) => {
    const r = await runBackup(deps(o));
    folders = r.folders;
    return r;
  };
  const libraryFiles = () => {
    const id = folders?.library ?? rig.g.named("library")[0]?.id;
    return [...rig.g.files.values()].filter((f) => f.parents.includes(id));
  };
  const uploadsSeen = () => rig.g.requests.filter((r) => r.path.startsWith("/upload/") && (r.method === "POST" || r.method === "PATCH" || r.method === "PUT")).length;

  beforeEach(async () => {
    rig = await makeRig();
    libDir = await mkdtemp(path.join(tmpdir(), "drive-sync-lib-"));
    lib = new FakeLibrary(libDir);
    cache = new Md5Cache();
    reads = [];
    clock = 1_800_000_000_000;
    folders = undefined;
  });
  afterEach(async () => {
    await rig.cleanup();
    await rm(libDir, { recursive: true, force: true });
  });

  test("first backup: the layout, every file byte for byte, settings, and a backup.json that describes it", async () => {
    const a = await lib.addReplay({ vrf: bytes(30_000, 1), json: bytes(2_000, 2), name: "Scrim vs Ada" });
    const b = await lib.addReplay({ vrf: bytes(RESUMABLE_THRESHOLD + 1234, 3) }); // goes through the resumable path
    const r = await run();
    assert.ok(r.ok, r.message);
    assert.equal(r.uploaded, 3);

    // SOUP Sync / Backups / Main (p1234567) / library
    const root = rig.g.named("SOUP Sync")[0];
    const backups = rig.g.named("Backups")[0];
    const profile = rig.g.named("Main (p1234567)")[0];
    const library = rig.g.named("library")[0];
    assert.deepEqual([root.parents, backups.parents, profile.parents, library.parents], [["root"], [root.id], [backups.id], [profile.id]]);
    assert.equal(profile.appProperties?.soupProfileId, "p1234567-aaaa");

    const names = libraryFiles().map((f) => f.name).sort();
    assert.deepEqual(names, [`${a.id}.json`, `${a.id}.vrf`, `${b.id}.vrf`].sort());
    assert.deepEqual(rig.g.named(`${a.id}.vrf`)[0].content, bytes(30_000, 1));
    assert.deepEqual(rig.g.named(`${b.id}.vrf`)[0].content, bytes(RESUMABLE_THRESHOLD + 1234, 3));
    assert.ok(rig.g.requests.some((q) => q.method === "POST" && q.query.get("uploadType") === "resumable"), "the big one used a resumable upload");
    assert.equal(rig.g.named(SETTINGS_FILE_NAME)[0].parents[0], profile.id);

    const m = parseManifest(rig.g.named(BACKUP_JSON_NAME)[0].content!.toString())!;
    assert.equal(m.profile.name, "Main");
    assert.equal(m.pcName, "Test PC");
    assert.equal(m.createdAt, clock);
    assert.equal(m.replays.length, 2);
    const ma = m.replays.find((x) => x.id === a.id)!;
    assert.equal(ma.name, "Scrim vs Ada");
    assert.equal(ma.files.vrf!.md5, md5Of(bytes(30_000, 1)));
    assert.equal(ma.files.vrf!.driveId, rig.g.named(`${a.id}.vrf`)[0].id);
    assert.equal(m.settingsDriveId, rig.g.named(SETTINGS_FILE_NAME)[0].id);
  });

  test("a second backup with nothing changed uploads nothing and does not re-read the files", async () => {
    await lib.addReplay({ vrf: bytes(30_000, 1), json: bytes(2_000, 2) });
    await run();
    reads.length = 0;
    const filesBefore = new Map([...rig.g.files].map(([id, f]) => [id, f.content?.length]));
    const r = await run();
    assert.ok(r.ok);
    assert.equal(r.uploaded, 0);
    assert.equal(r.kept, 2);
    assert.equal(r.message, "Backed up: nothing new");
    assert.deepEqual(reads.filter((p) => p.includes("library")), [], "checksums came from the cache");
    // Only settings and backup.json were rewritten; no duplicates anywhere.
    assert.equal(rig.g.files.size, filesBefore.size);
  });

  test("a changed file is uploaded in place (same Drive id), the rest is left alone", async () => {
    const a = await lib.addReplay({ vrf: bytes(30_000, 1), json: bytes(2_000, 2) });
    await run();
    const vrfId = rig.g.named(`${a.id}.vrf`)[0].id;
    await writeFile(a.jsonPath!, bytes(2_500, 9));
    const r = await run();
    assert.equal(r.uploaded, 1);
    assert.equal(rig.g.named(`${a.id}.vrf`)[0].id, vrfId);
    assert.deepEqual(rig.g.named(`${a.id}.json`)[0].content, bytes(2_500, 9));
    assert.equal(rig.g.named(`${a.id}.json`).length, 1);
  });

  test("a replay deleted from the Library stays in the backup for 30 days, then is removed from Drive", async () => {
    const a = await lib.addReplay({ vrf: bytes(1000, 1) });
    const b = await lib.addReplay({ vrf: bytes(1000, 2) });
    await run();
    lib.replays = lib.replays.filter((r) => r.id !== b.id);

    clock += 2 * DAY_MS;
    const r1 = await run();
    assert.equal(r1.tombstones, 1);
    assert.equal(rig.g.named(`${b.id}.vrf`).length, 1, "still in Drive");
    const m1 = parseManifest(rig.g.named(BACKUP_JSON_NAME)[0].content!.toString())!;
    assert.deepEqual(m1.tombstones.map((t) => t.replay.id), [b.id]);
    assert.equal(m1.replays.length, 1);

    clock += 20 * DAY_MS; // 22 days after it was removed... removal was seen at day 2
    await run();
    assert.equal(rig.g.named(`${b.id}.vrf`).length, 1);

    clock += 11 * DAY_MS; // 31 days after the removal was noticed
    const r3 = await run();
    assert.equal(r3.tombstones, 0);
    assert.equal(r3.deleted, 1);
    assert.equal(rig.g.named(`${b.id}.vrf`).length, 0);
    assert.equal(rig.g.named(`${a.id}.vrf`).length, 1);
  });

  test("a run that dies in the middle (Drive full) writes no backup.json; the next run adopts what was uploaded and creates no duplicates", async () => {
    const a = await lib.addReplay({ vrf: bytes(1000, 1) });
    const b = await lib.addReplay({ vrf: bytes(1000, 2) });
    let uploads = 0;
    // The second upload hits "storage full".
    rig.g.fail({ match: (r) => r.method === "POST" && r.path === "/upload/drive/v3/files" && r.query.get("uploadType") === "multipart" && ++uploads === 2, status: 403, body: JSON.stringify({ error: { errors: [{ reason: "storageQuotaExceeded" }] } }) });
    await assert.rejects(run(), (e) => e instanceof DriveError && e.kind === "quota");
    assert.equal(rig.g.named(BACKUP_JSON_NAME).length, 0, "backup.json is written last, so there is none");
    assert.equal(libraryFiles().length, 1);

    const r = await run();
    assert.ok(r.ok, r.message);
    assert.equal(r.uploaded, 1, "only the missing one");
    assert.equal(r.kept, 1, "the first was adopted");
    assert.equal(rig.g.named(`${a.id}.vrf`).length, 1);
    assert.equal(rig.g.named(`${b.id}.vrf`).length, 1);
  });

  test("a file that fails on its own does not stop the others; backup.json leaves it out so the next run retries it", async () => {
    const a = await lib.addReplay({ vrf: bytes(1000, 1) });
    const b = await lib.addReplay({ vrf: bytes(1000, 2) });
    rig.g.fail({ match: (r) => r.method === "POST" && r.path === "/upload/drive/v3/files" && r.query.get("uploadType") === "multipart", status: 400, body: "{}" });
    const r = await run();
    assert.equal(r.ok, false);
    assert.equal(r.failed, 1);
    assert.equal(r.uploaded, 1);
    assert.match(r.message, /problem/);
    const m = parseManifest(rig.g.named(BACKUP_JSON_NAME)[0].content!.toString())!;
    const withFile = m.replays.filter((x) => x.files.vrf);
    assert.equal(withFile.length, 1);
    const r2 = await run();
    assert.ok(r2.ok, r2.message);
    assert.equal(r2.uploaded, 1);
    assert.equal(rig.g.named(`${a.id}.vrf`).length + rig.g.named(`${b.id}.vrf`).length, 2);
  });

  test("cancel: stops between files, still writes backup.json for what was uploaded, and the next run finishes the job", async () => {
    for (let i = 0; i < 4; i++) await lib.addReplay({ vrf: bytes(1000, i + 1) });
    const ctl = new AbortController();
    let seen = 0;
    const r = await run({
      signal: ctl.signal,
      onProgress: (p) => {
        if (p.phase === "uploading" && ++seen === 2) ctl.abort();
      },
    });
    assert.equal(r.cancelled, true);
    assert.equal(r.ok, false);
    assert.ok(r.uploaded >= 1 && r.uploaded < 4, `uploaded ${r.uploaded}`);
    const m = parseManifest(rig.g.named(BACKUP_JSON_NAME)[0].content!.toString())!;
    assert.equal(m.replays.filter((x) => x.files.vrf).length, r.uploaded);
    assert.equal(rig.g.named(SETTINGS_FILE_NAME).length, 0, "no settings export when cancelled");
    const r2 = await run();
    assert.ok(r2.ok);
    assert.equal(r2.uploaded, 4 - r.uploaded);
  });

  test("progress reports the phases and the bytes", async () => {
    await lib.addReplay({ vrf: bytes(1000, 1) });
    await lib.addReplay({ vrf: bytes(3000, 2) });
    const seen: string[] = [];
    let last = 0;
    await run({
      onProgress: (p) => {
        if (seen.at(-1) !== p.phase) seen.push(p.phase);
        if (p.phase === "uploading") last = p.bytesTotal;
      },
    });
    assert.deepEqual(seen, ["reading", "checking", "uploading", "settings", "finishing"]);
    assert.equal(last, 4000);
  });

  test("folders are remembered between runs; a trashed or deleted folder is found or made again", async () => {
    await lib.addReplay({ vrf: bytes(100, 1) });
    await run();
    const first = { ...folders! };
    const n = rig.g.files.size;
    await run();
    assert.deepEqual(folders, first);
    assert.equal(rig.g.files.size, n);
    // The person trashes the library folder in Drive: a fresh one is created and everything is uploaded again.
    rig.g.files.get(first.library!)!.trashed = true;
    const r = await run();
    assert.notEqual(folders!.library, first.library);
    assert.equal(r.uploaded, 1);
    // The cached ids are lost (new PC state): the folders are found again by name, nothing is duplicated.
    const again = await run({ folders: undefined });
    assert.deepEqual(again.folders, folders);
    assert.equal(rig.g.named("SOUP Sync").length, 1);
  });

  test("a renamed profile keeps its backup folder (found by the stored profile id)", async () => {
    await lib.addReplay({ vrf: bytes(100, 1) });
    await run();
    const f = folders!.profile;
    const r = await run({ folders: undefined, profile: { id: "p1234567-aaaa", name: "Renamed" } });
    assert.equal(r.folders.profile, f);
    assert.equal(r.uploaded, 0);
  });

  test("the backup of an empty Library still writes a valid backup.json", async () => {
    const r = await run();
    assert.ok(r.ok);
    assert.equal(parseManifest(rig.g.named(BACKUP_JSON_NAME)[0].content!.toString())!.replays.length, 0);
  });
});
