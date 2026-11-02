// A small Google Drive v3 client: files.list by name + parent, folders, multipart and resumable uploads, downloads, delete.
// It never logs a token. Network, base URLs and token handling are injected, so tests run it against an in-process fake Drive.
import { CHUNK_SIZE, FOLDER_MIME, MAX_TRIES } from "./constants.ts";
import { chunkAt, nextOffsetFromRange, statusRange } from "./chunks.ts";
import { CancelError, DriveError } from "./errors.ts";
import type { HttpResponse, Transport } from "./transport.ts";

export interface TokenSource {
  /** A valid access token (refreshed when it is about to expire). */
  getToken(): Promise<string>;
  /** Force a refresh (after a 401). Throws a DriveError("auth") when the person has to sign in again. */
  refresh(): Promise<string>;
}

export interface DriveOptions {
  transport: Transport;
  tokens: TokenSource;
  driveUrl: string;
  uploadUrl: string;
  sleep?: (ms: number) => Promise<void>;
  /** Backoff base: tries wait base, 2x base, 4x base ... (default 1000). */
  baseDelayMs?: number;
  maxTries?: number;
  chunkSize?: number;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  trashed?: boolean;
}

export interface UploadFileOptions {
  name: string;
  parentId?: string;
  /** Update this file instead of creating one. */
  fileId?: string;
  mimeType: string;
  appProperties?: Record<string, string>;
}

const FIELDS = "id,name,mimeType,size,md5Checksum,parents,appProperties,trashed";
const RETRYABLE = new Set(["rate", "server", "offline"]);

