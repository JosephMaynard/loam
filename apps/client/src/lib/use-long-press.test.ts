import { describe, expect, it, vi } from "vitest";

import { createLongPress, LONG_PRESS_DELAY_MS, type LongPressTimers, type PointerLike } from "./use-long-press";

/** A manual clock: timers fire only when `advance` passes their due time. */
function fakeTimers(): LongPressTimers & { advance: (ms: number) => void } {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { due: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.due <= now) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
  };
}

function touch(x = 100, y = 100, pointerId = 1): PointerLike {
  return { pointerId, pointerType: "touch", clientX: x, clientY: y };
}

describe("createLongPress", () => {
  it("fires after the delay when the finger stays put, and swallows the click that follows", () => {
    const timers = fakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress(onLongPress, {}, timers);

    press.down(touch());
    timers.advance(LONG_PRESS_DELAY_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    timers.advance(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    press.up();
    expect(press.consumeFired()).toBe(true);
    // Only one click is swallowed.
    expect(press.consumeFired()).toBe(false);
  });

  it("does not fire on a short tap, and lets its click through", () => {
    const timers = fakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress(onLongPress, {}, timers);

    press.down(touch());
    timers.advance(200);
    press.up();
    timers.advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(press.consumeFired()).toBe(false);
  });

  it("is cancelled by moving past the tolerance (a scroll), but not by a small wobble", () => {
    const timers = fakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress(onLongPress, {}, timers);

    press.down(touch(100, 100));
    press.move(touch(104, 106)); // ~7px: still a press
    expect(press.pressing()).toBe(true);
    press.move(touch(100, 115)); // 15px: a scroll
    expect(press.pressing()).toBe(false);
    timers.advance(LONG_PRESS_DELAY_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("is cancelled by pointercancel (the browser took the touch for scrolling)", () => {
    const timers = fakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress(onLongPress, {}, timers);

    press.down(touch());
    press.cancel();
    timers.advance(LONG_PRESS_DELAY_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("ignores the mouse (desktop has the hover toolbar) and other pointers' moves", () => {
    const timers = fakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress(onLongPress, {}, timers);

    press.down({ pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0 });
    timers.advance(LONG_PRESS_DELAY_MS);
    expect(onLongPress).not.toHaveBeenCalled();

    press.down(touch(100, 100, 7));
    press.move(touch(300, 300, 8)); // a second finger doesn't cancel the first
    timers.advance(LONG_PRESS_DELAY_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a click that arrives long after the release", () => {
    const timers = fakeTimers();
    const press = createLongPress(() => {}, {}, timers);

    press.down(touch());
    timers.advance(LONG_PRESS_DELAY_MS);
    press.up();
    timers.advance(5000);
    expect(press.consumeFired()).toBe(false);
  });

  it("honours a custom delay", () => {
    const timers = fakeTimers();
    const onLongPress = vi.fn();
    const press = createLongPress(onLongPress, { delay: 100 }, timers);
    press.down(touch());
    timers.advance(100);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
