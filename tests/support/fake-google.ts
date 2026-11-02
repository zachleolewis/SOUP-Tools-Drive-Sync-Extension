// An in-process stand-in for Google: the OAuth endpoints (authorize, token, revoke) and the part of Drive v3 that Drive Sync uses
// (files.list with q, get, create, update, delete, multipart and resumable uploads with 308 resume, media download).
// Used by the unit tests, and by `npm run fake-google` as the Google that a SOUP self-test points the extension at.
// It is a test double: it checks what the real service would check (bearer token, Content-Range arithmetic) but nothing more.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties?: Record<string, string>;
  content?: Buffer;
  trashed: boolean;
}

export interface Fault {
  /** Matches `METHOD /path` (without the query). */
  match: (req: { method: string; path: string; query: URLSearchParams }) => boolean;
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** How many times to fire (default 1). */
  times?: number;
  /** For a chunk PUT: store the bytes first, then fail (a lost acknowledgement). */
  afterStore?: boolean;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  contentRange?: string;
}

interface Session {
  meta: { name?: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string> };
  fileId?: string;
  chunks: Buffer[];
  received: number;
  total: number;
  done?: FakeFile;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const LIT = /'((?:[^'\\]|\\.)*)'/y;
const unescapeLit = (s: string) => s.replace(/\\(.)/g, "$1");

export class FakeGoogle {
  files = new Map<string, FakeFile>();
  requests: LoggedRequest[] = [];
  faults: Fault[] = [];
  validTokens = new Set<string>();
  refreshTokens = new Set<string>();
  revoked: string[] = [];
  tokenRequests: Array<Record<string, string>> = [];
  authorizeRequests: Array<Record<string, string>> = [];
  quotaFull = false;
  /** Bytes per second the server accepts and sends (0: unlimited), so a test can watch a large transfer. */
  throttleBps = 0;
  /** Smaller page size than the client asks for, to test paging. */
  pageSize = 0;
  email = "tester@example.com";
  /** Scope string returned by the token endpoint (default what we ask for). */
  grantedScope = "https://www.googleapis.com/auth/drive.file openid https://www.googleapis.com/auth/userinfo.email";
  private sessions = new Map<string, Session>();
  private server!: http.Server;
  private n = 0;
  private codes = new Map<string, { challenge: string }>();
  base = "";

