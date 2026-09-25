/**
 * WebSocket liveness (pre-release review 2026-09-25). A socket whose peer vanished — the phone left the
 * hotspot, the host slept, a NAT/AP dropped the flow — often never fires `close`: the browser only learns
 * the TCP connection is dead when it next tries to send, and a LOAM client never sends after its key
 * confirmation. It would sit "live" forever, silently missing every event.
 *
 * The server therefore sends a content-free `{ type: "ping" }` frame on every admitted socket every
 * {@link HEARTBEAT_INTERVAL_MS} (and once right after admission). This watchdog treats the socket as dead
 * after ~2 missed heartbeats, and re-checks on demand when the page becomes visible again or the device
 * comes back online (timers are throttled/frozen in the background, so the regular timer can be late).
 */

/** The server's heartbeat period — keep in step with `WS_HEARTBEAT_INTERVAL_MS` in the server's realtime.ts. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** No frame for this long after heartbeats started = dead (two missed beats plus network slack). */
export const HEARTBEAT_DEAD_AFTER_MS = 2 * HEARTBEAT_INTERVAL_MS + 10_000;
/** On an explicit re-check, a gap longer than this means at least one beat went missing. */
export const HEARTBEAT_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS + 5_000;
/** How long an explicit re-check waits for frames buffered while the page was frozen to be delivered. */
export const HEARTBEAT_RECHECK_GRACE_MS = 3_000;
/** A dead timer firing more than this after it was due ran late — the page was frozen or throttled — so
 * the silence may just be frames still queued behind the resume; it takes the re-check grace path instead. */
export const HEARTBEAT_LATE_TIMER_SLACK_MS = 2_000;

export interface LivenessWatchdog {
  /** A frame arrived on the socket; `heartbeat` when it was the server's ping. */
  frame(heartbeat: boolean): void;
  /** Re-check now (page visible again / back online): declares the socket dead if a beat went missing. */
  check(): void;
  /** Stop all timers (socket closed or replaced). */
  stop(): void;
}

export interface LivenessOptions {
  deadAfterMs?: number;
  staleAfterMs?: number;
  recheckGraceMs?: number;
  now?: () => number;
}

/**
 * Create a watchdog that calls `onDead` (at most once) when the socket stops hearing from the server.
 *
 * The watchdog stays DISARMED until the first heartbeat arrives: a node that predates heartbeats never
 * sends one, and must not see its healthy (if silent) sockets torn down every minute. Current nodes send a
 * heartbeat immediately on admission, so this costs nothing against them.
 */
export function createLivenessWatchdog(onDead: () => void, options: LivenessOptions = {}): LivenessWatchdog {
  const deadAfterMs = options.deadAfterMs ?? HEARTBEAT_DEAD_AFTER_MS;
  const staleAfterMs = options.staleAfterMs ?? HEARTBEAT_STALE_AFTER_MS;
  const recheckGraceMs = options.recheckGraceMs ?? HEARTBEAT_RECHECK_GRACE_MS;
  const now = options.now ?? (() => Date.now());

  let armed = false;
  let stopped = false;
  let lastSeen = now();
  let deadTimer: ReturnType<typeof setTimeout> | undefined;
  let deadDueAt = 0;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;

  /** Wait `recheckGraceMs` for frames buffered while the page was frozen before concluding nothing came. */
  function recheckAfterGrace(): void {
    if (recheckTimer !== undefined) {
      return;
    }
    const checkedAt = now();
    recheckTimer = setTimeout(() => {
      recheckTimer = undefined;
      if (lastSeen < checkedAt) {
        declareDead();
      }
    }, recheckGraceMs);
  }

  function onDeadTimer(): void {
    deadTimer = undefined;
    // Fired well past its due time: the page was frozen (a backgrounded tab, a suspended WebView), and the
    // frames the server sent meanwhile are only now being delivered. Give them the grace window rather than
    // dropping a healthy socket on resume.
    if (now() - deadDueAt > HEARTBEAT_LATE_TIMER_SLACK_MS) {
      recheckAfterGrace();
      return;
    }
    declareDead();
  }

  function declareDead(): void {
    if (stopped) {
      return;
    }
    stop();
    onDead();
  }

  function stop(): void {
    stopped = true;
    if (deadTimer !== undefined) {
      clearTimeout(deadTimer);
      deadTimer = undefined;
    }
    if (recheckTimer !== undefined) {
      clearTimeout(recheckTimer);
      recheckTimer = undefined;
    }
  }

  return {
    frame(heartbeat) {
      if (stopped) {
        return;
      }
      lastSeen = now();
      armed ||= heartbeat;
      if (!armed) {
        return;
      }
      if (deadTimer !== undefined) {
        clearTimeout(deadTimer);
      }
      deadDueAt = lastSeen + deadAfterMs;
      deadTimer = setTimeout(onDeadTimer, deadAfterMs);
    },
    check() {
      if (stopped || !armed || now() - lastSeen <= staleAfterMs) {
        return;
      }
      // Frames the browser buffered while the page was frozen are dispatched right after it resumes — give
      // them a moment before concluding nothing is coming.
      recheckAfterGrace();
    },
    stop,
  };
}
