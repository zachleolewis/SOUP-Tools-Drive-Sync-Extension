import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryFolder, LibraryReplay } from "soup";
import { DAY_MS, applyFailed, applyUploaded, planBackup, type PlanInput } from "../src/plan.ts";
import type { BackupManifest, BackupReplay, LocalFile, RemoteFile } from "../src/types.ts";

const NOW = 1_800_000_000_000;

const replay = (id: string, extra: Partial<LibraryReplay> = {}): LibraryReplay =>
  ({ id, folderId: null, name: `Replay ${id}`, matchId: `m-${id}`, mode: "custom", map: "Ascent", mapUrl: null, gameVersion: null, score: "13 - 7", agents: [], hasVrf: true, hasJson: true, vrfPath: `C:/lib/${id}.vrf`, jsonPath: `C:/lib/${id}.json`, sizeBytes: 10, importedAt: 1, startedAt: 1, lastPlayedAt: null, pinned: false, sortIndex: 0, ...extra }) as LibraryReplay;
const folder = (id: string, name: string, parentId: string | null = null): LibraryFolder => ({ id, name, parentId, color: null, pinned: false, sortIndex: 0, createdAt: 1 });
const lf = (id: string, kind: "vrf" | "json", md5: string, size = 100): LocalFile => ({ replayId: id, kind, path: `C:/lib/${id}.${kind}`, size, md5 });
const remote = (...f: Array<[string, string, string]>): Map<string, RemoteFile> => new Map(f.map(([name, id, md5]) => [name, { id, name, size: 100, md5 }]));

function input(o: Partial<PlanInput> & Pick<PlanInput, "replays" | "local">): PlanInput {
  return { folders: [], previous: null, remote: null, now: NOW, profile: { id: "p1", name: "Main" }, pcName: "PC", extensionVersion: "1.0.0", apiVersion: "1.0", ...o };
}

const prevReplay = (id: string, files: BackupReplay["files"]): BackupReplay => ({ id, name: `Replay ${id}`, matchId: `m-${id}`, folderId: null, pinned: false, mode: null, map: null, score: null, startedAt: null, files });
const manifest = (replays: BackupReplay[], tombstones: BackupManifest["tombstones"] = []): BackupManifest => ({ format: 1, createdAt: NOW - DAY_MS, extensionVersion: "1.0.0", apiVersion: "1.0", pcName: "PC", profile: { id: "p1", name: "Main" }, folders: [], replays, tombstones, settingsDriveId: "settings-1" });

test("a first backup uploads every file and keeps nothing", () => {
  const p = planBackup(input({ replays: [replay("a"), replay("b", { jsonPath: null, hasJson: false })], local: [lf("a", "vrf", "m1"), lf("a", "json", "m2"), lf("b", "vrf", "m3")] }));
  assert.deepEqual(p.uploads.map((u) => u.name).sort(), ["a.json", "a.vrf", "b.vrf"]);
  assert.ok(p.uploads.every((u) => u.reason === "new" && !u.driveId));
  assert.equal(p.keep.length, 0);
  assert.equal(p.stats.newFiles, 3);
  assert.equal(p.stats.bytesToUpload, 300);
  assert.equal(p.manifest.replays.length, 2);
  assert.equal(p.manifest.tombstones.length, 0);
});

test("unchanged files (same md5 and size as the last backup.json) are kept, changed ones are updated in place", () => {
  const prev = manifest([prevReplay("a", { vrf: { size: 100, md5: "m1", driveId: "D1" }, json: { size: 100, md5: "m2", driveId: "D2" } })]);
  const p = planBackup(input({ replays: [replay("a")], local: [lf("a", "vrf", "m1"), lf("a", "json", "CHANGED")], previous: prev }));
  assert.deepEqual(p.keep, [{ replayId: "a", kind: "vrf", driveId: "D1" }]);
  assert.equal(p.uploads.length, 1);
  assert.equal(p.uploads[0].name, "a.json");
  assert.equal(p.uploads[0].driveId, "D2", "updates the existing Drive file");
  assert.equal(p.uploads[0].reason, "changed");
  assert.equal(p.manifest.replays[0].files.vrf!.driveId, "D1");
});

