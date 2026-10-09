/**
 * Coalesces arrivals into one screen-reader announcement per quiet window. The first arrival opens the
 * window; everything that lands before it closes is handed over together, so a burst of messages reads as one
 * line ("3 new messages") instead of a stammer of separate announcements, each cut off by the next.
 */

/** How long after the first arrival the announcement is made (ms). */
export const ANNOUNCE_DELAY_MS = 1_200;

/** Timer source, injectable for tests. */
export interface CoalescerTimers {
  set: (run: () => void, ms: number) => number;
  clear: (id: number) => void;
}

const WINDOW_TIMERS: CoalescerTimers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (id) => window.clearTimeout(id),
};

export class ArrivalCoalescer<T> {
  private pending: T[] = [];
  private timer: number | undefined;
  private readonly emit: (items: T[]) => void;
  private readonly delayMs: number;
  private readonly timers: CoalescerTimers;

  /**
   * @param emit - Receives every arrival of one window, in order.
   * @param delayMs - The window length.
   * @param timers - Where the window's timer comes from (the page's `setTimeout` by default).
   */
  constructor(emit: (items: T[]) => void, delayMs = ANNOUNCE_DELAY_MS, timers: CoalescerTimers = WINDOW_TIMERS) {
    this.emit = emit;
    this.delayMs = delayMs;
    this.timers = timers;
  }

  /** Queue arrivals; opens the window if none is open. */
  add(items: readonly T[]): void {
    if (!items.length) {
      return;
    }
    this.pending.push(...items);
    if (this.timer === undefined) {
      this.timer = this.timers.set(() => this.flush(), this.delayMs);
    }
  }

  /** Close the window now: hand over what is pending (if anything). */
  flush(): void {
    this.timer = undefined;
    const items = this.pending;
    this.pending = [];
    if (items.length) {
      this.emit(items);
    }
  }

  /** Drop what is pending without announcing it (the list unmounted). */
  dispose(): void {
    if (this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }
}
