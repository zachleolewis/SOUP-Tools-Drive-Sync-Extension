import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEBOUNCE_MS, LIVE_RECHECK_MS } from "../src/constants.ts";
import { Scheduler, type SchedulerDeps } from "../src/scheduler.ts";

const HOUR = 3_600_000;

function rig(o: Partial<SchedulerDeps> & { auto?: boolean; hours?: number } = {}) {
  let now = 1_000_000_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
  let ids = 0;
  const runs: string[] = [];
  const state = { signedIn: true, busy: false, live: false, last: 1_000_000_000_000 - 100 * HOUR as number | null, auto: o.auto ?? true, hours: o.hours ?? 24, runOk: true };
  const deps: SchedulerDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, id: ++ids, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.live = false;
    },
    settings: () => ({ auto: state.auto, intervalHours: state.hours }),
    isSignedIn: () => state.signedIn,
    isBusy: () => state.busy,
    isLive: async () => state.live,
    run: async (reason) => {
      runs.push(reason);
      if (state.runOk) state.last = now;
      return state.runOk;
    },
    lastSuccessAt: () => state.last,
    ...o,
  };
  const s = new Scheduler(deps);
  /** Move time forward, firing timers in order (async work is awaited). */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = Math.max(now, next.at);
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    now = end;
  };
  return { s, state, runs, advance, timers };
}

describe("scheduler", () => {
  test("a burst of Library changes becomes ONE backup, 2 minutes after the last change", async () => {
    const { s, runs, advance } = rig();
    s.notifyLibraryChanged();
    await advance(60_000);
    s.notifyLibraryChanged();
    await advance(DEBOUNCE_MS - 1000);
    assert.deepEqual(runs, [], "the second change restarted the wait");
    await advance(2000);
    assert.deepEqual(runs, ["changed"]);
    await advance(DEBOUNCE_MS * 3);
    assert.deepEqual(runs, ["changed"]);
  });

  test("every N hours: due when the last good backup is older than the interval, checked each minute", async () => {
    const { s, runs, advance, state } = rig({ hours: 24 });
    state.last = 1_000_000_000_000 - 23 * HOUR;
    s.start();
    await advance(30 * 60_000);
    assert.deepEqual(runs, []);
    await advance(40 * 60_000); // now 24h+ since the last backup
    assert.deepEqual(runs, ["interval"]);
    await advance(2 * HOUR);
    assert.deepEqual(runs, ["interval"], "not again until the interval passes");
    s.stop();
  });

  test("interval 0 turns the timed backup off (changes still back up while Automatic is on)", async () => {
    const { s, runs, advance, state } = rig({ hours: 0 });
    s.start();
    await advance(200 * HOUR);
    assert.deepEqual(runs, []);
    s.notifyLibraryChanged();
    await advance(DEBOUNCE_MS + 1000);
    assert.deepEqual(runs, ["changed"]);
    state.auto = false;
    s.notifyLibraryChanged();
    await advance(DEBOUNCE_MS + 1000);
    assert.deepEqual(runs, ["changed"]);
  });

  test("never while a match is live: waits and tries again, then runs once the match is over", async () => {
    const { s, runs, advance, state } = rig();
    state.live = true;
    s.notifyLibraryChanged();
    await advance(DEBOUNCE_MS + 1000);
    assert.deepEqual(runs, []);
    await advance(LIVE_RECHECK_MS * 2);
    assert.deepEqual(runs, [], "still live");
    state.live = false;
    await advance(LIVE_RECHECK_MS + 1000);
    assert.deepEqual(runs, ["changed"]);
  });

  test("never when signed out or while another run is busy", async () => {
    const { s, runs, advance, state } = rig();
    state.signedIn = false;
    s.notifyLibraryChanged();
    await advance(DEBOUNCE_MS + 1000);
    state.signedIn = true;
    state.busy = true;
    s.notifyLibraryChanged();
    await advance(DEBOUNCE_MS + 1000);
    assert.deepEqual(runs, []);
  });

  test("the first backup is always the person's own: nothing automatic before one succeeded", async () => {
    const { s, runs, advance, state } = rig();
    state.last = null;
    s.start();
    s.notifyLibraryChanged();
    await advance(48 * HOUR);
    assert.deepEqual(runs, []);
  });

  test("a failed timed run is retried after 30 minutes, not every minute", async () => {
    const { s, runs, advance, state } = rig({ hours: 24 });
    state.runOk = false;
    s.start();
    await advance(61_000);
    assert.equal(runs.length, 1);
    await advance(20 * 60_000);
    assert.equal(runs.length, 1, "backing off");
    await advance(15 * 60_000);
    assert.equal(runs.length, 2);
    s.stop();
  });

  test("stop() cancels pending work", async () => {
    const { s, runs, advance } = rig();
    s.notifyLibraryChanged();
    s.stop();
    await advance(DEBOUNCE_MS * 2);
    assert.deepEqual(runs, []);
  });
});