test("same md5 but a different size is a change", () => {
  const prev = manifest([prevReplay("a", { vrf: { size: 100, md5: "m1", driveId: "D1" } })]);
  const p = planBackup(input({ replays: [replay("a", { jsonPath: null })], local: [lf("a", "vrf", "m1", 101)], previous: prev }));
  assert.equal(p.uploads.length, 1);
});

test("with Drive's listing: a file a crashed run uploaded is adopted, not uploaded twice", () => {
  const p = planBackup(input({ replays: [replay("a", { jsonPath: null })], local: [lf("a", "vrf", "m1")], previous: null, remote: remote(["a.vrf", "D9", "m1"]) }));
  assert.equal(p.uploads.length, 0);
  assert.deepEqual(p.keep, [{ replayId: "a", kind: "vrf", driveId: "D9" }]);
  assert.equal(p.manifest.replays[0].files.vrf!.driveId, "D9");
});

test("with Drive's listing: a file whose Drive copy differs is updated; one deleted from Drive is uploaded again", () => {
  const prev = manifest([prevReplay("a", { vrf: { size: 100, md5: "m1", driveId: "D1" }, json: { size: 100, md5: "m2", driveId: "D2" } })]);
  const p = planBackup(input({ replays: [replay("a")], local: [lf("a", "vrf", "m1"), lf("a", "json", "m2")], previous: prev, remote: remote(["a.vrf", "D1", "OTHER"]) }));
  const byName = Object.fromEntries(p.uploads.map((u) => [u.name, u]));
  assert.equal(byName["a.vrf"].driveId, "D1");
  assert.equal(byName["a.vrf"].reason, "changed");
  assert.equal(byName["a.json"].driveId, undefined, "the old id is gone, a new file is created");
  assert.equal(byName["a.json"].reason, "missing-remotely");
});

test("a replay removed from the Library becomes a tombstone, its files stay in Drive and in backup.json", () => {
  const prev = manifest([prevReplay("a", { vrf: { size: 1, md5: "m1", driveId: "D1" } }), prevReplay("b", { vrf: { size: 1, md5: "m2", driveId: "D2" } })]);
  const p = planBackup(input({ replays: [replay("a", { jsonPath: null })], local: [lf("a", "vrf", "m1", 1)], previous: prev }));
  assert.equal(p.manifest.replays.length, 1);
  assert.equal(p.manifest.tombstones.length, 1);
  assert.equal(p.manifest.tombstones[0].replay.id, "b");
  assert.equal(p.manifest.tombstones[0].removedAt, NOW);
  assert.deepEqual(p.deleteDriveIds, [], "nothing is deleted from Drive yet");
  assert.equal(p.stats.newTombstones, 1);
});

test("a tombstone keeps its original date and is deleted only after 30 days", () => {
  const young = { removedAt: NOW - 29 * DAY_MS, replay: prevReplay("y", { vrf: { size: 1, md5: "m", driveId: "DY" } }) };
  const old = { removedAt: NOW - 30 * DAY_MS, replay: prevReplay("o", { vrf: { size: 1, md5: "m", driveId: "DO1" }, json: { size: 1, md5: "m", driveId: "DO2" } }) };
  const p = planBackup(input({ replays: [], local: [], previous: manifest([], [young, old]) }));
  assert.deepEqual(p.manifest.tombstones.map((t) => t.replay.id), ["y"]);
  assert.equal(p.manifest.tombstones[0].removedAt, young.removedAt);
  assert.deepEqual(p.deleteDriveIds.sort(), ["DO1", "DO2"]);
  assert.equal(p.stats.expiredTombstones, 1);
});

test("a replay that comes back within 30 days leaves the tombstones and is not re-uploaded when unchanged", () => {
  const t = { removedAt: NOW - 5 * DAY_MS, replay: prevReplay("a", { vrf: { size: 100, md5: "m1", driveId: "D1" } }) };
  const p = planBackup(input({ replays: [replay("a", { jsonPath: null })], local: [lf("a", "vrf", "m1")], previous: manifest([], [t]), remote: remote(["a.vrf", "D1", "m1"]) }));
  assert.equal(p.manifest.tombstones.length, 0);
  assert.equal(p.uploads.length, 0);
  assert.equal(p.manifest.replays[0].files.vrf!.driveId, "D1");
});

