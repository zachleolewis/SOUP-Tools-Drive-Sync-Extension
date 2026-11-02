// The only door to the network. The Drive client talks to a Transport; in SOUP it is app.requestUrl / app.net, in tests a fake.
import type { App } from "soup";

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
}
export interface HttpResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  text: string;
}
export interface UploadRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  file: string;
  offset: number;
  length: number;
  onProgress?: (done: number, total: number | null) => void;
}
export interface DownloadRequest {
  url: string;
  headers?: Record<string, string>;
  to: string;
  onProgress?: (done: number, total: number | null) => void;
}
export interface DownloadResult {
  status: number;
  size: number;
  errorText: string | null;
}

export interface Transport {
  /** Resolves with the status whatever it is; rejects only when the request did not get an answer. */
  request(r: HttpRequest): Promise<HttpResponse>;
  /** A slice of a local file, streamed by SOUP. Same rules as `request`. */
  upload(r: UploadRequest): Promise<HttpResponse>;
  download(r: DownloadRequest): Promise<DownloadResult>;
}

export function soupTransport(app: App): Transport {
  return {
    async request(r) {
      const res = await app.requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body ?? undefined, throw: false, timeoutMs: 120_000 });
      return { status: res.status, headers: res.headers, text: res.text };
    },
    async upload(r) {
      const res = await app.net.upload({ url: r.url, method: r.method, headers: r.headers, file: r.file, offset: r.offset, length: r.length, onProgress: r.onProgress ? (p) => r.onProgress!(p.done, p.total) : undefined });
      return { status: res.status, headers: res.headers as Record<string, string>, text: res.text };
    },
    async download(r) {
      const res = await app.net.download({ url: r.url, headers: r.headers, to: r.to, onProgress: r.onProgress ? (p) => r.onProgress!(p.done, p.total) : undefined });
      return { status: res.status, size: res.size, errorText: res.errorText };
    },
  };
}
