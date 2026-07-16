// Process-global download coordinator for the on-device model manager (Sol P2). EXTRACTED out of
// `model-manager.tsx` so the single-active-download serialization is a MODULE-LEVEL singleton, not a
// per-component-instance `useRef`.
//
// The bug this fixes: the old re-entry guard (`downloadInFlightRef`) and the in-flight controller map
// (`activeDownloads`) were `useRef` values owned by ONE `ModelManagerOverlay` instance. The overlay is
// rendered only inside the `status === 'ready'` branch of `app/index.tsx`, so a host
// `ready → error → ready` transition UNMOUNTS the whole overlay while a download (download → hash →
// persist → cleanup) may still be running, then MOUNTS a fresh overlay whose `downloadInFlightRef` is
// `false` and whose `activeDownloads` is empty. That new instance could start a SECOND concurrent
// download — two large files written at once, two independent storage probes, and a clean-first orphan
// check racing the older transaction's not-yet-created orphan. The module-level orphan `Set` in
// `model-download.ts` prevented URI *overwrite* but did NOT make the transaction process-global.
//
// This coordinator OWNS the one active transaction and its `AbortController` for the transaction's ENTIRE
// lifetime — released ONLY when the transaction's own `finally` settles, never merely because a component
// unmounted. A second caller (a freshly-mounted overlay, or a same-tick double tap) is REFUSED while a
// transaction is active, so at most one download can ever run process-wide. The clean-first orphan step
// (`clearRetainedOrphans`) runs INSIDE the coordinated region, so an old transaction's orphan — created
// even after a new overlay has mounted — is guaranteed to be cleaned before any later download begins.

import { clearRetainedOrphans } from './model-download';

/** The AbortController of the currently-running transaction, or `null` when idle. This single reference
 * IS the mutex: a non-null value means "a download transaction is in flight process-wide". It is set
 * SYNCHRONOUSLY at the top of `runDownload` (before any `await`) and cleared ONLY in that call's own
 * `finally`, so two synchronous `runDownload` calls — e.g. two overlay instances, or a same-tick double
 * tap — can never both acquire it. */
let activeController: AbortController | null = null;

/** Subscribers notified whenever `isDownloadActive()` flips, so a freshly-mounted overlay can render the
 * correct in-flight (disabled-buttons) state even though it didn't start the transaction itself. */
const activeListeners = new Set<() => void>();

/**
 * The outcome of a {@link runDownload} call. A discriminated union rather than the raw `T | 'busy'`
 * sentinel so a body whose own return type is a string can never be confused with the refusal signal,
 * and so the two non-completion reasons the caller must message differently stay distinct:
 *   - `'completed'`      — this call acquired the mutex and `run` ran to completion; `value` is its result.
 *   - `'busy'`           — REFUSED: another transaction was already active, so `run` was NEVER invoked.
 *   - `'orphan-blocked'` — this call acquired the mutex, but a retained orphan from a prior failed
 *                          download+cleanup still couldn't be removed, so `run` was NOT invoked (starting a
 *                          new download would let orphans accumulate — see `clearRetainedOrphans`).
 */
export type RunDownloadOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'busy' }
  | { status: 'orphan-blocked'; error: string };

/** Whether a download transaction is in flight process-wide. Read by a mounting overlay to seed its
 * disabled-controls state, and re-read on every `subscribeDownloadActive` notification. */
export function isDownloadActive(): boolean {
  return activeController !== null;
}

/**
 * Subscribe to changes in {@link isDownloadActive}. `listener` is called (with no arguments — read the
 * current value via `isDownloadActive()`) each time a transaction starts or finishes. Returns an
 * unsubscribe function. A newly-mounted overlay uses this so its download controls reflect a transaction
 * a PREVIOUS overlay instance started and that is still settling.
 */
export function subscribeDownloadActive(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

/** Notify every active-state subscriber. Iterates a snapshot so a listener that unsubscribes (or
 * subscribes) during notification can't perturb the loop, and swallows a listener throw so one bad
 * subscriber can never wedge the coordinator or strand the mutex mid-release. */
function notifyActiveChanged(): void {
  for (const listener of [...activeListeners]) {
    try {
      listener();
    } catch {
      // a subscriber must never break the coordinator's bookkeeping
    }
  }
}

/**
 * Run one download transaction under the process-global mutex. If a transaction is ALREADY active this
 * REFUSES immediately (`{ status: 'busy' }`) without invoking `run` — this is what stops a second overlay
 * instance, or a same-tick double tap, from starting a concurrent download. Otherwise it:
 *   1. Mints the transaction's `AbortController` and marks the coordinator active (notifying subscribers).
 *   2. Cleans EVERY retained orphan first (`clearRetainedOrphans`) and, if any still can't be removed,
 *      REFUSES to start the download (`{ status: 'orphan-blocked' }`) so orphans never accumulate. Because
 *      this runs inside the mutex, an older transaction's orphan — even one created after a new overlay
 *      mounted — is already recorded by the time this later call reaches here, so it is cleaned first.
 *   3. Invokes `run(signal)` — the caller's storage re-probe + download + registration + per-outcome
 *      cleanup — passing the transaction's `AbortSignal` so the caller (or `abortActiveDownload`, or the
 *      app-backgrounded handler) can cancel it.
 * The mutex is released — and subscribers re-notified — ONLY in this call's own `finally`, so it stays held
 * across an abort until the aborted `run` actually settles. A refused (`'busy'`) call touches no state and
 * skips the `finally` entirely (it never acquired the mutex).
 */
export async function runDownload<T>(run: (signal: AbortSignal) => Promise<T>): Promise<RunDownloadOutcome<T>> {
  if (activeController !== null) {
    return { status: 'busy' };
  }
  const controller = new AbortController();
  activeController = controller;
  notifyActiveChanged();
  try {
    // Clean any orphan(s) left by an earlier download whose registration AND checked-delete both failed,
    // BEFORE minting a new file — and refuse the download if one still can't be removed. Inside the mutex,
    // so an older transaction's just-created orphan is guaranteed already recorded and cleaned here.
    const cleared = await clearRetainedOrphans();
    if (!cleared.ok) {
      return { status: 'orphan-blocked', error: cleared.error };
    }
    const value = await run(controller.signal);
    return { status: 'completed', value };
  } finally {
    activeController = null;
    notifyActiveChanged();
  }
}

/**
 * Abort the active transaction's `AbortController` WITHOUT releasing the mutex — for a component that
 * started a download and is unmounting (or the app backgrounding). The mutex stays held until the aborted
 * transaction's `run` reacts to the signal, settles, and lets `runDownload`'s `finally` clear it; so a new
 * overlay that mounts before the aborted download has finished cleaning up still gets `'busy'` and cannot
 * start a second download. A no-op when no transaction is active.
 */
export function abortActiveDownload(): void {
  activeController?.abort();
}

/**
 * TEST-ONLY: force the coordinator back to idle for isolation between test cases (there is no
 * corresponding production reset — production always releases via `runDownload`'s `finally`). Never call
 * this from app code. Kept minimal and clearly namespaced so it can't be mistaken for a real API.
 */
export function resetDownloadCoordinatorForTests(): void {
  activeController = null;
  activeListeners.clear();
}