test("a file that is gone locally but was backed up is dropped from the backup and from Drive", () => {
  const prev = manifest([prevReplay("a", { vrf: { size: 100, md5: "m1", driveId: "D1" }, json: { size: 100, md5: "m2", driveId: "D2" } })]);
  const p = planBackup(input({ replays: [replay("a", { jsonPath: null })], local: [lf("a", "vrf", "m1")], previous: prev }));
  assert.deepEqual(p.deleteDriveIds, ["D2"]);
  assert.equal(p.manifest.replays[0].files.json, undefined);
});

test("applyUploaded fills the new Drive id; applyFailed goes back to the old entry, or leaves the file out so the next run retries", () => {
  const prev = manifest([prevReplay("a", { json: { size: 100, md5: "old", driveId: "D2" } })]);
  const p = planBackup(input({ replays: [replay("a")], local: [lf("a", "vrf", "m1"), lf("a", "json", "m2")], previous: prev }));
  const vrf = p.uploads.find((u) => u.kind === "vrf")!;
  const json = p.uploads.find((u) => u.kind === "json")!;
  applyUploaded(p, vrf, "NEW");
  applyFailed(p, json);
  assert.equal(p.manifest.replays[0].files.vrf!.driveId, "NEW");
  assert.equal(p.manifest.replays[0].files.json!.md5, "old", "back to what the last backup knew");

  const p2 = planBackup(input({ replays: [replay("a", { jsonPath: null })], local: [lf("a", "vrf", "m1")] }));
  applyFailed(p2, p2.uploads[0]);
  assert.equal(p2.manifest.replays[0].files.vrf, undefined);
});

test("folders and profile are written into the manifest", () => {
  const p = planBackup(input({ replays: [], local: [], folders: [folder("f1", "Scrims"), folder("f2", "Week 1", "f1")] }));
  assert.deepEqual(p.manifest.folders.map((f) => [f.id, f.name, f.parentId]), [["f1", "Scrims", null], ["f2", "Week 1", "f1"]]);
  assert.deepEqual(p.manifest.profile, { id: "p1", name: "Main" });
  assert.equal(p.manifest.format, 1);
});

// ---- What to back up

const both = (id: string, a: string, b: string) => prevReplay(id, { vrf: { size: 100, md5: a, driveId: `${id}-v` }, json: { size: 100, md5: b, driveId: `${id}-j` } });
const opts = (o: Partial<import("../src/state.ts").BackupOptions>) => ({ vrf: true, json: true, settings: true, excludedFolders: [], ...o });

test("an excluded folder leaves its replays and the folders below it out of a first backup", () => {
  const p = planBackup(
    input({
      folders: [folder("f1", "Scrims"), folder("f2", "Week 1", "f1"), folder("f3", "Keep")],
      replays: [replay("a", { folderId: "f2" }), replay("b", { folderId: "f3" }), replay("c")],
      local: [lf("a", "vrf", "ma"), lf("b", "vrf", "mb"), lf("c", "vrf", "mc")],
      options: opts({ excludedFolders: ["f1"] }),
    }),
  );
  assert.deepEqual(p.uploads.map((u) => u.name).sort(), ["b.vrf", "c.vrf"]);
  assert.deepEqual(p.manifest.folders.map((f) => f.id), ["f3"]);
  assert.deepEqual(p.manifest.replays.map((r) => r.id).sort(), ["b", "c"]);
});

test("a folder left out later: its replays become tombstones, their files stay in Drive, nothing is uploaded", () => {
  const prev = manifest([both("a", "ma", "na"), both("b", "mb", "nb")]);
  const p = planBackup(
    input({
      folders: [folder("f1", "Scrims")],
      replays: [replay("a", { folderId: "f1" }), replay("b")],
      local: [lf("a", "vrf", "ma"), lf("a", "json", "na"), lf("b", "vrf", "mb"), lf("b", "json", "nb")],
      previous: prev,
      options: opts({ excludedFolders: ["f1"] }),
    }),
  );
  assert.equal(p.uploads.length, 0);
  assert.deepEqual(p.manifest.replays.map((r) => r.id), ["b"]);
  assert.deepEqual(p.manifest.tombstones.map((t) => [t.replay.id, t.removedAt, Object.keys(t.replay.files).sort()]), [["a", NOW, ["json", "vrf"]]]);
  assert.deepEqual(p.deleteDriveIds, [], "nothing is deleted from Drive now");
  assert.equal(p.stats.newTombstones, 1);
});