/** Escape a value for a Drive `q` string literal. */
export const qLit = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export class DriveClient {
  private readonly t: Transport;
  private readonly tokens: TokenSource;
  private readonly driveUrl: string;
  private readonly uploadUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: number;
  private readonly maxTries: number;
  private readonly chunkSize: number;

  constructor(o: DriveOptions) {
    this.t = o.transport;
    this.tokens = o.tokens;
    this.driveUrl = o.driveUrl.replace(/\/+$/, "");
    this.uploadUrl = o.uploadUrl.replace(/\/+$/, "");
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = o.baseDelayMs ?? 1000;
    this.maxTries = o.maxTries ?? MAX_TRIES;
    this.chunkSize = o.chunkSize ?? CHUNK_SIZE;
  }

  // ------------------------------------------------------------------ the request core

  /**
   * Run a request with the bearer token. 401: refresh once and repeat (a second 401 is "sign in again"). 429 / 5xx / no answer:
   * exponential backoff, at most `maxTries` tries (`retry: false` throws at once, for callers that resume by themselves).
   * `ok` lists statuses besides 2xx that are answers, not errors (308 for a resumable chunk).
   */
  async call(run: (token: string) => Promise<HttpResponse>, o: { retry?: boolean; ok?: number[]; allow404?: boolean } = {}): Promise<HttpResponse> {
    const retry = o.retry ?? true;
    let refreshed = false;
    let attempt = 0;
    let token = await this.tokens.getToken();
    for (;;) {
      let res: HttpResponse | null = null;
      let err: DriveError | null = null;
      try {
        res = await run(token);
      } catch (e) {
        if (e instanceof DriveError || e instanceof CancelError) throw e;
        err = new DriveError("offline", "The request did not reach Google");
      }
      if (res) {
        if (res.status === 401) {
          if (refreshed) throw new DriveError("auth", "Google refused the access token again after a refresh", 401);
          refreshed = true;
          token = await this.tokens.refresh();
          continue;
        }
        if ((res.status >= 200 && res.status < 300) || o.ok?.includes(res.status)) return res;
        if (res.status === 404 && o.allow404) return res;
        err = classify(res);
      }
      attempt++;
      if (!retry || !RETRYABLE.has(err!.kind) || attempt >= this.maxTries) throw err!;
      await this.sleep(backoffMs(res, attempt, this.base));
    }
  }

  private authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  private async json<T>(method: string, url: string, body?: unknown, o: { allow404?: boolean } = {}): Promise<T | null> {
    const res = await this.call(
      (token) => this.t.request({ url, method, headers: this.authHeaders(token, body === undefined ? {} : { "Content-Type": "application/json; charset=UTF-8" }), body: body === undefined ? null : JSON.stringify(body) }),
      { allow404: o.allow404 },
    );
    if (res.status === 404) return null;
    if (res.status === 204 || res.text === "") return {} as T;
    return JSON.parse(res.text) as T;
  }

  // ------------------------------------------------------------------ files.list / get

  /** All files matching `q` (Drive query syntax), following pages. */
  async list(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q, pageSize: "1000", fields: `nextPageToken,files(${FIELDS})`, spaces: "drive" });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>("GET", `${this.driveUrl}/files?${params}`);
      out.push(...(r?.files ?? []));
      pageToken = r?.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  /** The first live file called `name` in `parentId` (and of `mimeType` when given). */
  async findByName(name: string, parentId: string, mimeType?: string): Promise<DriveFile | null> {
    let q = `name = ${qLit(name)} and ${qLit(parentId)} in parents and trashed = false`;
    if (mimeType) q += ` and mimeType = ${qLit(mimeType)}`;
    const files = await this.list(q);
    return files[0] ?? null;
  }

  async findFolderByProperty(parentId: string, key: string, value: string): Promise<DriveFile | null> {
    const q = `${qLit(parentId)} in parents and trashed = false and mimeType = ${qLit(FOLDER_MIME)} and appProperties has { key=${qLit(key)} and value=${qLit(value)} }`;
    return (await this.list(q))[0] ?? null;
  }

  async listChildren(parentId: string): Promise<DriveFile[]> {
    return this.list(`${qLit(parentId)} in parents and trashed = false`);
  }

  /** The file, or null when it does not exist. */
  async getFile(id: string): Promise<DriveFile | null> {
    return this.json<DriveFile>("GET", `${this.driveUrl}/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: FIELDS })}`, undefined, { allow404: true });
  }

  // ------------------------------------------------------------------ folders

  async createFolder(name: string, parentId: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    const f = await this.json<DriveFile>("POST", `${this.driveUrl}/files?${new URLSearchParams({ fields: FIELDS })}`, { name, mimeType: FOLDER_MIME, parents: [parentId], ...(appProperties ? { appProperties } : {}) });
    return f!;
  }

  async ensureFolder(name: string, parentId: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    return (await this.findByName(name, parentId, FOLDER_MIME)) ?? (await this.createFolder(name, parentId, appProperties));
  }

  async rename(id: string, name: string): Promise<void> {
    await this.json("PATCH", `${this.driveUrl}/files/${encodeURIComponent(id)}?fields=id`, { name });
  }

  /** Delete a file or folder for good (Drive's trash is skipped). A missing file is fine. */
  async delete(id: string): Promise<void> {
    await this.call((token) => this.t.request({ url: `${this.driveUrl}/files/${encodeURIComponent(id)}`, method: "DELETE", headers: this.authHeaders(token) }), { allow404: true });
  }

  // ------------------------------------------------------------------ uploads

  private metadata(o: UploadFileOptions): Record<string, unknown> {
    const props = o.appProperties ? { appProperties: o.appProperties } : {};
    return o.fileId ? { name: o.name, ...props } : { name: o.name, parents: [o.parentId], mimeType: o.mimeType, ...props };
  }

  /** One request: metadata + content. For a file up to a few MB. `fileId` updates that file; otherwise it is created in `parentId`. */
  async uploadMultipart(o: UploadFileOptions & { bytes: Uint8Array }): Promise<DriveFile> {
    const boundary = `soup-drive-sync-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.metadata(o))}\r\n--${boundary}\r\nContent-Type: ${o.mimeType}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + o.bytes.length + tail.length);
    body.set(head, 0);
    body.set(o.bytes, head.length);
    body.set(tail, head.length + o.bytes.length);
    const url = o.fileId ? `${this.uploadUrl}/files/${encodeURIComponent(o.fileId)}?uploadType=multipart&fields=${FIELDS}` : `${this.uploadUrl}/files?uploadType=multipart&fields=${FIELDS}`;
    const res = await this.call((token) => this.t.request({ url, method: o.fileId ? "PATCH" : "POST", headers: this.authHeaders(token, { "Content-Type": `multipart/related; boundary=${boundary}` }), body }));
    return JSON.parse(res.text) as DriveFile;
  }

  /**
   * Resumable upload of a local file in `chunkSize` pieces through the transport's streaming upload (offset/length). After a failed
   * chunk it asks Drive how much arrived (`Content-Range: bytes * / total`) and continues from there. A session that Drive forgot
   * (404/410) is started again once.
   */
  async uploadResumable(o: UploadFileOptions & { file: string; total: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<DriveFile> {
    for (let restart = 0; ; restart++) {
      try {
        return await this.resumableOnce(o);
      } catch (e) {
        if (restart === 0 && e instanceof DriveError && (e.status === 404 || e.status === 410)) continue;
        throw e;
      }
    }
  }

  private async resumableOnce(o: UploadFileOptions & { file: string; total: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<DriveFile> {
    const startUrl = o.fileId ? `${this.uploadUrl}/files/${encodeURIComponent(o.fileId)}?uploadType=resumable&fields=${FIELDS}` : `${this.uploadUrl}/files?uploadType=resumable&fields=${FIELDS}`;
    const started = await this.call((token) =>
      this.t.request({
        url: startUrl,
        method: o.fileId ? "PATCH" : "POST",
        headers: this.authHeaders(token, { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": o.mimeType, "X-Upload-Content-Length": String(o.total) }),
        body: JSON.stringify(this.metadata(o)),
      }),
    );
    const session = started.headers["location"];
    if (!session) throw new DriveError("other", "Drive did not return an upload address", started.status);

    let offset = 0;
    let failures = 0;
    for (;;) {
      if (o.signal?.aborted) throw new CancelError();
      const c = chunkAt(o.total, offset, this.chunkSize);
      let res: HttpResponse;
      try {
        res = await this.call(
          (token) =>
            this.t.upload({
              url: session,
              method: "PUT",
              headers: this.authHeaders(token, { "Content-Range": c.contentRange }),
              file: o.file,
              offset: c.offset,
              length: c.length,
              onProgress: (done) => o.onProgress?.(Math.min(o.total, c.offset + done), o.total),
            }),
          { retry: false, ok: [308] },
        );
      } catch (e) {
        if (e instanceof DriveError && RETRYABLE.has(e.kind) && ++failures < this.maxTries) {
          await this.sleep(this.base * 2 ** (failures - 1));
          const st = await this.sessionStatus(session, o.total);
          if (st.file) return st.file;
          offset = st.offset;
          continue;
        }
        throw e;
      }
      if (res.status === 200 || res.status === 201) {
        o.onProgress?.(o.total, o.total);
        return JSON.parse(res.text) as DriveFile;
      }
      // 308: continue where Drive says it is.
      failures = 0;
      offset = nextOffsetFromRange(res.headers["range"]);
      if (offset >= o.total) {
        // Drive has every byte but did not finalise; ask again.
        const st = await this.sessionStatus(session, o.total);
        if (st.file) return st.file;
        throw new DriveError("other", "Drive has all bytes but did not complete the upload");
      }
    }
  }

  /** `PUT` with `Content-Range: bytes * / total`: 308 + Range (how much arrived) or 200/201 (it is complete). */
  private async sessionStatus(session: string, total: number): Promise<{ offset: number; file?: DriveFile }> {
    const res = await this.call((token) => this.t.request({ url: session, method: "PUT", headers: this.authHeaders(token, { "Content-Range": statusRange(total) }), body: "" }), { ok: [308] });
    if (res.status === 308) return { offset: nextOffsetFromRange(res.headers["range"]) };
    return { offset: total, file: JSON.parse(res.text) as DriveFile };
  }

  // ------------------------------------------------------------------ downloads

  /** A small file as text (backup.json). */
  async readText(id: string): Promise<string> {
    const res = await this.call((token) => this.t.request({ url: `${this.driveUrl}/files/${encodeURIComponent(id)}?alt=media`, method: "GET", headers: this.authHeaders(token) }));
    return res.text;
  }

  /** Stream a file to `to` (SOUP writes `<to>.soup-part` and renames). Returns the bytes written. */
  async download(id: string, to: string, onProgress?: (done: number, total: number | null) => void): Promise<number> {
    let size = 0;
    await this.call(async (token) => {
      const r = await this.t.download({ url: `${this.driveUrl}/files/${encodeURIComponent(id)}?alt=media`, headers: this.authHeaders(token), to, onProgress });
      size = r.size;
      // call() wants a response; the body of a failed download is in errorText.
      return { status: r.status, headers: {}, text: r.errorText ?? "" };
    });
    return size;
  }
}

// ------------------------------------------------------------------ helpers

/** 403 with storageQuotaExceeded is "full"; rate-limit 403s are retried like 429; the rest by status. */
export function classify(res: HttpResponse): DriveError {
  const s = res.status;
  const text = res.text || "";
  const reason = /"reason"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "";
  if (s === 403 && (reason === "storageQuotaExceeded" || /storageQuotaExceeded/.test(text))) return new DriveError("quota", "Google Drive storage quota exceeded", s);
  if (s === 429 || (s === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason + text))) return new DriveError("rate", "Google rate limit", s);
  if (s >= 500) return new DriveError("server", `Google answered ${s}`, s);
  if (s === 403) return new DriveError("forbidden", "Google refused access", s);
  if (s === 404) return new DriveError("notfound", "Not found in Google Drive", s);
  return new DriveError("other", `Google answered ${s}${reason ? ` (${reason})` : ""}`, s);
}

/** Wait before the next try: `Retry-After` when Drive sent one, otherwise base * 2^(attempt-1), at most a minute. */
export function backoffMs(res: HttpResponse | null, attempt: number, base: number): number {
  const ra = Number(res?.headers["retry-after"]);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60_000);
  return Math.min(base * 2 ** (attempt - 1), 60_000);
}
