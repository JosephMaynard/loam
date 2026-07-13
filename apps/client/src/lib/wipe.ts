/**
 * Device-wipe coordinator (docs/20). The wipe has to be robust across the whole browser lifecycle, not
 * just the single tab that initiates it:
 *
 *  - **Durable tombstone.** A wipe that can't fully finish server-side (the HttpOnly cookie cleanup is
 *    blackhole-able) must not let the wiped identity silently return on a later reload. So a persistent
 *    `loam.wipeTombstone` flag is set at wipe start and survives reloads; while it's set, boot shows a
 *    "rejoin" gate instead of auto-connecting. It's cleared only when the server credential cleanup is
 *    CONFIRMED, or when the user explicitly rejoins.
 *  - **Cross-tab.** A wipe in one tab must reach every other open tab (otherwise a second tab keeps the
 *    old data on screen, keeps writing, and even blocks the IndexedDB deletion). A BroadcastChannel
 *    announces the wipe; each tab runs its own local purge on receipt.
 *
 * This module owns those two lifecycle primitives (both unit-testable in isolation); the React layer wires
 * its own state teardown to them.
 */

/** Persistent "a wipe is incomplete — do not auto-reconnect" flag. Survives reloads (unlike the in-memory
 * store latch), so a deferred/failed server-side cleanup can't be forgotten on the next launch. */
const WIPE_TOMBSTONE_KEY = "loam.wipeTombstone";

/** BroadcastChannel name for cross-tab wipe propagation. */
const WIPE_CHANNEL_NAME = "loam-wipe";

/** Whether a wipe is outstanding (its server-side cleanup hasn't confirmed and the user hasn't rejoined).
 * Boot consults this BEFORE rendering the normal app. */
export function isWipeTombstoned(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(WIPE_TOMBSTONE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Raise the durable tombstone at the start of a wipe. */
export function setWipeTombstone(): void {
  try {
    localStorage.setItem(WIPE_TOMBSTONE_KEY, "1");
  } catch {
    // ignore — a missing/blocked localStorage just means the tombstone can't persist across reloads
  }
}

/** Clear the tombstone — only on CONFIRMED server-side credential cleanup, or an explicit rejoin. */
export function clearWipeTombstone(): void {
  try {
    localStorage.removeItem(WIPE_TOMBSTONE_KEY);
  } catch {
    // ignore
  }
}

/** Announce a wipe to every other tab of this origin (best-effort; a browser without BroadcastChannel
 * simply doesn't propagate — the initiating tab still wipes itself). */
export function announceWipe(): void {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }
  const channel = new BroadcastChannel(WIPE_CHANNEL_NAME);
  try {
    channel.postMessage({ type: "wipe" });
  } finally {
    channel.close();
  }
}

/**
 * Subscribe to wipe announcements from OTHER tabs; `onWipe` runs when any tab initiates a wipe, so this
 * tab can tear down its own copy. Returns an unsubscribe function. No-op (returns a no-op) where
 * BroadcastChannel is unavailable.
 */
export function listenForRemoteWipe(onWipe: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") {
    return () => undefined;
  }
  const channel = new BroadcastChannel(WIPE_CHANNEL_NAME);
  const handler = (event: MessageEvent): void => {
    if ((event.data as { type?: unknown } | null)?.type === "wipe") {
      onWipe();
    }
  };
  channel.addEventListener("message", handler);
  return () => {
    channel.removeEventListener("message", handler);
    channel.close();
  };
}