  async start(port = 0): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => ((res.statusCode = 500), res.end(String(e)))));
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get endpoints() {
    return { authorizeUrl: `${this.base}/authorize`, tokenUrl: `${this.base}/token`, revokeUrl: `${this.base}/revoke`, driveUrl: `${this.base}/drive/v3`, uploadUrl: `${this.base}/upload/drive/v3` };
  }

  /** Make every access token the fake handed out stop working (the client gets 401 and must refresh). */
  expireTokens(): void {
    this.validTokens.clear();
  }

  fail(f: Fault): void {
    this.faults.push({ times: 1, ...f });
  }

  /** Files by name (live ones). */
  named(name: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.name === name && !f.trashed);
  }

  put(f: Partial<FakeFile> & { name: string }): FakeFile {
    const file: FakeFile = { id: `id-${++this.n}`, mimeType: "application/octet-stream", parents: ["root"], trashed: false, ...f };
    this.files.set(file.id, file);
    return file;
  }

  private meta(f: FakeFile) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties, trashed: f.trashed, ...(f.content ? { size: String(f.content.length), md5Checksum: md5(f.content) } : {}) };
  }

  private async send(res: http.ServerResponse, data: Buffer): Promise<void> {
    const step = this.throttleBps > 0 ? Math.max(1024, Math.floor(this.throttleBps / 10)) : data.length || 1;
    for (let o = 0; o < data.length; o += step) {
      if (!res.write(data.subarray(o, o + step))) await new Promise((r) => res.once("drain", r));
      if (this.throttleBps > 0) await new Promise((r) => setTimeout(r, 100));
    }
    res.end();
  }

  private async body(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
      if (this.throttleBps > 0) await new Promise((r) => setTimeout(r, (c.length / this.throttleBps) * 1000));
    }
    return Buffer.concat(chunks);
  }

  private json(res: http.ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  }

  private takeFault(method: string, path: string, query: URLSearchParams, phase: "before" | "after"): Fault | undefined {
    const i = this.faults.findIndex((f) => !!f.afterStore === (phase === "after") && f.match({ method, path, query }));
    if (i < 0) return undefined;
    const f = this.faults[i];
    if (--f.times! <= 0) this.faults.splice(i, 1);
    return f;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.base);
    const method = req.method!;
    const path = url.pathname;
    const q = url.searchParams;
    this.requests.push({ method, path, query: q, auth: req.headers.authorization, contentRange: req.headers["content-range"] as string | undefined });

    // ---- test control (for a self-test driving the standalone fake)
    if (path === "/__control/expire-tokens") return (this.expireTokens(), void res.writeHead(204).end());
    if (path === "/__control/throttle") return (this.throttleBps = Number(q.get("bps") ?? 0), void res.writeHead(204).end());
    if (path === "/__control/quota") return (this.quotaFull = q.get("full") === "1", void res.writeHead(204).end());
    if (path === "/__control/state") return this.json(res, 200, { files: [...this.files.values()].map((f) => ({ ...this.meta(f) })), revoked: this.revoked.length, tokenRequests: this.tokenRequests.length, authorizeRequests: this.authorizeRequests, quotaFull: this.quotaFull, requests: this.requests.filter((r) => !r.path.startsWith("/__control")).map((r) => `${r.method} ${r.path}`) });
    if (path === "/__control/content") {
      const f = this.named(q.get("name") ?? "")[0];
      return f?.content ? void res.writeHead(200, { "content-type": "application/octet-stream" }).end(f.content) : void res.writeHead(404).end();
    }

    // ---- OAuth
    if (path === "/authorize") return this.authorize(q, res);
    if (path === "/token" && method === "POST") return this.token(await this.body(req), res);
    if (path === "/revoke" && method === "POST") {
      const f = new URLSearchParams((await this.body(req)).toString());
      this.revoked.push(f.get("token") ?? "");
      this.refreshTokens.delete(f.get("token") ?? "");
      res.writeHead(200).end();
      return;
    }

    // ---- Drive
    const before = this.takeFault(method, path, q, "before");
    if (before) {
      await this.body(req);
      res.writeHead(before.status, { "content-type": "application/json", ...before.headers });
      res.end(before.body ?? JSON.stringify({ error: { code: before.status, message: "injected" } }));
      return;
    }
    const isSession = path.startsWith("/upload/session/");
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!isSession || req.headers.authorization) {
      if (!token || !this.validTokens.has(token)) return this.json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
    }
    if (this.quotaFull && method !== "GET" && method !== "DELETE" && path !== "/drive/v3/files" ) {
      await this.body(req);
      return this.json(res, 403, { error: { code: 403, message: "The user's Drive storage quota has been exceeded.", errors: [{ reason: "storageQuotaExceeded" }] } });
    }

    if (isSession && method === "PUT") return this.sessionPut(path, req, res, q);

    const fileMatch = /^\/(?:upload\/)?drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (!fileMatch) return this.json(res, 404, { error: { code: 404, message: "no such route" } });
    const id = fileMatch[1] ? decodeURIComponent(fileMatch[1]) : undefined;
    const upload = path.startsWith("/upload/");

    if (!upload && method === "GET" && !id) return this.list(q, res);
    if (!upload && method === "GET" && id) {
      const f = this.files.get(id);
      if (!f) return this.json(res, 404, { error: { code: 404, message: "File not found" } });
      if (q.get("alt") === "media") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(f.content?.length ?? 0) });
        void this.send(res, f.content ?? Buffer.alloc(0));
        return;
      }
      return this.json(res, 200, this.meta(f));
    }
    if (!upload && method === "POST" && !id) {
      const m = JSON.parse((await this.body(req)).toString());
      const f = this.put({ name: m.name, mimeType: m.mimeType ?? "application/octet-stream", parents: m.parents ?? ["root"], appProperties: m.appProperties });
      return this.json(res, 200, this.meta(f));
    }
    if (!upload && method === "PATCH" && id) {
      const f = this.files.get(id);
      const m = JSON.parse((await this.body(req)).toString() || "{}");
      if (!f) return this.json(res, 404, { error: { code: 404, message: "File not found" } });
      if (m.name) f.name = m.name;
      if (m.appProperties) f.appProperties = m.appProperties;
      return this.json(res, 200, this.meta(f));
    }
    if (!upload && method === "DELETE" && id) {
      if (!this.files.delete(id)) return this.json(res, 404, { error: { code: 404, message: "File not found" } });
      res.writeHead(204).end();
      return;
    }
    if (upload && q.get("uploadType") === "multipart" && (method === "POST" || method === "PATCH")) {
      const { meta, content } = parseMultipart(req.headers["content-type"] ?? "", await this.body(req));
      return this.json(res, 200, this.meta(this.store(meta, content, id)));
    }
    if (upload && q.get("uploadType") === "resumable" && (method === "POST" || method === "PATCH")) {
      const meta = JSON.parse((await this.body(req)).toString() || "{}");
      const sid = randomBytes(8).toString("hex");
      this.sessions.set(sid, { meta, fileId: id, chunks: [], received: 0, total: Number(req.headers["x-upload-content-length"] ?? 0) });
      res.writeHead(200, { location: `${this.base}/upload/session/${sid}`, "content-length": "0" });
      res.end();
      return;
    }
    this.json(res, 400, { error: { code: 400, message: "unsupported" } });
  }

  private store(meta: { name?: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string> }, content: Buffer, id?: string): FakeFile {
    if (id) {
      const f = this.files.get(id)!;
      if (meta.name) f.name = meta.name;
      f.content = content;
      return f;
    }
    return this.put({ name: meta.name ?? "untitled", mimeType: meta.mimeType ?? "application/octet-stream", parents: meta.parents ?? ["root"], appProperties: meta.appProperties, content });
  }

  private async sessionPut(path: string, req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams): Promise<void> {
    const s = this.sessions.get(path.split("/").pop()!);
    const body = await this.body(req);
    if (!s) return this.json(res, 404, { error: { code: 404, message: "Upload session not found" } });
    const cr = String(req.headers["content-range"] ?? "");
    const respondStatus = () => {
      if (s.done) return this.json(res, 200, this.meta(s.done));
      const headers: Record<string, string> = s.received > 0 ? { range: `bytes=0-${s.received - 1}` } : {};
      res.writeHead(308, { ...headers, "content-length": "0" });
      res.end();
    };
    if (/^bytes \*\//.test(cr)) return respondStatus();
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    if (!m) return this.json(res, 400, { error: { code: 400, message: "bad Content-Range" } });
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (end - start + 1 !== body.length) return this.json(res, 400, { error: { code: 400, message: "Content-Range does not match the body" } });
    if (start > s.received) return respondStatus(); // a gap: tell the client where we are
    const fresh = body.subarray(s.received - start);
    s.chunks.push(fresh);
    s.received += fresh.length;
    if (s.received >= total) s.done = this.store(s.meta, Buffer.concat(s.chunks), s.fileId);
    const after = this.takeFault("PUT", path, q, "after");
    if (after) {
      res.writeHead(after.status, { "content-type": "application/json", ...after.headers });
      res.end(after.body ?? JSON.stringify({ error: { code: after.status, message: "injected" } }));
      return;
    }
    if (s.done) return this.json(res, s.fileId ? 200 : 201, this.meta(s.done));
    respondStatus();
  }

  private list(q: URLSearchParams, res: http.ServerResponse): void {
    const clauses = parseQuery(q.get("q") ?? "");
    let all = [...this.files.values()].filter((f) => clauses.every((c) => c(f)));
    all = all.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const size = this.pageSize || Number(q.get("pageSize") ?? 100);
    const from = Number(q.get("pageToken") ?? 0);
    const page = all.slice(from, from + size);
    this.json(res, 200, { files: page.map((f) => this.meta(f)), ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}) });
  }

  private authorize(q: URLSearchParams, res: http.ServerResponse): void {
    this.authorizeRequests.push(Object.fromEntries(q));
    const code = `code-${++this.n}`;
    this.codes.set(code, { challenge: q.get("code_challenge") ?? "" });
    const back = new URL(q.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    res.writeHead(302, { location: back.toString() }).end();
  }

  private token(raw: Buffer, res: http.ServerResponse): void {
    const f = Object.fromEntries(new URLSearchParams(raw.toString())) as Record<string, string>;
    this.tokenRequests.push(f);
    const fail = (error: string) => this.json(res, 400, { error, error_description: error });
    const issue = (refresh?: string) => {
      const at = `at-${++this.n}`;
      this.validTokens.add(at);
      const idToken = `${b64url(Buffer.from("{}"))}.${b64url(Buffer.from(JSON.stringify({ email: this.email })))}.sig`;
      this.json(res, 200, { access_token: at, expires_in: 3600, scope: this.grantedScope, token_type: "Bearer", id_token: idToken, ...(refresh ? { refresh_token: refresh } : {}) });
    };
    if (f.grant_type === "authorization_code") {
      const c = this.codes.get(f.code);
      if (!c) return fail("invalid_grant");
      if (b64url(createHash("sha256").update(f.code_verifier ?? "").digest()) !== c.challenge) return fail("invalid_grant");
      const refresh = `rt-${++this.n}`;
      this.refreshTokens.add(refresh);
      return issue(refresh);
    }
    if (f.grant_type === "refresh_token") {
      if (!this.refreshTokens.has(f.refresh_token)) return fail("invalid_grant");
      return issue();
    }
    fail("unsupported_grant_type");
  }
}

