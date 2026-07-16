// Sol P2: the process-global download coordinator. Proves the single-active-download mutex is owned at
// MODULE level (not by a component instance), so a `ready → error → ready` overlay unmount/remount can
// never start a second concurrent download while the first transaction is still settling.
//
// What is NOT covered here (and cannot be, in the node-only harness): the `.tsx` wiring in
// `model-manager.tsx` — the unmount effect that calls `abortActiveDownload()`, the `mountedRef` guard on
// async setState, and the `subscribeDownloadActive`-driven `downloadInFlight` render state. Those are
// typecheck/review-only. Everything that carries the SERIALIZATION / abort / orphan-clean-first
// correctness lives in `download-coordinator.ts` and is exercised below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileSystemMock, resetFileSystemMock, seedFile } from '@/test-utils/mocks';

// `download-coordinator.ts` imports `clearRetainedOrphans` from `model-download.ts`, which imports
// `expo-file-system/legacy` (→ react-native) at module load. Replace it with the in-memory fake so the
// real native module (and its Flow-typed react-native transitive) never loads under Vitest's node env.
vi.mock('expo-file-system/legacy', () => fileSystemMock);

import {
  abortActiveDownload,
  isDownloadActive,
  resetDownloadCoordinatorForTests,
  runDownload,
  subscribeDownloadActive,
} from '@/lib/download-coordinator';
import { clearRetainedOrphans, retainedOrphanCount, retainOrphanUri } from '@/lib/model-download';

const MODELS_DIR = `${fileSystemMock.documentDirectory}models/`;

