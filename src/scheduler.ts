// When to back up by itself: after the Library changes (debounced), and every N hours. Never while a match is live, never when signed
// out. All time comes in through `deps`, so tests drive it with a fake clock.
import { DEBOUNCE_MS, LIVE_RECHECK_MS, RETRY_AFTER_FAILURE_MS } from "./constants.ts";

export interface SchedulerSettings {
  /** The automatic-backup switch. */
  auto: boolean;
  /** 0 = no timed backups (changes still trigger one while `auto` is on). */
  intervalHours: number;
}

export interface SchedulerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  settings(): SchedulerSettings;
  isSignedIn(): boolean;
  isBusy(): boolean;
  isLive(): Promise<boolean>;
  /** Start a backup; resolves true when it worked. */
  run(reason: "changed" | "interval"): Promise<boolean>;
  /** Epoch ms of the last successful backup, or null. */
  lastSuccessAt(): number | null;
  debounceMs?: number;
  liveRecheckMs?: number;
  retryAfterFailureMs?: number;
  /** How often the interval is checked (default one minute). */
  tickMs?: number;
}

export class Scheduler {
  private debounceTimer: unknown = null;
  private tickTimer: unknown = null;
  private pending: "changed" | "interval" | null = null;
  private lastAttempt = 0;
  private stopped = false;

  private readonly d: SchedulerDeps;

  constructor(d: SchedulerDeps) {
    this.d = d;
  }

  start(): void {
    const tick = this.d.tickMs ?? 60_000;
    const loop = () => {
      if (this.stopped) return;
      void this.checkInterval();
      this.tickTimer = this.d.setTimer(loop, tick);
    };
    this.tickTimer = this.d.setTimer(loop, tick);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) this.d.clearTimer(this.debounceTimer);
    if (this.tickTimer !== null) this.d.clearTimer(this.tickTimer);
    this.debounceTimer = this.tickTimer = null;
  }

  /** The Library changed. A burst of changes becomes one backup 2 minutes after the last. */
  notifyLibraryChanged(): void {
    if (this.stopped || !this.d.settings().auto || this.d.isBusy() || this.d.lastSuccessAt() === null) return;
    if (this.debounceTimer !== null) this.d.clearTimer(this.debounceTimer);
    this.debounceTimer = this.d.setTimer(() => {
      this.debounceTimer = null;
      void this.attempt("changed");
    }, this.d.debounceMs ?? DEBOUNCE_MS);
  }

  /** Called every tick: is a timed backup due? */
  async checkInterval(): Promise<void> {
    const s = this.d.settings();
    if (this.stopped || !s.auto || s.intervalHours <= 0) return;
    const last = this.d.lastSuccessAt();
    if (last === null) return; // the first backup is always the person's own click
    const due = this.d.now() - last >= s.intervalHours * 3_600_000;
    if (due && this.debounceTimer === null && this.pending === null) await this.attempt("interval");
  }

  /** Run now if allowed; otherwise try again later (live match) or give up until the next trigger (signed out, busy). */
  async attempt(reason: "changed" | "interval"): Promise<void> {
    if (this.stopped || !this.d.isSignedIn() || this.d.isBusy() || !this.d.settings().auto) return;
    if (reason === "interval" && this.d.now() - this.lastAttempt < (this.d.retryAfterFailureMs ?? RETRY_AFTER_FAILURE_MS)) return;
    let live = false;
    try {
      live = await this.d.isLive();
    } catch {
      live = false;
    }
    if (live) {
      this.pending = reason;
      this.d.setTimer(() => {
        const p = this.pending;
        this.pending = null;
        if (p) void this.attempt(p);
      }, this.d.liveRecheckMs ?? LIVE_RECHECK_MS);
      return;
    }
    this.pending = null;
    this.lastAttempt = this.d.now();
    await this.d.run(reason);
  }
}