/** The tiny part of Drive's `q` language that Drive Sync uses. */
function parseQuery(q: string): Array<(f: FakeFile) => boolean> {
  const out: Array<(f: FakeFile) => boolean> = [];
  let i = 0;
  const lit = (): string => {
    LIT.lastIndex = i;
    const m = LIT.exec(q);
    if (!m) throw new Error(`fake drive: bad literal at ${i} in ${q}`);
    i = LIT.lastIndex;
    return unescapeLit(m[1]);
  };
  const eat = (re: RegExp): boolean => {
    const r = new RegExp(re.source, "y");
    r.lastIndex = i;
    const m = r.exec(q);
    if (!m) return false;
    i = r.lastIndex;
    return true;
  };
  while (i < q.length) {
    eat(/\s*(?:and\s+)?/);
    if (i >= q.length) break;
    if (eat(/name\s*=\s*/)) {
      const v = lit();
      out.push((f) => f.name === v);
    } else if (eat(/mimeType\s*=\s*/)) {
      const v = lit();
      out.push((f) => f.mimeType === v);
    } else if (eat(/trashed\s*=\s*false/)) {
      out.push((f) => !f.trashed);
    } else if (eat(/appProperties\s+has\s*\{\s*key\s*=\s*/)) {
      const k = lit();
      eat(/\s*and\s+value\s*=\s*/);
      const v = lit();
      eat(/\s*\}/);
      out.push((f) => f.appProperties?.[k] === v);
    } else if (q[i] === "'") {
      const v = lit();
      if (!eat(/\s+in\s+parents/)) throw new Error(`fake drive: unsupported query near ${q.slice(i)}`);
      out.push((f) => f.parents.includes(v));
    } else {
      throw new Error(`fake drive: unsupported query near ${q.slice(i)}`);
    }
  }
  return out;
}

function parseMultipart(contentType: string, body: Buffer): { meta: { name?: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string> }; content: Buffer } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error("fake drive: multipart without boundary");
  const delim = Buffer.from(`--${boundary}`);
  const positions: number[] = [];
  for (let at = body.indexOf(delim); at >= 0; at = body.indexOf(delim, at + 1)) positions.push(at);
  const parts = [];
  for (let k = 0; k + 1 < positions.length; k++) {
    const seg = body.subarray(positions[k] + delim.length, positions[k + 1]);
    const split = seg.indexOf("\r\n\r\n");
    parts.push(seg.subarray(split + 4, seg.length - 2)); // drop the CRLF before the next delimiter
  }
  if (parts.length !== 2) throw new Error(`fake drive: expected 2 multipart parts, got ${parts.length}`);
  return { meta: JSON.parse(parts[0].toString()), content: Buffer.from(parts[1]) };
}
