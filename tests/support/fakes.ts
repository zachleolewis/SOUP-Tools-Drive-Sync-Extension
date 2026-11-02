// Test doubles for the pieces of SOUP the engines use: a Transport over Node's fetch, an fs on a temp folder, an in-memory Library.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryFolder, LibraryReplay } from "soup";
import { DriveClient, type TokenSource } from "../../src/drive.ts";
import type { FsPort, LibraryPort, ProfilesPort } from "../../src/env.ts";
import type { DownloadRequest, DownloadResult, HttpRequest, HttpResponse, Transport, UploadRequest } from "../../src/transport.ts";
import type { LibrarySnapshot } from "../../src/types.ts";
import { FakeGoogle } from "./fake-google.ts";

const lower = (h: Headers) => Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]));

/** What SOUP does with requestUrl / net.upload / net.download, over real HTTP to the fake. */
export class NodeTransport implements Transport {
  calls = { request: 0, upload: 0, download: 0 };
  /** Make the next upload() reject as if the connection dropped. */
  dropNextUpload = 0;

  async request(r: HttpRequest): Promise<HttpResponse> {
    this.calls.request++;
    const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body === null || r.body === undefined || r.body === "" ? undefined : (r.body as BodyInit) });
    return { status: res.status, headers: lower(res.headers), text: await res.text() };
  }

  async upload(r: UploadRequest): Promise<HttpResponse> {
    this.calls.upload++;
    if (this.dropNextUpload > 0) {
      this.dropNextUpload--;
      throw new Error("connection reset");
    }
    const all = await readFile(r.file);
    const slice = all.subarray(r.offset, r.offset + r.length);
    const res = await fetch(r.url, { method: r.method, headers: r.headers, body: slice });
    r.onProgress?.(slice.length, slice.length);
    return { status: res.status, headers: lower(res.headers), text: await res.text() };
  }

  async download(r: DownloadRequest): Promise<DownloadResult> {
    this.calls.download++;
    const res = await fetch(r.url, { headers: r.headers });
    if (res.status < 200 || res.status >= 300) return { status: res.status, size: 0, errorText: await res.text() };
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(r.to), { recursive: true });
    await writeFile(r.to, buf);
    r.onProgress?.(buf.length, buf.length);
    return { status: res.status, size: buf.length, errorText: null };
  }
}

/** A token source backed by the fake's token endpoint. */
export class FakeTokens implements TokenSource {
  refreshes = 0;
  token = "";
  private readonly g: FakeGoogle;
  private readonly refreshToken: string;
  constructor(g: FakeGoogle, refreshToken: string) {
    this.g = g;
    this.refreshToken = refreshToken;
  }
  async getToken(): Promise<string> {
    return this.token || this.refresh();
  }
  async refresh(): Promise<string> {
    this.refreshes++;
    const res = await fetch(this.g.endpoints.tokenUrl, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.refreshToken }) });
    if (!res.ok) throw new Error("refresh failed");
    this.token = ((await res.json()) as { access_token: string }).access_token;
    return this.token;
  }
}

export interface Rig {
  g: FakeGoogle;
  transport: NodeTransport;
  tokens: FakeTokens;
  drive: DriveClient;
  sleeps: number[];
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeRig(o: { chunkSize?: number; maxTries?: number } = {}): Promise<Rig> {
  const g = await new FakeGoogle().start();
  g.refreshTokens.add("rt-test");
  const transport = new NodeTransport();
  const tokens = new FakeTokens(g, "rt-test");
  const sleeps: number[] = [];
  const drive = new DriveClient({ transport, tokens, driveUrl: g.endpoints.driveUrl, uploadUrl: g.endpoints.uploadUrl, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 100, chunkSize: o.chunkSize, maxTries: o.maxTries });
  const dir = await mkdtemp(path.join(tmpdir(), "drive-sync-test-"));
  return { g, transport, tokens, drive, sleeps, dir, cleanup: async () => (await g.stop(), await rm(dir, { recursive: true, force: true })) };
}

export const nodeFs: FsPort = {
  read: async (p) => new Uint8Array(await readFile(p)),
  readText: (p) => readFile(p, "utf8"),
  write: async (p, d) => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, d);
  },
  stat: async (p) => {
    try {
      const s = await stat(p);
      return { exists: true, isFile: s.isFile(), size: s.size, modifiedMs: s.mtimeMs };
    } catch {
      return { exists: false, isFile: false, size: 0, modifiedMs: 0 };
    }
  },
  mkdir: async (p) => void (await mkdir(p, { recursive: true })),
  remove: async (p, o) => rm(p, { recursive: !!o?.recursive, force: true }),
};

