import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { LibraryFolder, LibraryReplay } from "soup";
import { runBackup } from "../src/backup.ts";
import { Md5Cache } from "../src/hashing.ts";
import { listBackups, previewRestore, runRestore, type BackupSummary } from "../src/restore.ts";
import { hashCandidates, orderFolders, pairImported, planRestore } from "../src/restore-plan.ts";
import type { BackupManifest, BackupReplay } from "../src/types.ts";
import { FakeLibrary, FakeProfiles, type Rig, bytes, makeRig, md5Of, nodeFs } from "./support/fakes.ts";

// ------------------------------------------------------------------ pure plan

const folder = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId, color: null, pinned: false });
const lfolder = (id: string, name: string, parentId: string | null = null): LibraryFolder => ({ id, name, parentId, color: null, pinned: false, sortIndex: 0, createdAt: 1 });
const brep = (id: string, o: Partial<BackupReplay> = {}): BackupReplay => ({ id, name: `R ${id}`, matchId: `m-${id}`, folderId: null, pinned: false, mode: null, map: null, score: null, startedAt: null, files: { vrf: { size: 100 + id.length, md5: `md5-${id}`, driveId: `D-${id}` } }, ...o });
const manifest = (replays: BackupReplay[], folders: BackupManifest["folders"] = []): BackupManifest => ({ format: 1, createdAt: 1, extensionVersion: "1.0.0", apiVersion: "1.0", pcName: "PC", profile: { id: "p1", name: "Main" }, folders, replays, tombstones: [], settingsDriveId: null });
const lrep = (id: string, o: Partial<LibraryReplay> = {}): LibraryReplay => ({ id, folderId: null, name: id, matchId: null, sizeBytes: 1, ...o }) as LibraryReplay;

describe("restore plan", () => {
  test("folders are ordered parents first, even when listed children first, and a cycle cannot loop", () => {
    const o = orderFolders([folder("c", "C", "b"), folder("b", "B", "a"), folder("a", "A")]);
    assert.deepEqual(o.map((f) => f.id), ["a", "b", "c"]);
    assert.equal(orderFolders([folder("x", "X", "y"), folder("y", "Y", "x")]).length, 2);
  });

  test("folders are recreated; ones that exist under the same parent by name are reused, not duplicated", () => {
    const m = manifest([], [folder("f1", "Scrims"), folder("f2", "Week 1", "f1"), folder("f3", "Other")]);
    const p = planRestore({ backup: m, localFolders: [lfolder("L1", "Scrims"), lfolder("L9", "Week 1", "not-scrims")], localReplays: [], localMd5: new Set() });
    const by = Object.fromEntries(p.folders.map((f) => [f.backupId, f]));
    assert.equal(by.f1.existingLocalId, "L1");
    assert.equal(by.f2.existingLocalId, null, "a 'Week 1' under another parent is not the same folder");
    assert.equal(by.f3.existingLocalId, null);
    assert.equal(by.f2.parentBackupId, "f1");
  });

  test("a child of a folder that has to be created is created too, even if a same-named folder exists elsewhere", () => {
    const m = manifest([], [folder("f1", "New"), folder("f2", "Sub", "f1")]);
    const p = planRestore({ backup: m, localFolders: [lfolder("L2", "Sub", null)], localReplays: [], localMd5: new Set() });
    assert.equal(p.folders.find((f) => f.backupId === "f2")!.existingLocalId, null);
  });

  test("replays already in the Library are skipped: same match id, or same file md5", () => {
    const m = manifest([brep("a"), brep("b"), brep("c"), brep("d", { matchId: null })]);
    const p = planRestore({ backup: m, localFolders: [], localReplays: [lrep("x", { matchId: "m-a" })], localMd5: new Set(["md5-c"]) });
    assert.deepEqual(p.toRestore.map((i) => i.replay.id), ["b", "d"]);
    assert.deepEqual(p.skipped.map((s) => [s.replay.id, s.why]), [["a", "same match"], ["c", "same file"]]);
    assert.equal(p.bytes, p.toRestore.reduce((s, i) => s + i.files.reduce((t, f) => t + f.size, 0), 0));
  });

  test("two backup replays of one match restore once; replays without files are only reported", () => {
    const m = manifest([brep("a", { matchId: "same" }), brep("b", { matchId: "same" }), brep("c", { files: {} })]);
    const p = planRestore({ backup: m, localFolders: [], localReplays: [], localMd5: new Set() });
    assert.deepEqual(p.toRestore.map((i) => i.replay.id), ["a"]);
    assert.deepEqual(p.withoutFiles.map((r) => r.id), ["c"]);
  });

  test("only local files with a matching size need hashing", () => {
    const m = manifest([brep("a")]);
    const size = m.replays[0].files.vrf!.size;
    const c = hashCandidates(m, [
      { replayId: "x", kind: "vrf", path: "x.vrf", size },
      { replayId: "y", kind: "vrf", path: "y.vrf", size: size + 1 },
      { replayId: "z", kind: "json", path: "z.json", size },
    ]);
    assert.deepEqual(c.map((x) => x.replayId), ["x"]);
  });

  test("imported replays are matched to backup replays by match id, then by size in the target folder", () => {
    const items = planRestore({ backup: manifest([brep("a"), brep("b", { matchId: null })]), localFolders: [], localReplays: [], localMd5: new Set() }).toRestore;
    const before = [lrep("old")];
    const after = [lrep("old"), lrep("n1", { matchId: "m-a" }), lrep("n2", { matchId: null, sizeBytes: items[1].files[0].size })];
    const pairs = pairImported(items, null, before, after);
    assert.equal(pairs.get("a"), "n1");
    assert.equal(pairs.get("b"), "n2");
  });
});