test("switching a kind of file off tombstones just that kind; switching it back on adopts the file again without uploading", () => {
  const prev = manifest([both("a", "ma", "na")]);
  const local = [lf("a", "vrf", "ma"), lf("a", "json", "na")];
  const off = planBackup(input({ replays: [replay("a")], local, previous: prev, options: opts({ json: false }) }));
  assert.equal(off.uploads.length, 0);
  assert.deepEqual(Object.keys(off.manifest.replays[0].files), ["vrf"]);
  assert.deepEqual(off.manifest.tombstones.map((t) => [t.replay.id, Object.keys(t.replay.files)]), [["a", ["json"]]]);
  assert.deepEqual(off.deleteDriveIds, []);
  // ...and on again: the tombstone goes, the file is the same one in Drive.
  const on = planBackup(input({ replays: [replay("a")], local, previous: off.manifest, remote: remote(["a.vrf", "a-v", "ma"], ["a.json", "a-j", "na"]) }));
  assert.equal(on.uploads.length, 0);
  assert.equal(on.manifest.tombstones.length, 0);
  assert.deepEqual(Object.keys(on.manifest.replays[0].files).sort(), ["json", "vrf"]);
  assert.deepEqual(on.deleteDriveIds, []);
});

test("a kind of file left out is deleted from Drive only after 30 days, and a file that is wanted again is never deleted", () => {
  const t = { removedAt: NOW - 30 * DAY_MS, replay: prevReplay("a", { json: { size: 100, md5: "na", driveId: "a-j" } }) };
  const gone = planBackup(input({ replays: [replay("a")], local: [lf("a", "vrf", "ma")], previous: manifest([prevReplay("a", { vrf: { size: 100, md5: "ma", driveId: "a-v" } })], [t]), options: opts({ json: false }) }));
  assert.deepEqual(gone.deleteDriveIds, ["a-j"]);
  assert.equal(gone.manifest.tombstones.length, 0);
  const wanted = planBackup(input({ replays: [replay("a")], local: [lf("a", "vrf", "ma"), lf("a", "json", "na")], previous: manifest([prevReplay("a", { vrf: { size: 100, md5: "ma", driveId: "a-v" } })], [t]), remote: remote(["a.vrf", "a-v", "ma"], ["a.json", "a-j", "na"]) }));
  assert.deepEqual(wanted.deleteDriveIds, []);
});

test("settings.soupprofile switched off is kept for 30 days, then deleted; switched on again it is updated in place", () => {
  const prev = { ...manifest([]), settingsDriveId: "S1" };
  const off = planBackup(input({ replays: [], local: [], previous: prev, options: opts({ settings: false }) }));
  assert.equal(off.manifest.settingsDriveId, null);
  assert.deepEqual(off.manifest.settingsTombstone, { removedAt: NOW, driveId: "S1" });
  assert.deepEqual(off.deleteDriveIds, []);
  const later = planBackup(input({ replays: [], local: [], previous: off.manifest, now: NOW + 29 * DAY_MS, options: opts({ settings: false }) }));
  assert.equal(later.manifest.settingsTombstone?.removedAt, NOW, "keeps its date");
  assert.deepEqual(later.deleteDriveIds, []);
  const expired = planBackup(input({ replays: [], local: [], previous: off.manifest, now: NOW + 30 * DAY_MS, options: opts({ settings: false }) }));
  assert.deepEqual(expired.deleteDriveIds, ["S1"]);
  assert.equal(expired.manifest.settingsTombstone, null);
  const on = planBackup(input({ replays: [], local: [], previous: off.manifest, now: NOW + DAY_MS }));
  assert.equal(on.manifest.settingsTombstone, null);
});

test("a new folder is included by default, and so is a replay moved out of an excluded folder", () => {
  const p = planBackup(input({ folders: [folder("f1", "Out"), folder("new", "New")], replays: [replay("a", { folderId: "new" }), replay("b", { folderId: null })], local: [lf("a", "vrf", "ma"), lf("b", "vrf", "mb")], options: opts({ excludedFolders: ["f1"] }) }));
  assert.deepEqual(p.uploads.map((u) => u.name).sort(), ["a.vrf", "b.vrf"]);
  assert.deepEqual(p.manifest.folders.map((f) => f.id), ["new"]);
});