/** A manually-settleable promise, so a test can hold a transaction "in flight" (mid-download) and then
 * release it deterministically — the coordinator's single-flight and abort semantics are all about what
 * happens WHILE a transaction hasn't settled yet. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let all currently-queued microtasks drain so a `runDownload` whose body has resolved can reach its
 * own `finally` (which releases the mutex) before the test asserts. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  resetDownloadCoordinatorForTests();
  resetFileSystemMock();
  // Drain any orphan URIs a prior test retained (the registry is module-level in model-download.ts).
  await clearRetainedOrphans();
});

afterEach(() => {
  resetDownloadCoordinatorForTests();
});

describe('runDownload single-flight mutex', () => {
  it('refuses a second transaction while the first is still in flight (unmount → remount)', async () => {
    // "First overlay instance" starts a download that hasn't settled yet.
    const first = deferred<void>();
    const firstRun = vi.fn(async () => {
      await first.promise;
    });
    const firstOutcome = runDownload(firstRun);
    await flush();

    expect(isDownloadActive()).toBe(true);
    expect(firstRun).toHaveBeenCalledTimes(1);

    // Simulate the overlay unmounting (aborting the starter) and a fresh overlay remounting and trying
    // to download again. The remount's attempt must be REFUSED — not run — while the first is unsettled.
    abortActiveDownload();
    const secondRun = vi.fn(async () => {});
    const second = await runDownload(secondRun);

    expect(second).toEqual({ status: 'busy' });
    expect(secondRun).not.toHaveBeenCalled();
    expect(isDownloadActive()).toBe(true);

    // Only once the first transaction's body settles does the mutex release.
    first.resolve();
    expect(await firstOutcome).toEqual({ status: 'completed', value: undefined });
    await flush();
    expect(isDownloadActive()).toBe(false);
  });

  it('a ready→error→ready transition (abort + new runDownload) does not create a second transaction', async () => {
    const first = deferred<void>();
    const firstRun = vi.fn(async () => {
      await first.promise;
    });
    const firstOutcome = runDownload(firstRun);
    await flush();

    // ready → error: the overlay unmounts and aborts its own transaction.
    abortActiveDownload();

    // → ready: a new overlay mounts and immediately tries a download. Still refused: the aborted
    // transaction hasn't settled, so its mutex is still held.
    const remountRun = vi.fn(async () => {});
    expect(await runDownload(remountRun)).toEqual({ status: 'busy' });
    expect(remountRun).not.toHaveBeenCalled();
    expect(firstRun).toHaveBeenCalledTimes(1);

    first.resolve();
    await firstOutcome;
    await flush();
    expect(isDownloadActive()).toBe(false);
  });

  it('the download body executes at most once across two instances racing the same tick', async () => {
    const gate = deferred<void>();
    const body = vi.fn(async () => {
      await gate.promise;
    });

    // Two synchronous calls in the SAME tick (a catalog row + the custom button, or two overlay
    // instances) — the process-global mutex admits exactly one.
    const a = runDownload(body);
    const b = runDownload(body);

    expect(await b).toEqual({ status: 'busy' });
    await flush();
    expect(body).toHaveBeenCalledTimes(1);

    gate.resolve();
    expect(await a).toEqual({ status: 'completed', value: undefined });
  });
});

describe('abortActiveDownload', () => {
  it('aborts the active controller but holds the mutex until the aborted transaction settles', async () => {
    const settle = deferred<void>();
    let observedAbort = false;
    const outcome = runDownload(async (signal) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
      });
      await settle.promise;
    });
    await flush();
    expect(isDownloadActive()).toBe(true);

    // Unmount aborts the controller — the body observes the signal…
    abortActiveDownload();
    await flush();
    expect(observedAbort).toBe(true);
    // …but the mutex is STILL held: a new download is refused until the aborted body's `finally` settles.
    expect(isDownloadActive()).toBe(true);
    expect(await runDownload(async () => {})).toEqual({ status: 'busy' });

    // The aborted body finishes its cleanup — now the mutex releases and a new download can proceed.
    settle.resolve();
    await outcome;
    await flush();
    expect(isDownloadActive()).toBe(false);
    const nextRun = vi.fn(async () => {});
    expect(await runDownload(nextRun)).toEqual({ status: 'completed', value: undefined });
    expect(nextRun).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no transaction is active', () => {
    expect(isDownloadActive()).toBe(false);
    expect(() => abortActiveDownload()).not.toThrow();
    expect(isDownloadActive()).toBe(false);
  });
});

describe('clean-first orphan handling inside the coordinated transaction', () => {
  it("cleans an old transaction's orphan (created after a new caller mounts) before any later download", async () => {
    // First transaction downloads, fails to register, and retains its file as an orphan just before it
    // settles — i.e. AFTER a would-be new overlay has already mounted and is waiting on the mutex.
    const orphanUri = `${MODELS_DIR}orphan.gguf`;
    const first = deferred<void>();
    const firstOutcome = runDownload(async () => {
      await first.promise;
      seedFile(orphanUri, 'leftover multi-GB bytes');
      retainOrphanUri(orphanUri);
    });
    await flush();
    expect(isDownloadActive()).toBe(true);

    // A second caller tries to start while the first is still in flight — refused.
    expect(await runDownload(async () => {})).toEqual({ status: 'busy' });

    // The first transaction produces its orphan and settles.
    first.resolve();
    await firstOutcome;
    await flush();
    expect(retainedOrphanCount()).toBe(1);
    expect((await fileSystemMock.getInfoAsync(orphanUri)).exists).toBe(true);

    // Now a later download proceeds. Its body must only run AFTER the orphan has been cleaned first.
    let orphanStillPresentWhenBodyRan: boolean | undefined;
    const laterOutcome = await runDownload(async () => {
      orphanStillPresentWhenBodyRan = (await fileSystemMock.getInfoAsync(orphanUri)).exists;
    });

    expect(laterOutcome).toEqual({ status: 'completed', value: undefined });
    expect(orphanStillPresentWhenBodyRan).toBe(false);
    expect(retainedOrphanCount()).toBe(0);
    expect((await fileSystemMock.getInfoAsync(orphanUri)).exists).toBe(false);
  });

  it("refuses the download (without running the body) when a retained orphan can't be removed", async () => {
    // Retain an orphan whose file DOESN'T exist as a deletable entry but whose delete is forced to fail,
    // so `clearRetainedOrphans` can't clear it and the coordinator must block the new download.
    const orphanUri = `${MODELS_DIR}stuck.gguf`;
    seedFile(orphanUri, 'bytes');
    retainOrphanUri(orphanUri);
    const { failFileSystemUri } = await import('@/test-utils/mocks');
    failFileSystemUri(orphanUri, new Error('read-only mount'));

    const body = vi.fn(async () => {});
    const outcome = await runDownload(body);

    expect(outcome.status).toBe('orphan-blocked');
    expect(body).not.toHaveBeenCalled();
    // The mutex is released after an orphan-blocked refusal (it ran the coordinated region and finished).
    expect(isDownloadActive()).toBe(false);
    expect(retainedOrphanCount()).toBe(1);
  });
});

describe('isDownloadActive subscription', () => {
  it('notifies subscribers on start and finish, reflecting the true in-flight state', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeDownloadActive(() => {
      seen.push(isDownloadActive());
    });

    const gate = deferred<void>();
    const outcome = runDownload(async () => {
      await gate.promise;
    });
    await flush();
    // A subscriber saw the transition to active.
    expect(seen).toContain(true);
    expect(isDownloadActive()).toBe(true);

    gate.resolve();
    await outcome;
    await flush();
    // …and the transition back to idle.
    expect(seen[seen.length - 1]).toBe(false);
    expect(isDownloadActive()).toBe(false);

    // A late-mounting subscriber can read the current (idle) state directly.
    const late: boolean[] = [];
    const unsubscribeLate = subscribeDownloadActive(() => late.push(isDownloadActive()));
    const nextGate = deferred<void>();
    const nextOutcome = runDownload(async () => {
      await nextGate.promise;
    });
    await flush();
    expect(late).toContain(true);

    // Unsubscribing stops further notifications.
    unsubscribe();
    unsubscribeLate();
    nextGate.resolve();
    await nextOutcome;
    await flush();
    expect(isDownloadActive()).toBe(false);
  });
});
