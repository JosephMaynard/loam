import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLivenessWatchdog,
  HEARTBEAT_DEAD_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_RECHECK_GRACE_MS,
} from "./ws-liveness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocket liveness watchdog (review 2026-09-25)", () => {
  it("declares a socket dead after ~2 missed heartbeats, exactly once", () => {
    const onDead = vi.fn();
    const watchdog = createLivenessWatchdog(onDead);
    watchdog.frame(true); // the heartbeat sent on admission

    vi.advanceTimersByTime(HEARTBEAT_DEAD_AFTER_MS - 1);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDead).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * HEARTBEAT_DEAD_AFTER_MS);
    watchdog.check();
    vi.advanceTimersByTime(HEARTBEAT_RECHECK_GRACE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("stays alive while heartbeats (or any frames) keep arriving", () => {
    const onDead = vi.fn();
    const watchdog = createLivenessWatchdog(onDead);
    watchdog.frame(true);
    for (let beat = 0; beat < 20; beat += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      watchdog.frame(beat % 2 === 0); // pings interleaved with ordinary events
    }
    expect(onDead).not.toHaveBeenCalled();
  });

  it("never arms against a node that doesn't send heartbeats (a silent old node isn't torn down)", () => {
    const onDead = vi.fn();
    const watchdog = createLivenessWatchdog(onDead);
    watchdog.frame(false); // ordinary events only, no ping ever
    vi.advanceTimersByTime(60 * 60_000);
    watchdog.check();
    vi.advanceTimersByTime(HEARTBEAT_RECHECK_GRACE_MS);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("on visible/online, a missed beat is detected even though the background timer was frozen", () => {
    const onDead = vi.fn();
    const watchdog = createLivenessWatchdog(onDead);
    watchdog.frame(true);
    // The page was frozen for 40s: wall-clock time moved, but no timer ran.
    vi.setSystemTime(Date.now() + 40_000);
    watchdog.check();
    expect(onDead).not.toHaveBeenCalled(); // waits a moment for frames buffered while frozen
    vi.advanceTimersByTime(HEARTBEAT_RECHECK_GRACE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("a buffered heartbeat delivered right after resuming cancels the re-check", () => {
    const onDead = vi.fn();
    const watchdog = createLivenessWatchdog(onDead);
    watchdog.frame(true);
    vi.setSystemTime(Date.now() + 40_000);
    watchdog.check();
    vi.advanceTimersByTime(100);
    watchdog.frame(true); // the ping the browser held while the page was frozen
    vi.advanceTimersByTime(HEARTBEAT_RECHECK_GRACE_MS);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("a recent frame makes the re-check a no-op, and stop() cancels everything", () => {
    const onDead = vi.fn();
    const watchdog = createLivenessWatchdog(onDead);
    watchdog.frame(true);
    vi.advanceTimersByTime(5_000);
    watchdog.check();
    vi.advanceTimersByTime(HEARTBEAT_RECHECK_GRACE_MS);
    expect(onDead).not.toHaveBeenCalled();

    watchdog.stop();
    vi.advanceTimersByTime(10 * HEARTBEAT_DEAD_AFTER_MS);
    expect(onDead).not.toHaveBeenCalled();
  });
});
