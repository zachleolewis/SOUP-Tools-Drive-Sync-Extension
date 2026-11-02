// What the header chip and the settings page show, in one small observable.
export type DriveState =
  | { kind: "signedOut" }
  | { kind: "idle"; lastAt: number | null; lastOk: boolean }
  | { kind: "backingUp"; phase: string; done: number; total: number; percent: number | null; bytesDone: number; bytesTotal: number; current: string; label: string }
  | { kind: "restoring"; label: string; done: number; total: number; percent: number | null; bytesDone: number; bytesTotal: number; current: string }
  | { kind: "error"; message: string };

export class Status {
  private state: DriveState = { kind: "signedOut" };
  private subs = new Set<(s: DriveState) => void>();

  get(): DriveState {
    return this.state;
  }

  set(s: DriveState): void {
    this.state = s;
    for (const f of [...this.subs]) f(s);
  }

  subscribe(f: (s: DriveState) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function chipText(s: DriveState, now: number): string {
  switch (s.kind) {
    case "signedOut": return "Drive: Signed out";
    case "idle": return s.lastAt === null ? "Drive: Not backed up yet" : s.lastOk ? `Drive: Backed up ${ago(s.lastAt, now)}` : `Drive: Last backup had problems`;
    case "backingUp": return s.phase === "uploading" && s.total > 0 ? `Drive: Backing up ${s.percent ?? 0}% · ${Math.min(s.done + 1, s.total)} of ${s.total}` : s.phase === "checking" ? "Drive: Checking files" : "Drive: Backing up";
    case "restoring": return s.total > 0 ? `Drive: Restoring ${s.percent ?? 0}% · ${Math.min(s.done + 1, s.total)} of ${s.total}` : "Drive: Restoring";
    case "error": return "Drive: Error";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024, i++);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
