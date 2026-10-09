import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANNOUNCE_DELAY_MS, ArrivalCoalescer } from "./live-announcer";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ArrivalCoalescer", () => {
  it("announces a lone arrival once the quiet window closes", () => {
    const emit = vi.fn<(items: string[]) => void>();
    const coalescer = new ArrivalCoalescer(emit);
    coalescer.add(["a"]);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(["a"]);
  });

  it("reads a burst inside the window as one announcement", () => {
    const emit = vi.fn<(items: string[]) => void>();
    const coalescer = new ArrivalCoalescer(emit, 1_000);
    coalescer.add(["a"]);
    vi.advanceTimersByTime(300);
    coalescer.add(["b", "c"]);
    vi.advanceTimersByTime(300);
    coalescer.add(["d"]);
    vi.advanceTimersByTime(400);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(["a", "b", "c", "d"]);

    // The next arrival opens a fresh window.
    coalescer.add(["e"]);
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(["e"]);
  });

  it("dispose drops what is pending and cancels the timer; empty adds are ignored", () => {
    const emit = vi.fn<(items: string[]) => void>();
    const coalescer = new ArrivalCoalescer(emit, 1_000);
    coalescer.add([]);
    coalescer.add(["a"]);
    coalescer.dispose();
    vi.advanceTimersByTime(5_000);
    expect(emit).not.toHaveBeenCalled();
  });
});
