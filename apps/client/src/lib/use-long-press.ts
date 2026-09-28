/**
 * Long-press detection for touch (and pen) pointers, the gesture chat apps use to open a message's
 * actions. Pointer events only, no touch/mouse split. A mouse never long-presses: desktop gets the hover
 * toolbar instead, and holding the button down there is how people select text.
 *
 * The press is cancelled by moving more than `tolerance` px (the finger is scrolling or selecting), by
 * `pointercancel` (the browser took the touch over for a scroll), or by lifting early. When a press does
 * fire, the click the browser sends on release is swallowed, so a long-press on a link or an image opens
 * the actions without also following it, and Android's native context menu is suppressed.
 */
import { useEffect, useRef } from "preact/hooks";

/** How long a finger must rest before the press counts (ms). Android's own threshold is 400–500. */
export const LONG_PRESS_DELAY_MS = 450;
/** How far (CSS px) a finger may drift before the press is treated as a scroll instead. */
export const LONG_PRESS_TOLERANCE_PX = 10;

/** The fields of a `PointerEvent` the detector reads (plain objects in tests). */
export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface LongPressOptions {
  delay?: number;
  tolerance?: number;
}

/** Clock and timer functions, injectable so the detector can be tested without a DOM. */
export interface LongPressTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface LongPressController {
  down: (event: PointerLike) => void;
  move: (event: PointerLike) => void;
  up: () => void;
  cancel: () => void;
  /** A press is being held and hasn't fired or been cancelled yet. */
  pressing: () => boolean;
  /** The current (or just released) press fired. Doesn't reset anything. */
  fired: () => boolean;
  /**
   * Whether the click arriving now belongs to a press that fired; reading it resets it, so exactly one
   * click is swallowed. A click long after the release (a keyboard activation, say) is never swallowed.
   */
  consumeFired: () => boolean;
}

/** A fired press swallows only a click that arrives this soon after the finger lifts (ms). */
const CLICK_AFTER_RELEASE_MS = 800;

const defaultTimers: LongPressTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
};

/**
 * The framework-free detector behind `useLongPress`.
 *
 * @param onLongPress - Called once when a press has been held for `delay` ms without moving.
 * @param options - `delay` (ms) and `tolerance` (px).
 * @param timers - Clock and timers (default: the global ones).
 */
export function createLongPress(
  onLongPress: () => void,
  options: LongPressOptions = {},
  timers: LongPressTimers = defaultTimers,
): LongPressController {
  const delay = options.delay ?? LONG_PRESS_DELAY_MS;
  const tolerance = options.tolerance ?? LONG_PRESS_TOLERANCE_PX;
  let timer: unknown;
  let start: { id: number; x: number; y: number } | undefined;
  let fired = false;
  let releasedAt: number | undefined;

  function clear(): void {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
    start = undefined;
  }

  return {
    down(event) {
      clear();
      fired = false;
      releasedAt = undefined;
      if (event.pointerType === "mouse") {
        return;
      }
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      timer = timers.setTimeout(() => {
        timer = undefined;
        start = undefined;
        fired = true;
        onLongPress();
      }, delay);
    },
    move(event) {
      if (!start || event.pointerId !== start.id) {
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx * dx + dy * dy > tolerance * tolerance) {
        clear();
      }
    },
    up() {
      clear();
      if (fired) {
        releasedAt = timers.now();
      }
    },
    cancel: clear,
    pressing: () => start !== undefined,
    fired: () => fired,
    consumeFired() {
      const value = fired && (releasedAt === undefined || timers.now() - releasedAt <= CLICK_AFTER_RELEASE_MS);
      fired = false;
      releasedAt = undefined;
      return value;
    },
  };
}

/**
 * Pointer handlers that call `onLongPress` after a steady touch press. Spread them onto the element that
 * should respond (the message bubble).
 *
 * @param onLongPress - What a long press does (the latest closure is always used).
 * @param options - `delay` (ms) and `tolerance` (px).
 */
export function useLongPress(onLongPress: () => void, options: LongPressOptions = {}) {
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;
  const controllerRef = useRef<LongPressController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createLongPress(() => {
      // A short buzz where the platform allows it: the confirmation people expect from a long press.
      try {
        navigator.vibrate?.(10);
      } catch {
        // Some WebViews throw when vibration isn't permitted; the gesture works without it.
      }
      callbackRef.current();
    }, options);
  }

  useEffect(() => () => controllerRef.current?.cancel(), []);
  const controller = controllerRef.current;

  return {
    onPointerDown: (event: PointerEvent) => controller.down(event),
    onPointerMove: (event: PointerEvent) => controller.move(event),
    onPointerUp: () => controller.up(),
    onPointerCancel: () => controller.cancel(),
    onContextMenu: (event: Event) => {
      // Android raises its native "copy / open link" menu around the same moment; the sheet replaces it.
      if (controller.pressing() || controller.fired()) {
        event.preventDefault();
      }
    },
    onClickCapture: (event: Event) => {
      if (controller.consumeFired()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