export const md5Of = (b: Buffer | Uint8Array | string) => createHash("md5").update(b).digest("hex");

/** An in-memory Library whose replays are backed by real files in `dir`. */
export class FakeLibrary implements LibraryPort {
  folders: LibraryFolder[] = [];
  replays: LibraryReplay[] = [];
  n = 0;
  imports: Array<{ paths: string[]; folderId: string | null }> = [];
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async list(): Promise<LibrarySnapshot> {
    return { root: this.dir, folders: structuredClone(this.folders), replays: structuredClone(this.replays) };
  }

  /** Add a replay with real files; returns it. */
  async addReplay(o: { id?: string; name?: string; matchId?: string | null; vrf?: Buffer; json?: Buffer; folderId?: string | null }): Promise<LibraryReplay> {
    const id = o.id ?? `r${++this.n}`;
    const vrfPath = o.vrf ? path.join(this.dir, "library", `${id}.vrf`) : null;
    const jsonPath = o.json ? path.join(this.dir, "library", `${id}.json`) : null;
    await mkdir(path.join(this.dir, "library"), { recursive: true });
    if (vrfPath) await writeFile(vrfPath, o.vrf!);
    if (jsonPath) await writeFile(jsonPath, o.json!);
    const r: LibraryReplay = {
      id,
      folderId: o.folderId ?? null,
      name: o.name ?? `Replay ${id}`,
      matchId: o.matchId === undefined ? `match-${id}` : o.matchId,
      mode: "custom",
      map: "Ascent",
      mapUrl: null,
      gameVersion: null,
      score: "13 - 7",
      agents: [],
      hasVrf: !!vrfPath,
      hasJson: !!jsonPath,
      vrfPath,
      jsonPath,
      sizeBytes: o.vrf?.length ?? o.json?.length ?? 0,
      importedAt: 1,
      startedAt: 1,
      lastPlayedAt: null,
      pinned: false,
      sortIndex: 0,
    };
    this.replays.push(r);
    return r;
  }

  async importFiles(paths: string[], folderId?: string | null) {
    this.imports.push({ paths: [...paths], folderId: folderId ?? null });
    const groups = new Map<string, string[]>();
    for (const p of paths) groups.set(path.basename(p).replace(/\.(vrf|json)$/, ""), [...(groups.get(path.basename(p).replace(/\.(vrf|json)$/, "")) ?? []), p]);
    let imported = 0;
    for (const [base, files] of groups) {
      const vrf = files.find((f) => f.endsWith(".vrf"));
      const json = files.find((f) => f.endsWith(".json"));
      const r = await this.addReplay({ id: `imp-${++this.n}`, name: base, matchId: base.replace(/^r/, "match-r"), vrf: vrf ? await readFile(vrf) : undefined, json: json ? await readFile(json) : undefined, folderId: folderId ?? null });
      void r;
      imported++;
    }
    return { imported, skipped: [] as Array<{ path: string; error: string }> };
  }

  async createFolder(name: string, parentId?: string | null, color?: string | null): Promise<LibraryFolder> {
    const f: LibraryFolder = { id: `f${++this.n}`, name, parentId: parentId ?? null, color: color ?? null, pinned: false, sortIndex: 0, createdAt: 1 };
    this.folders.push(f);
    return f;
  }

  async renameReplay(id: string, name: string): Promise<void> {
    const r = this.replays.find((x) => x.id === id);
    if (r) r.name = name;
  }
}

export class FakeProfiles implements ProfilesPort {
  imported: Array<{ path: string; name?: string; content: string }> = [];
  private readonly content: string;
  constructor(content = '{"name":"p"}') {
    this.content = content;
  }
  async exportTo(p: string): Promise<string> {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, this.content);
    return p;
  }
  async importFrom(p: string, c?: { name?: string }) {
    this.imported.push({ path: p, name: c?.name, content: await readFile(p, "utf8") });
    return { id: "new-profile", name: c?.name ?? "p" };
  }
}

/** Deterministic bytes of a given size. */
export const bytes = (n: number, seed = 1): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + (i >> 8)) & 0xff));
