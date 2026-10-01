/**
 * Keep the app shell sized to the part of the screen the user can actually see.
 *
 * The "keyboard pushes everything off screen" bug came from laying the app out in `100dvh` blocks: when
 * the on-screen keyboard opened, the browser scrolled the whole DOCUMENT to bring the focused textarea into
 * view, taking the header with it and leaving a gap above the composer. The fix has three parts:
 *
 * 1. `index.html` asks for `interactive-widget=resizes-content`, so Chrome 108+ shrinks the layout viewport
 *    with the keyboard.
 * 2. The document can never scroll (`html, body { overflow: hidden }`, the shell is `position: fixed`), so
 *    only inner areas like `.message-list` scroll.
 * 3. This module mirrors `visualViewport.height` into the `--vvh` custom property on `:root` (and its
 *    `offsetTop` into `--vv-top`) for browsers that shrink only the VISUAL viewport (iOS Safari, older
 *    WebViews), and snaps the document back to the top if something scrolled it anyway.
 *
 * `onViewportResize` lets a component react when the visible height changes, e.g. the message list
 * re-pinning to the bottom when the keyboard opens.
 */

type ViewportListener = (height: number) => void;

const listeners = new Set<ViewportListener>();
let lastHeight: number | undefined;

/**
 * The visual viewport, unless the user has pinch-zoomed: a zoomed visual viewport is small because of the
 * zoom, not the keyboard, and sizing the shell to it would re-lay the whole app out on every zoom step.
 */
function unzoomedVisualViewport(win: Window): VisualViewport | undefined {
  const visual = win.visualViewport ?? undefined;
  return visual && visual.scale <= 1.01 ? visual : undefined;
}

/**
 * Write the current visible height (and the visual viewport's top offset) to `:root`, undo any document
 * scroll, and tell subscribers when the height changed. Safe to call as often as events fire.
 */
function sync(win: Window): void {
  const visual = unzoomedVisualViewport(win);
  const height = Math.round(visual?.height ?? win.innerHeight);
  const top = Math.max(0, Math.round(visual?.offsetTop ?? 0));
  const root = win.document.documentElement;
  root.style.setProperty("--vvh", `${height}px`);
  root.style.setProperty("--vv-top", `${top}px`);

  // The document is never meant to scroll; a browser that scrolled it to reveal a focused field would
  // push the header off screen, so put it back. (The visual-viewport offset is handled by `--vv-top`.)
  const scrolled = win.scrollY || win.document.documentElement.scrollTop || win.document.body?.scrollTop || 0;
  if (scrolled) {
    win.scrollTo(0, 0);
  }

  if (height !== lastHeight) {
    lastHeight = height;
    for (const listener of listeners) {
      listener(height);
    }
  }
}

/**
 * Inside the Android host (`apps/app`) the native layout already keeps the WebView clear of the status bar
 * and the navigation bar, yet the WebView still reports those bars as `safe-area-inset-*` — padding for
 * them again left a blank band above the header and below the composer. Mark `<html data-native-host>`
 * so tokens.css zeroes the `--safe-*` insets there. `ReactNativeWebView` exists from document start, only
 * inside that WebView.
 */
function markNativeHost(win: Window): void {
  if ((win as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView) {
    win.document.documentElement.setAttribute("data-native-host", "");
  }
}

/**
 * Start mirroring the visible viewport into `--vvh` / `--vv-top`. Call once at boot (see `main.tsx`).
 *
 * @param win - The window to watch (injectable for tests).
 * @returns A function that stops watching.
 */
export function installViewportSync(win: Window = window): () => void {
  markNativeHost(win);
  const handler = (): void => sync(win);
  const visual = win.visualViewport;
  visual?.addEventListener("resize", handler);
  visual?.addEventListener("scroll", handler);
  // Fallbacks: browsers without visualViewport, orientation changes, and a document that scrolled anyway.
  win.addEventListener("resize", handler);
  win.addEventListener("scroll", handler);
  sync(win);

  return () => {
    visual?.removeEventListener("resize", handler);
    visual?.removeEventListener("scroll", handler);
    win.removeEventListener("resize", handler);
    win.removeEventListener("scroll", handler);
    lastHeight = undefined;
  };
}

/**
 * Subscribe to changes of the visible viewport height (keyboard open/close, rotation, window resize).
 * Fires only when the rounded height actually changes, after `--vvh` has been updated.
 *
 * @param callback - Receives the new visible height in CSS pixels.
 * @returns A function that unsubscribes.
 */
export function onViewportResize(callback: ViewportListener): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
