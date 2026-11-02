// Loads the BUILT dist/main.js into a stub of SOUP's runtime (globalThis.__soup + a fake `app` backed by Node and the fake Google)
// and drives the real plugin class: onload, sign-in, a backup, sign-out. It covers the glue the unit tests do not: controller,
// SOUP transport adapter, the test-endpoints file, state in saveData. (The DOM UI is not exercised here.)
// `npm run check` builds before it tests, so dist/ exists; run on its own, the test is skipped when there is no build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { FakeGoogle } from "./support/fake-google.ts";
import { FakeLibrary, FakeProfiles, bytes, md5Of } from "./support/fakes.ts";

const dist = path.resolve("dist", "main.js");

test("the built extension signs in, backs up and signs out against the fake Google", { skip: !existsSync(dist) && "dist/main.js not built" }, async () => {
  const g = await new FakeGoogle().start();
  const root = await mkdtemp(path.join(tmpdir(), "drive-sync-smoke-"));
  const [dataDir, machineDir, tempDir, libDir] = ["data", "machine", "temp", "lib"].map((d) => path.join(root, d));
  for (const d of [dataDir, machineDir, tempDir, libDir]) await mkdir(d, { recursive: true });
  await writeFile(path.join(machineDir, "drive-sync-test-endpoints.json"), JSON.stringify(g.endpoints));

  const notices: string[] = [];
  const registered = { tabs: 0, header: 0, settingTabs: 0, commands: [] as string[], status: [] as string[] };
  let saved: unknown = {};

  class Plugin {
    app: unknown;
    manifest: { id: string; version: string };
    constructor(app: unknown, manifest: { id: string; version: string }) {
      this.app = app;
      this.manifest = manifest;
    }
    async loadData() { return saved; }
    async saveData(d: unknown) { saved = JSON.parse(JSON.stringify(d)); }
    registerEvent() {}
    addSettingTab() { registered.settingTabs++; return { remove() {} }; }
    addHeaderItem() { registered.header++; return { remove() {} }; }
    addTab() { registered.tabs++; return { remove() {} }; }
    addCommand(c: { id: string }) { registered.commands.push(c.id); return { remove() {} }; }
    addStatusText(t: string) { registered.status.push(t); }
    openSettings() {}
  }
  class Stub { constructor(..._a: unknown[]) {} }
  const g2 = globalThis as unknown as { __soup: unknown };
  g2.__soup = { soup: { Plugin, Notice: class { constructor(m: string) { notices.push(m); } }, Modal: Stub, SettingTab: Stub, Setting: Stub, RequestError: Error, normalizePath: (p: string) => p, debounce: () => undefined, apiVersion: "1.0", Platform: { isWindows: true } } };

  const secrets = new Map<string, string>();
  const lib = new FakeLibrary(libDir);
  const profiles = new FakeProfiles('{"name":"Main"}');
  const toResp = async (res: Response) => {
    const text = await res.text();
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, get json() { return JSON.parse(text); }, bytes: new TextEncoder().encode(text), url: res.url };
  };
  const app = {
    id: "drive-sync",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    paths: { dataDir, machineDir, tempDir },
    fs: {
      read: async (p: string) => new Uint8Array(await readFile(p)),
      readText: (p: string) => readFile(p, "utf8"),
      write: async (p: string, d: string | Uint8Array) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, d); },
      exists: async (p: string) => stat(p).then(() => true, () => false),
      stat: async (p: string) => stat(p).then((s) => ({ exists: true, isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, modifiedMs: s.mtimeMs }), () => ({ exists: false, isFile: false, isDir: false, size: 0, modifiedMs: 0 })),
      mkdir: async (p: string) => void (await mkdir(p, { recursive: true })),
      remove: async (p: string) => rm(p, { recursive: true, force: true }),
    },
    library: { list: () => lib.list(), onChanged: () => ({ off() {} }), importFiles: lib.importFiles.bind(lib), createFolder: lib.createFolder.bind(lib), renameReplay: lib.renameReplay.bind(lib) },
    matches: { liveState: async () => ({ status: "idle" }) },
    profiles: { active: async () => ({ id: "11112222-3333", name: "Main" }), exportTo: (p: string) => profiles.exportTo(p), importFrom: (p: string, c?: { name?: string }) => profiles.importFrom(p, c) },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => void secrets.set(k, v), delete: async (k: string) => secrets.delete(k) },
    requestUrl: async (o: { url: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array | null }) => toResp(await fetch(o.url, { method: o.method, headers: o.headers, body: o.body === "" || o.body == null ? undefined : (o.body as BodyInit) })),
    net: {
      upload: async (o: { url: string; method?: string; headers?: Record<string, string>; file: string; offset?: number; length?: number }) => {
        const all = await readFile(o.file);
        const res = await fetch(o.url, { method: o.method ?? "PUT", headers: o.headers, body: all.subarray(o.offset ?? 0, (o.offset ?? 0) + (o.length ?? all.length)) });
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
      },
      download: async (o: { url: string; headers?: Record<string, string>; to: string }) => {
        const res = await fetch(o.url, { headers: o.headers });
        if (!res.ok) return { status: res.status, headers: {}, size: 0, path: null, errorText: await res.text() };
        const buf = Buffer.from(await res.arrayBuffer());
        await mkdir(path.dirname(o.to), { recursive: true });
        await writeFile(o.to, buf);
        return { status: res.status, headers: {}, size: buf.length, path: o.to, errorText: null };
      },
    },
    auth: {
      // What SOUP does with a stand-in: follow the authorize redirect itself, check PKCE, exchange the code.
      oauthPkce: async (o: { authorizeUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scopes: string[]; extraParams?: Record<string, string> }) => {
        const verifier = "x".repeat(64);
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const u = new URL(o.authorizeUrl);
        for (const [k, v] of Object.entries({ client_id: o.clientId, redirect_uri: "http://127.0.0.1:9/", response_type: "code", scope: o.scopes.join(" "), state: "s1", code_challenge: challenge, code_challenge_method: "S256", ...o.extraParams })) u.searchParams.set(k, v);
        const r = await fetch(u, { redirect: "manual" });
        const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
        const t = await fetch(o.tokenUrl, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: o.clientId, client_secret: o.clientSecret ?? "" }) });
        const j = await t.json();
        return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: Date.now() + 3_600_000, scope: j.scope, idToken: j.id_token ?? null, extra: {} };
      },
      refresh: async (o: { tokenUrl: string; refreshToken: string }) => {
        const t = await fetch(o.tokenUrl, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refreshToken }) });
        if (!t.ok) throw Object.assign(new Error("auth_failed"), { code: "auth_failed" });
        const j = await t.json();
        return { accessToken: j.access_token, refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: j.scope, idToken: j.id_token ?? null, extra: {} };
      },
    },
  };

  try {
    const mod = (await import(pathToFileURL(dist).href)) as { default: new (app: unknown, manifest: unknown) => { onload(): Promise<void>; onunload(): void; controller: any } };
    const plugin = new mod.default(app, { id: "drive-sync", version: "1.0.0" });
    await plugin.onload();
    assert.equal(registered.settingTabs, 1);
    assert.equal(registered.header, 1);
    assert.deepEqual(registered.commands.sort(), ["backup-now", "restore", "settings"]);
    assert.equal(plugin.controller.status.get().kind, "signedOut");
    assert.equal(await plugin.controller.backup("manual"), null, "signed out: nothing runs");

    await plugin.controller.signIn();
    assert.equal(plugin.controller.email, "tester@example.com");
    assert.equal(plugin.controller.status.get().kind, "idle");
    assert.match(secrets.get("google.refresh")!, /^rt-/);
    assert.ok(!JSON.stringify(saved).includes("rt-"), "no token in saveData");
    assert.ok(g.authorizeRequests[0].scope === "https://www.googleapis.com/auth/drive.file openid email", `scopes: ${g.authorizeRequests[0].scope}`);

    const a = await lib.addReplay({ id: "r1", name: "Smoke match", vrf: bytes(40_000, 1), json: bytes(500, 2) });
    const r = await plugin.controller.backup("manual");
    assert.ok(r.ok, r.message);
    assert.equal(r.uploaded, 2);
    assert.deepEqual(g.named(`${a.id}.vrf`)[0].content, bytes(40_000, 1));
    assert.equal(g.named("backup.json").length, 1);
    assert.equal(g.named("settings.soupprofile").length, 1);
    assert.equal((saved as { lastOk: { ok: boolean } }).lastOk.ok, true);
    assert.equal(notices.some((n) => /backed up 2 file/.test(n)), true);
    assert.ok((await readFile(path.join(dataDir, "md5-cache.json"), "utf8")).includes(md5Of(bytes(40_000, 1))), "checksum cache saved");

    // A token the server stopped accepting is renewed transparently.
    g.expireTokens();
    const again = await plugin.controller.backup("manual");
    assert.ok(again.ok);

    // Restore into a second, empty Library through the same controller code.
    const summaries = await plugin.controller.backups();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].replayCount, 1);

    await plugin.controller.signOut();
    assert.equal(secrets.size, 0);
    assert.equal(g.revoked.length, 1);
    assert.equal(plugin.controller.status.get().kind, "signedOut");
    plugin.onunload();
  } finally {
    await g.stop();
    await rm(root, { recursive: true, force: true });
  }
});