// ------------------------------------------------------------------ engine

describe("restore engine", () => {
  let rig: Rig;
  let libA: FakeLibrary;
  let libB: FakeLibrary;
  let dirs: string[];
  const mk = async () => {
    const d = await mkdtemp(path.join(tmpdir(), "drive-sync-lib-"));
    dirs.push(d);
    return d;
  };

  const backupA = async () => {
    const r = await runBackup({ drive: rig.drive, library: libA, fs: nodeFs, profiles: new FakeProfiles('{"modules":"on"}'), tempDir: path.join(rig.dir, "tmpA"), profile: { id: "p1234567-aaaa", name: "Main" }, pcName: "Desk", extensionVersion: "1.0.0", apiVersion: "1.0", cache: new Md5Cache(), now: () => 1_800_000_000_000 });
    assert.ok(r.ok, r.message);
  };
  const deps = (lib: FakeLibrary, o: Partial<Parameters<typeof runRestore>[0]> = {}) => ({ drive: rig.drive, library: lib, fs: nodeFs, profiles: new FakeProfiles(), tempDir: path.join(rig.dir, "tmpB"), settings: false, ...o });
  const pick = async (): Promise<BackupSummary> => {
    const l = await listBackups(rig.drive);
    assert.equal(l.length, 1);
    return l[0];
  };

  beforeEach(async () => {
    rig = await makeRig();
    dirs = [];
    libA = new FakeLibrary(await mk());
    libB = new FakeLibrary(await mk());
    const scrims = await libA.createFolder("Scrims", null, "#ff0000");
    const week = await libA.createFolder("Week 1", scrims.id);
    await libA.addReplay({ id: "r1", name: "Ascent vs Ada", vrf: bytes(20_000, 1), json: bytes(900, 2), folderId: week.id });
    await libA.addReplay({ id: "r2", name: "Bind practice", vrf: bytes(15_000, 3), json: bytes(700, 4), folderId: null });
    await libA.addReplay({ id: "r3", name: "Split", vrf: bytes(12_000, 5), folderId: scrims.id });
    await backupA();
  });
  afterEach(async () => {
    await rig.cleanup();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("listBackups shows profile, PC, time, count and size", async () => {
    const b = await pick();
    assert.equal(b.profileName, "Main");
    assert.equal(b.pcName, "Desk");
    assert.equal(b.createdAt, 1_800_000_000_000);
    assert.equal(b.replayCount, 3);
    assert.equal(b.bytes, 20_000 + 900 + 15_000 + 700 + 12_000);
    assert.ok(b.settingsDriveId);
  });

  test("listBackups is empty when nothing was ever backed up", async () => {
    for (const f of [...rig.g.files.keys()]) rig.g.files.delete(f);
    assert.deepEqual(await listBackups(rig.drive), []);
  });

  test("restore into an empty Library: folders recreated with their parents and colours, files imported into the right folder, names restored", async () => {
    const r = await runRestore(deps(libB), await pick());
    assert.ok(r.ok, r.errors.join("; "));
    assert.equal(r.restored, 3);
    assert.equal(r.foldersCreated, 2);
    const scrims = libB.folders.find((f) => f.name === "Scrims")!;
    const week = libB.folders.find((f) => f.name === "Week 1")!;
    assert.equal(week.parentId, scrims.id);
    assert.equal(scrims.color, "#ff0000");
    const byName = Object.fromEntries(libB.replays.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(byName).sort(), ["Ascent vs Ada", "Bind practice", "Split"]);
    assert.equal(byName["Ascent vs Ada"].folderId, week.id);
    assert.equal(byName["Split"].folderId, scrims.id);
    assert.equal(byName["Bind practice"].folderId, null);
    // Content is identical (md5 of what the "Library" holds now).
    const { readFile } = await import("node:fs/promises");
    assert.equal(md5Of(await readFile(byName["Ascent vs Ada"].vrfPath!)), md5Of(bytes(20_000, 1)));
    assert.equal(md5Of(await readFile(byName["Ascent vs Ada"].jsonPath!)), md5Of(bytes(900, 2)));
    // importFiles was used once per target folder with vrf+json together, and the temp downloads are gone.
    assert.equal(libB.imports.length, 3);
    assert.ok(libB.imports.some((i) => i.paths.length === 2));
    const { stat } = await import("node:fs/promises");
    await assert.rejects(stat(path.join(rig.dir, "tmpB", "drive-sync", "restore", "r1.vrf")));
  });

  test("restoring again changes nothing: every replay is already there (same match id)", async () => {
    await runRestore(deps(libB), await pick());
    const n = libB.replays.length;
    const r = await runRestore(deps(libB), await pick());
    assert.equal(r.restored, 0);
    assert.equal(r.skipped, 3);
    assert.equal(libB.replays.length, n);
    assert.equal(libB.folders.length, 2, "no extra folders");
  });

  test("a replay with the same file but a different match id is skipped by md5 (restoring onto the PC that made the backup)", async () => {
    const r = await runRestore(deps(libA), await pick());
    assert.equal(r.restored, 0);
    assert.equal(r.skipped, 3);
    // Same files, but the Library lost the match ids:
    for (const x of libA.replays) x.matchId = null;
    const r2 = await runRestore(deps(libA), await pick());
    assert.equal(r2.skipped, 3, "recognised by checksum");
    assert.equal(libA.imports.length, 0);
  });

  test("an existing folder with the same name is used, not duplicated", async () => {
    const existing = await libB.createFolder("Scrims");
    await runRestore(deps(libB), await pick());
    assert.equal(libB.folders.filter((f) => f.name === "Scrims").length, 1);
    assert.equal(libB.replays.find((x) => x.name === "Split")!.folderId, existing.id);
  });

  test("a download that does not match its checksum fails that replay only", async () => {
    const b = await pick();
    const victim = b.manifest.replays.find((r) => r.id === "r2")!.files.vrf!.driveId;
    rig.g.files.get(victim)!.content = Buffer.from("corrupted");
    const r = await runRestore(deps(libB), b);
    assert.equal(r.ok, false);
    assert.equal(r.failed, 1);
    assert.equal(r.restored, 2);
    assert.match(r.errors[0], /Bind practice.*checksum/);
    assert.ok(!libB.replays.some((x) => x.name === "Bind practice"));
  });

  test("settings come back as a NEW profile only when asked", async () => {
    const p1 = new FakeProfiles();
    await runRestore(deps(libB, { profiles: p1, settings: false }), await pick());
    assert.equal(p1.imported.length, 0);
    const p2 = new FakeProfiles();
    const r = await runRestore(deps(libB, { profiles: p2, settings: true }), await pick());
    assert.equal(p2.imported.length, 1);
    assert.equal(p2.imported[0].name, "Main (restored)");
    assert.equal(p2.imported[0].content, '{"modules":"on"}');
    assert.equal(r.settingsProfile, "Main (restored)");
  });

  test("preview describes the restore without touching the Library", async () => {
    const p = await previewRestore({ library: libB, fs: nodeFs }, await pick());
    assert.equal(p.toRestore.length, 3);
    assert.equal(p.folders.filter((f) => !f.existingLocalId).length, 2);
    assert.equal(libB.folders.length + libB.replays.length + libB.imports.length, 0);
  });

  test("cancel stops the restore between replays and reports what was restored", async () => {
    const ctl = new AbortController();
    let n = 0;
    const r = await runRestore(deps(libB, { signal: ctl.signal, onProgress: (p) => p.phase === "Restoring" && ++n === 2 && ctl.abort() }), await pick());
    assert.equal(r.cancelled, true);
    assert.ok(r.restored < 3);
  });
});
