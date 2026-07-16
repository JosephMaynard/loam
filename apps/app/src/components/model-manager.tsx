import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  formatBytes,
  probeDeviceCapabilities,
  ramFit,
  storageFit,
  type DeviceCapabilities,
} from '@/lib/device-capabilities';
import {
  deactivateAction,
  deleteAction,
  reconcilePendingActions,
  setActiveAction,
  type ModelActionDeps,
  type ModelActionResult,
} from '@/lib/model-manager-actions';
import {
  deleteModelFileChecked,
  downloadModel,
  prepareCustomModelDownload,
  sanitizeModelFileName,
  sweepOrphanedModelFiles,
} from '@/lib/model-download';
import { releaseActiveModelContext } from '@/lib/on-device-llm';
import { clearActiveModel, setActiveModel, type BridgeChannel } from '@/lib/model-manager-bridge';
import { MODEL_CATALOG, type ModelCatalogEntry } from '@/lib/model-catalog';
import {
  dispositionFromLoad,
  MODEL_LIST_UNREADABLE_MESSAGE,
  mutateModelManagerState,
  pendingProtectedUris,
  readModelManagerState,
  type DownloadedModel,
  type ModelManagerState,
} from '@/lib/model-manager-store';

/** In-flight download/verify progress, keyed by the same id used in `busy`/`state.downloaded`. `phase`
 * distinguishes the download from the (now real — P2-4/AF7) streaming-hash verification pass that
 * follows it for curated catalog entries, so the UI doesn't look hung between the two. */
type ProgressMap = Record<string, { written: number; total: number; phase: 'download' | 'verify' }>;

/** Runs `sweepOrphanedModelFiles` at most once per process lifetime (module-level, not component
 * state — the overlay itself stays mounted for the app's whole life, only `visible` toggles, see
 * `index.tsx`). Deliberately NOT re-run on every re-open: a file that's mid-download in THIS session
 * is legitimately unreferenced until it finishes, and re-sweeping while it's in flight would delete
 * it out from under an active download. An orphan from a killed process can only exist at the first
 * open after a fresh launch, so once is enough — see `model-download.ts`'s `sweepOrphanedModelFiles`
 * doc comment for why an orphan is safe to delete blindly (it was never registered as active).
 *
 * P2-7 round-4 fix: this used to be kicked off with `void` (fire-and-forget) while download controls
 * were already enabled, so a download started in the gap between "overlay opened" and "sweep
 * finished" could target a destination not yet in the `referencedUris` this sweep pass loaded — and
 * get deleted out from under `createDownloadResumable` mid-write. It's now AWAITED before
 * `sweepReady` flips true, and every download button is disabled until `sweepReady` is set (see the
 * `visible` effect and the button `disabled` props below). This is a second, independent guard on top
 * of `model-download.ts`'s `.partial`-suffix staging fix — either alone closes the race; both together
 * is cleanest (per the round-4 review note). */
let orphanSweepDone = false;

// A custom download whose file succeeded but then failed BOTH to persist AND to be checked-deleted leaves a
// multi-GB orphan on disk. Its URI is retained at MODULE level (CodeRabbit), not in component state, so it
// SURVIVES the overlay unmounting/remounting — otherwise closing and reopening the model manager would lose
// the reference and strand the orphan until an app restart. While it's set, every download entry point
// (custom AND catalog) must re-attempt the checked delete FIRST and abort the new download if it still can't
// be removed, so orphans can never accumulate. The per-process orphan sweep (`orphanSweepDone`) only runs
// once at first open, so it can't catch an orphan created afterward — this is that safety net.
let retainedCustomOrphanUri: string | undefined;

type ModelManagerOverlayProps = {
  visible: boolean;
  onClose: () => void;
  /** The nodejs-mobile channel (`nodejs.channel` from index.tsx) — same bridge on-device-llm.ts and
   * mesh-courier.ts use to talk to the launcher. */
  channel: BridgeChannel;
};

/**
 * The on-device LLM model manager: browse the curated GGUF catalog (docs/06), see whether each model
 * fits this device's RAM/storage, download/delete files, pick the active one, or paste a custom URL.
 * A full-screen modal in the same style as `HostShareOverlay` — purely additive to the host UI, and
 * harmless with no model downloaded (the server already treats an absent on-device model as a
 * graceful "no model configured" error, never a crash).
 */
export function ModelManagerOverlay({ visible, onClose, channel }: ModelManagerOverlayProps) {
  const theme = useTheme();
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [managerState, setManagerState] = useState<ModelManagerState>({ downloaded: [] });
  const [progress, setProgress] = useState<ProgressMap>({});
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [customUrl, setCustomUrl] = useState('');
  /** True while a pasted-URL download is running. Disables the "Add & download" button for its duration
   * so a second tap can't start a duplicate parallel download under a fresh id (the custom id is
   * generated per-call, so `busyIds` alone wouldn't gate the button). RENDER-only — the synchronous
   * re-entry guard is `customDownloadInFlightRef` below (state updates don't disable the button until the
   * next render, which is a tick too late; Fix 4). */
  const [customDownloadInFlight, setCustomDownloadInFlight] = useState(false);
  /** Synchronous mirror of `customDownloadInFlight` (Fix 4): two taps in the SAME tick both enter
   * `handleAddCustomUrl` before the disabled state re-renders, each minting a different id → two
   * multi-GB downloads in parallel. This ref is checked-and-set at the very top of the handler and
   * cleared in its `finally`, so the second synchronous tap short-circuits before starting anything. */
  const customDownloadInFlightRef = useRef(false);
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  /** Gates every download-start control (P2-7 round 4) until the orphan sweep below has actually
   * finished — initialized from the module-level flag so a remount after the sweep already ran once
   * doesn't re-block controls. */
  const [sweepReady, setSweepReady] = useState(orphanSweepDone);
  /** True while ANY activate/deactivate/delete transaction is running. Globally disables the
   * conflicting controls (Set active / Delete / Deactivate on every row, plus downloads) so two
   * transactions can't be started concurrently (P2-2) — a UI-level complement to the mutex in
   * `model-manager-actions.ts` that serializes them even if they somehow both start. */
  const [operationInFlight, setOperationInFlight] = useState(false);
  /** True while durable pending actions (P2-b) remain unsettled after a reconciliation pass — the
   * launcher couldn't be reached to confirm one or more earlier writes. Disables the action controls
   * (like `operationInFlight`) and surfaces a banner, until a later reopen's reconcile settles them. */
  const [pendingUnsettled, setPendingUnsettled] = useState(false);
  /** True when the persisted model list couldn't be READ on open (P1-4: `readModelManagerState` returned
   * `error` — an I/O failure or corruption that isn't a clean absence). The referenced-file set is
   * unknown, so the destructive orphan sweep is SKIPPED and the destructive controls (delete / set-active
   * / download) are BLOCKED, with a recovery banner — a transient read failure must never let the sweep
   * delete every downloaded `.gguf`. A later reopen retries the read and clears this. */
  const [loadFailed, setLoadFailed] = useState(false);
  // Every in-flight download/verify's `AbortController`, keyed by the same id used in `busyIds`/
  // `progress` — lets the AppState listener below cancel everything at once on backgrounding.
  const activeDownloads = useRef<Map<string, AbortController>>(new Map());

  /** The store + bridge + filesystem operations the activate/deactivate/delete/reconcile transactions
   * need, bound to the real implementations (the bridge fns partially applied with this overlay's
   * `channel`). Declared before the open-effect below so that effect can reconcile pending actions with
   * it. Memoized on `channel` so the transaction module sees a stable dependency object. */
  const actionDeps = useMemo<ModelActionDeps>(
    () => ({
      mutate: mutateModelManagerState,
      setActiveModel: (request) => setActiveModel(channel, request),
      clearActiveModel: () => clearActiveModel(channel),
      // CHECKED delete (Finding 1): the transaction relies on a byte-delete failure THROWING so it keeps
      // the durable delete-pending and retries, rather than reporting a model deleted while its file
      // silently remains on disk.
      deleteModelFile: deleteModelFileChecked,
    }),
    [channel],
  );

  // Refresh the probe + persisted state every time the manager is opened — storage/RAM and the
  // downloaded-file list can both change between visits.
  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    void (async () => {
      // RF6-d (Sol round 6): the whole open-effect body is wrapped so a rejection from ANY of
      // `probeDeviceCapabilities`/`loadModelManagerState`/`reconcilePendingActions`/
      // `sweepOrphanedModelFiles` can't skip the `setSweepReady(true)` below — which would leave every
      // download/action control permanently disabled AND surface an unhandled promise rejection. The
      // `finally` always flips `sweepReady` (the `.partial`-suffix staging fix in model-download.ts is
      // the independent guard that keeps enabling controls after a FAILED sweep safe).
      try {
        const [caps, loaded] = await Promise.all([probeDeviceCapabilities(), readModelManagerState()]);
        if (!cancelled) {
          setCapabilities(caps);
        }

        // P1-4: turn the discriminated load result into a disposition. On `error` (couldn't read the
        // state — an I/O failure or corruption, NOT a clean absence) the referenced-file set is unknown,
        // so `canSweep` is false and `controlsBlocked` is true: we must NOT run the destructive orphan
        // sweep (it would treat every `.gguf` as orphaned) and must block the destructive controls, with
        // a recovery banner. On `ok`/`empty` sweeping is safe.
        const disposition = dispositionFromLoad(loaded);
        if (!cancelled) {
          setLoadFailed(disposition.controlsBlocked);
          setManagerState(disposition.state);
          if (disposition.message) {
            setStatusMessage(disposition.message);
          }
        }
        if (!disposition.canSweep) {
          // Couldn't read the model list: skip reconciliation AND the sweep, preserving every file. The
          // controls stay blocked via `loadFailed`; a later reopen retries the read (the `finally` still
          // flips `sweepReady` so the "Preparing…" note clears, but downloads remain gated by `loadFailed`).
          return;
        }

        // Reconcile durable pending actions FIRST (P2-b), before the orphan sweep runs or any control is
        // enabled: re-send each unconfirmed launcher write (idempotent) and settle it. If every retry
        // still times out, the pending set survives and the affected files stay protected below. `current`
        // is the post-reconcile state the sweep and UI must use.
        let current = disposition.state;
        if ((current.pending ?? []).length > 0) {
          const reconciled = await reconcilePendingActions(actionDeps);
          if (reconciled.unreadable) {
            // RF7-b: reconcile's OWN state read refused (a transient I/O error / corruption AFTER this
            // open's initial load). Its returned `state` is an untrusted EMPTY_STATE — adopting it and
            // sweeping against it would delete every downloaded model. Treat it EXACTLY like the
            // direct-load `error` path: keep the last good state on screen (already set above), BLOCK the
            // destructive controls (`loadFailed`), SKIP the orphan sweep (the early return below), and
            // surface the recovery banner. A later reopen retries the read. The `finally` still flips
            // `sweepReady`, so the "Preparing…" note clears while downloads stay gated by `loadFailed`.
            if (!cancelled) {
              setLoadFailed(true);
              setStatusMessage(reconciled.message ?? MODEL_LIST_UNREADABLE_MESSAGE);
            }
            return;
          }
          current = reconciled.state;
          if (!cancelled) {
            setManagerState(reconciled.state);
            setPendingUnsettled(!reconciled.settled);
            if (reconciled.message) {
              setStatusMessage(reconciled.message);
            }
          }
        } else if (!cancelled) {
          setPendingUnsettled(false);
        }

        if (!orphanSweepDone) {
          // AWAITED (P2-7 round 4, was fire-and-forget `void`): reclaim any `.gguf` left behind by a
          // download whose verify/registration never finished because the app process was killed
          // mid-way (hash-performance device-verify note — see model-download.ts). Download controls
          // stay disabled (see `sweepReady` below) until this resolves, so nothing can start a download
          // whose destination this sweep pass might treat as unreferenced. The second arg (P2-b) keeps any
          // file a still-unsettled pending action references — most critically a pending `delete`'s
          // kept-for-now bytes — from being swept while the launcher may still point at it.
          await sweepOrphanedModelFiles(
            current.downloaded.map((model) => model.uri),
            pendingProtectedUris(current.pending),
          );
          orphanSweepDone = true;
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(
            `Could not fully prepare the model manager: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        if (!cancelled) {
          setSweepReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, actionDeps]);

  // Cancel every in-flight download/verify when the app is backgrounded, rather than letting it keep
  // running unattended (hash-performance device-verify note): Android can suspend or kill a
  // backgrounded app's JS thread at any time, and a multi-GB hash left running unobserved is exactly
  // the "corrupt state mid-verify" scenario Sol flagged. Aborting routes through the same fail-closed
  // path as a checksum mismatch (see model-download.ts), so it always deletes the partial file rather
  // than leaving something half-verified.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        for (const controller of activeDownloads.current.values()) {
          controller.abort();
        }
      }
    });
    return () => subscription.remove();
  }, []);

  const setBusy = (id: string, isBusy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (isBusy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const setModelProgress = (id: string, written: number, total: number, phase: 'download' | 'verify' = 'download') => {
    setProgress((prev) => ({ ...prev, [id]: { written, total, phase } }));
  };

  const clearModelProgress = (id: string) => {
    setProgress((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /**
   * Apply `mutate` on top of whatever is CURRENTLY persisted — never on top of this component's
   * possibly-stale `managerState` snapshot (P2-4: two downloads/activations finishing back-to-back
   * used to each build their next state from the state captured when THEIR OWN async op started, so
   * the last one to finish silently erased the other's write). `mutateModelManagerState` serializes
   * this against every other in-flight mutation and writes atomically; a failed write is surfaced
   * here (not swallowed) rather than letting the caller report success on a change that never landed.
   *
   * Only adopts the mutated result into the component's `managerState` when the write actually
   * landed (round-4 fix, adjacent to P2-4): the previous version called `setManagerState(state)`
   * UNCONDITIONALLY, so a failed disk write still left the on-screen state showing the optimistic
   * (never-persisted) mutation — a divergence between what's on screen and what's on disk, even
   * before any bridge call. Every caller already bails out on `!persisted` before doing anything
   * further, so leaving `managerState` untouched here is enough to keep the UI honest.
   */
  const persist = async (mutate: (current: ModelManagerState) => ModelManagerState): Promise<boolean> => {
    const { state, persisted } = await mutateModelManagerState(mutate);
    if (persisted) {
      setManagerState(state);
    } else {
      setStatusMessage("Couldn't save that change to the model list — it may not survive an app restart. Try again.");
    }
    return persisted;
  };

  /** Run one serialized activate/deactivate/delete transaction (see `model-manager-actions.ts`),
   * flipping `operationInFlight` (and the acting row's `busy`) around it and adopting the resulting
   * state + status message. All rollback / timeout-ambiguity handling lives in the transaction; here we
   * only surface its outcome. Returns the transaction's `ModelActionResult` so callers can react to the
   * confirmed-`'ok'` outcome — e.g. releasing the native context after a deactivate/active-delete (Fix 2). */
  const runOperation = async (
    busyId: string | undefined,
    action: () => Promise<ModelActionResult>,
  ): Promise<ModelActionResult> => {
    setOperationInFlight(true);
    if (busyId) {
      setBusy(busyId, true);
    }
    try {
      const outcome = await action();
      if (outcome.state) {
        setManagerState(outcome.state);
        // An ambiguous op leaves a durable pending action (P2-b); reflect that so the controls gate and
        // the next reopen reconciles it. A clean op (`state.pending` empty) clears the gate.
        setPendingUnsettled((outcome.state.pending ?? []).length > 0);
      }
      setStatusMessage(outcome.message);
      return outcome;
    } finally {
      if (busyId) {
        setBusy(busyId, false);
      }
      setOperationInFlight(false);
    }
  };

  /** Download one curated catalog entry into `<id>.gguf`, verifying size + (now real — P2-4/AF7)
   * streaming SHA-256, fail-closed on a mismatch or a hashing failure. */
  /** Before starting ANY new download, clear a retained custom-download orphan (CodeRabbit): re-attempt its
   * CHECKED delete and only proceed once it's confirmed gone. Returns false (and sets an honest status) if an
   * orphan is retained and still can't be removed — the caller MUST abort, so orphans never accumulate. */
  const clearRetainedOrphanOrAbort = async (): Promise<boolean> => {
    if (!retainedCustomOrphanUri) {
      return true;
    }
    try {
      await deleteModelFileChecked(retainedCustomOrphanUri);
      retainedCustomOrphanUri = undefined;
      return true;
    } catch (cleanupErr) {
      const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      setStatusMessage(
        `A previous custom download left a file that still can't be removed (${cleanupMessage}). Restart the app to clear it before downloading another model.`,
      );
      return false;
    }
  };

  const handleDownloadCatalogEntry = async (entry: ModelCatalogEntry) => {
    // Block a catalog download too while a custom orphan is retained — clean it first or abort (CodeRabbit).
    if (!(await clearRetainedOrphanOrAbort())) {
      return;
    }
    // Catalog ids are hardcoded, known-safe strings — this can't actually fail — but sanitize anyway
    // for consistency with the pasted-URL path and as defense in depth (see model-download.ts).
    const fileName = sanitizeModelFileName(`${entry.id}.gguf`);
    if (!fileName) {
      setStatusMessage(`${entry.displayName}: invalid catalog file name.`);
      return;
    }
    setBusy(entry.id, true);
    setModelProgress(entry.id, 0, entry.sizeBytes, 'download');
    const controller = new AbortController();
    activeDownloads.current.set(entry.id, controller);
    const outcome = await downloadModel(
      entry.url,
      fileName,
      entry.sizeBytes,
      entry.sha256,
      (written, total) => setModelProgress(entry.id, written, total > 0 ? total : entry.sizeBytes, 'download'),
      // Hashing a multi-GB file is slow — show its own progress rather than looking hung once the
      // download bar completes (P2-4/AF7).
      (hashed, total) => setModelProgress(entry.id, hashed, total, 'verify'),
      controller.signal,
    );
    activeDownloads.current.delete(entry.id);
    clearModelProgress(entry.id);
    setBusy(entry.id, false);

    if (!outcome.ok) {
      setStatusMessage(`${entry.displayName}: download failed — ${outcome.error}`);
      return;
    }
    const model: DownloadedModel = {
      id: entry.id,
      displayName: entry.displayName,
      uri: outcome.uri,
      sizeBytes: outcome.sizeBytes,
      sha256: entry.sha256,
      isCustom: false,
      sourceUrl: entry.url,
      downloadedAt: Date.now(),
    };
    const persisted = await persist((current) => ({
      ...current,
      downloaded: [...current.downloaded.filter((existing) => existing.id !== entry.id), model],
    }));
    if (persisted) {
      setStatusMessage(`${entry.displayName} downloaded.`);
    }
  };

  /** Download a user-pasted URL — no size/hash to verify against, so it's always best-effort + warned.
   * URL parsing/authorization/redaction is the pure `prepareCustomModelDownload` (Finding 2 — malformed
   * percent-escapes, userinfo, and credential/token redaction of the persisted `sourceUrl`), a
   * synchronous `useRef` guards against a same-tick double-tap (Fix 4), and a persist failure after a
   * successful download deletes the orphaned file with a CHECKED delete before offering retry — RETAINING
   * the URI and blocking another download until that checked delete succeeds if it can't (Finding 1). */
  const handleAddCustomUrl = async () => {
    // Fix 4: synchronous re-entry guard. Two taps in the SAME tick both reach here before the disabled
    // state re-renders; the ref is set/read synchronously so the second tap short-circuits immediately
    // instead of minting a second id and a second multi-GB download. The `finally` at the very bottom
    // clears it, so a validation early-return below re-enables the button just as a completed download does.
    if (customDownloadInFlightRef.current) {
      return;
    }
    customDownloadInFlightRef.current = true;
    try {
      // If a PRIOR custom download succeeded-then-failed-to-persist and its CHECKED cleanup also failed, an
      // orphan is still on disk (retained at module level so it survives an overlay remount). Re-attempt its
      // checked delete FIRST and abort if it still can't be removed, rather than minting a new id/filename
      // and piling on a SECOND multi-GB orphan.
      if (!(await clearRetainedOrphanOrAbort())) {
        return;
      }

      // Finding 2: all URL parsing/authorization/redaction lives in the pure `prepareCustomModelDownload`
      // (unit-tested in model-download.test.ts). It fails closed on a malformed percent-escape, rejects
      // userinfo, pins the host allowlist, and hands back a REDACTED `sourceUrl` (origin+pathname only) to
      // persist alongside the FULL `downloadUrl` to fetch with.
      const prepared = prepareCustomModelDownload(customUrl);
      if (!prepared.ok) {
        setStatusMessage(prepared.error);
        return;
      }

      // Free-storage gate (G9): a pasted URL has no known size ahead of time (unlike a catalog entry),
      // so RAM can't be checked and the exact-size storage check can't run either — but we can still
      // refuse when the device is already below the headroom floor `storageFit` uses for catalog
      // downloads, rather than skipping the gate entirely for custom URLs.
      if (capabilities && storageFit(capabilities, 0) === 'insufficient') {
        setStatusMessage(
          `Not enough free storage to download a model (only ${formatBytes(capabilities.freeStorageBytes)} free).`,
        );
        return;
      }

      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `${id}-${prepared.fileName}`;

      setCustomDownloadInFlight(true);
      setBusy(id, true);
      setModelProgress(id, 0, 0);
      const controller = new AbortController();
      activeDownloads.current.set(id, controller);
      // try/finally so a throw anywhere in the download (e.g. `downloadModel`'s dir-prep/stat before it
      // returns its `{ ok }` outcome) still clears the busy row, progress, and the AbortController rather
      // than leaving the row stuck busy + leaking the controller.
      try {
        const outcome = await downloadModel(
          prepared.downloadUrl,
          fileName,
          undefined,
          undefined,
          (written, total) => setModelProgress(id, written, total),
          undefined,
          controller.signal,
        );

        if (!outcome.ok) {
          setStatusMessage(`Custom model download failed — ${outcome.error}`);
          return;
        }
        const model: DownloadedModel = {
          id,
          displayName: prepared.displayName,
          uri: outcome.uri,
          sizeBytes: outcome.sizeBytes,
          isCustom: true,
          // REDACTED (Finding 2): origin+pathname only — never the pasted URL's credentials/query/hash.
          sourceUrl: prepared.sourceUrl,
          downloadedAt: Date.now(),
        };
        const persisted = await persist((current) => ({ ...current, downloaded: [...current.downloaded, model] }));
        if (persisted) {
          // Clear the input only on a fully successful download+persist — a persistence failure keeps the
          // entered URL so the operator can retry without re-typing it (CodeRabbit).
          setCustomUrl('');
          setStatusMessage(`${prepared.displayName} downloaded.`);
        } else {
          // Fix 5 + Finding 1: the final `.gguf` is on disk but NOT in `managerState`, and the
          // one-per-process orphan sweep already ran — so a retry (which mints a NEW id → a new file name)
          // would download a SECOND copy and leave this one orphaned until app restart. Delete the
          // just-downloaded file with a CHECKED delete BEFORE offering retry so no unreferenced final model
          // can accumulate. If the checked cleanup itself fails, the orphan is REAL: retain its URI so the
          // next add attempt cleans it FIRST (above), never reporting a clean disk when it isn't.
          try {
            await deleteModelFileChecked(outcome.uri);
            setStatusMessage(`${prepared.displayName} downloaded but couldn't be saved to the model list — the file was removed. Try again.`);
          } catch (cleanupErr) {
            const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            // Retain at MODULE level so it survives an overlay remount and blocks EVERY later download until
            // cleared (via `clearRetainedOrphanOrAbort`).
            retainedCustomOrphanUri = outcome.uri;
            setStatusMessage(
              `${prepared.displayName} downloaded but couldn't be saved to the model list, and removing the leftover file also failed (${cleanupMessage}). It'll be cleared on your next attempt, or restart the app to clear it.`,
            );
          }
        }
      } catch (err) {
        // A thrown download/persist (network stack error, storage failure) must surface a failure status,
        // not silently reject the promise and leave the operator staring at a cleared-but-unexplained row
        // (CodeRabbit). Aborts (the operator cancelled) are reported neutrally.
        const message = err instanceof Error ? err.message : String(err);
        setStatusMessage(`Custom model download failed — ${message}`);
      } finally {
        activeDownloads.current.delete(id);
        clearModelProgress(id);
        setBusy(id, false);
        setCustomDownloadInFlight(false);
      }
    } finally {
      // Fix 4: always release the synchronous re-entry guard — on a validation early-return, a completed
      // download, or a thrown error alike — so the next tap can start a fresh download.
      customDownloadInFlightRef.current = false;
    }
  };

  /**
   * Delete a downloaded model. The whole persist → bridge → rollback transaction now lives in
   * `model-manager-actions.ts` (`deleteAction`, P2-2), serialized against every other
   * activate/deactivate/delete op by that module's global mutex; here we just run it under
   * `operationInFlight` and surface the outcome. The transaction sequences the metadata removal, the
   * launcher clear (checked), and the IRREVERSIBLE byte delete so a failure at any step leaves a safe,
   * recoverable state — and never deletes the bytes when the launcher clear couldn't be confirmed.
   */
  const handleDelete = async (model: DownloadedModel) => {
    // Capture whether THIS is the active model before the transaction clears `activeId`, so a confirmed
    // delete of the active model releases the (multi-GB) native context (Fix 2). A stale metadata snapshot
    // is fine here — `managerState.activeId` is exactly what the operator sees when tapping Delete.
    const wasActive = managerState.activeId === model.id;
    const outcome = await runOperation(model.id, () => deleteAction(actionDeps, model));
    // Only on a CONFIRMED delete of the active model — never on `'rolled-back'`/`'ambiguous'`/
    // `'persist-failed'`, where the model may still be active. Fire-and-forget; it never throws.
    if (outcome.kind === 'ok' && wasActive) {
      void releaseActiveModelContext();
    }
  };

  /**
   * Make `model` the active on-device model. Delegates to `setActiveAction` (P2-2): persist the durable
   * local record FIRST, then mirror it to the launcher config, with a DEFINITE-failure-only conditional
   * rollback and — for a bridge TIMEOUT — no rollback at all (the write may have landed; P2-1). Runs
   * under the global operation mutex so it can't interleave with another op and clobber its selection.
   */
  const handleSetActive = (model: DownloadedModel) => runOperation(model.id, () => setActiveAction(actionDeps, model));

  /** Clear the active model — `deactivateAction` (P2-2), same serialized persist-then-mirror
   * transaction with conditional rollback on a definite failure and no rollback on a timeout. On a
   * CONFIRMED deactivate, release the native context so it doesn't stay resident until app restart
   * (Fix 2); never on `'rolled-back'`/`'ambiguous'`/`'persist-failed'`, where the model may still be active. */
  const handleDeactivate = async () => {
    const outcome = await runOperation(undefined, () => deactivateAction(actionDeps));
    if (outcome.kind === 'ok') {
      void releaseActiveModelContext();
    }
  };

  const customModels = managerState.downloaded.filter((model) => model.isCustom);
  /** Activate/deactivate/delete + download controls are disabled while an op is in flight (P2-2) OR
   * while durable pending actions remain unsettled (P2-b) — reconciliation couldn't reach the launcher,
   * so starting a NEW change (which could contradict an unconfirmed one) is gated until a reopen settles
   * them — OR when the persisted model list couldn't be read (P1-4, `loadFailed`): acting destructively
   * on an unknown model set risks deleting a file the launcher still points at. */
  const actionsBlocked = operationInFlight || pendingUnsettled || loadFailed;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <ThemedText type="subtitle">On-device model</ThemedText>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">Done</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <ThemedText type="small" themeColor="textSecondary">
                Optional and off by default. Download a small model to run LOAM&apos;s assistant fully
                on this phone, with no internet and no laptop needed. Everything below runs and stays
                on-device.
              </ThemedText>

              {capabilities ? (
                <ThemedView type="backgroundElement" style={styles.capabilityCard}>
                  <ThemedText type="smallBold">This device</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    RAM: {formatBytes(capabilities.totalRamBytes)} · Free storage:{' '}
                    {formatBytes(capabilities.freeStorageBytes)}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {capabilities.acceleratorNote}
                  </ThemedText>
                </ThemedView>
              ) : null}

              {statusMessage ? (
                <ThemedView type="backgroundSelected" style={styles.statusBanner}>
                  <ThemedText type="small">{statusMessage}</ThemedText>
                </ThemedView>
              ) : null}

              {managerState.activeId ? (
                <ThemedView type="backgroundElement" style={styles.capabilityCard}>
                  <ThemedText type="smallBold">
                    Active: {managerState.downloaded.find((m) => m.id === managerState.activeId)?.displayName ?? managerState.activeId}
                  </ThemedText>
                  <Pressable
                    onPress={() => void handleDeactivate()}
                    disabled={actionsBlocked}
                    accessibilityRole="button"
                    style={actionsBlocked ? styles.buttonDisabled : undefined}>
                    <ThemedText type="link">Deactivate</ThemedText>
                  </Pressable>
                </ThemedView>
              ) : null}

              <ThemedText type="smallBold" style={styles.sectionTitle}>
                Catalog
              </ThemedText>
              {!sweepReady ? (
                <ThemedText type="small" themeColor="textSecondary">
                  Preparing model storage…
                </ThemedText>
              ) : null}
              {MODEL_CATALOG.map((entry) => (
                <CatalogRow
                  key={entry.id}
                  entry={entry}
                  capabilities={capabilities}
                  downloaded={managerState.downloaded.find((model) => model.id === entry.id)}
                  isActive={managerState.activeId === entry.id}
                  isBusy={busyIds.has(entry.id)}
                  progress={progress[entry.id]}
                  downloadDisabled={!sweepReady || actionsBlocked}
                  opInFlight={actionsBlocked}
                  onDownload={() => void handleDownloadCatalogEntry(entry)}
                  onDelete={(model) => void handleDelete(model)}
                  onSetActive={(model) => void handleSetActive(model)}
                />
              ))}

              <ThemedText type="smallBold" style={styles.sectionTitle}>
                Add a model by URL
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Unverified model — may not download, load, or run correctly. Use a direct link to a
                `.gguf` file.
              </ThemedText>
              <TextInput
                value={customUrl}
                onChangeText={setCustomUrl}
                placeholder="https://…/model.gguf"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[styles.textInput, { color: theme.text, borderColor: theme.textSecondary }]}
              />
              <Pressable
                onPress={() => void handleAddCustomUrl()}
                disabled={!customUrl.trim() || !sweepReady || actionsBlocked || customDownloadInFlight}
                accessibilityRole="button"
                style={[
                  styles.button,
                  (!customUrl.trim() || !sweepReady || actionsBlocked || customDownloadInFlight) &&
                    styles.buttonDisabled,
                ]}>
                <ThemedText type="smallBold" style={styles.buttonLabel}>
                  {customDownloadInFlight ? 'Downloading…' : 'Add & download'}
                </ThemedText>
              </Pressable>

              {customModels.length > 0 ? (
                <>
                  <ThemedText type="smallBold" style={styles.sectionTitle}>
                    Custom models
                  </ThemedText>
                  {customModels.map((model) => (
                    <DownloadedRow
                      key={model.id}
                      model={model}
                      isActive={managerState.activeId === model.id}
                      isBusy={busyIds.has(model.id)}
                      opInFlight={actionsBlocked}
                      onDelete={() => void handleDelete(model)}
                      onSetActive={() => void handleSetActive(model)}
                    />
                  ))}
                </>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </ThemedView>
      </SafeAreaProvider>
    </Modal>
  );
}

/** One catalog entry: fit indicator, size, and Download, or Delete/Set-active once downloaded. */
function CatalogRow({
  entry,
  capabilities,
  downloaded,
  isActive,
  isBusy,
  progress,
  downloadDisabled,
  opInFlight,
  onDownload,
  onDelete,
  onSetActive,
}: {
  entry: ModelCatalogEntry;
  capabilities: DeviceCapabilities | null;
  downloaded: DownloadedModel | undefined;
  isActive: boolean;
  isBusy: boolean;
  progress: { written: number; total: number; phase: 'download' | 'verify' } | undefined;
  /** True while the P2-7 round-4 orphan sweep is still in flight OR an activate/deactivate/delete op is
   * in flight — disables starting a NEW download (a fresh `createDownloadResumable` could race the
   * sweep, and a new download shouldn't start on top of an in-flight op). */
  downloadDisabled: boolean;
  /** True while an activate/deactivate/delete transaction is running anywhere in the manager (P2-2) —
   * globally disables this row's Set-active/Delete so a second op can't start concurrently. */
  opInFlight: boolean;
  onDownload: () => void;
  onDelete: (model: DownloadedModel) => void;
  onSetActive: (model: DownloadedModel) => void;
}) {
  const ramVerdict = capabilities ? ramFit(capabilities, entry.minRamBytes) : 'unknown';
  const storageVerdict = capabilities ? storageFit(capabilities, entry.sizeBytes) : 'unknown';
  const blocked = ramVerdict === 'insufficient' || storageVerdict === 'insufficient';

  return (
    <ThemedView type="backgroundElement" style={styles.row}>
      <View style={styles.rowHeader}>
        <ThemedText type="smallBold">{entry.displayName}</ThemedText>
        {isActive ? (
          <ThemedView type="backgroundSelected" style={styles.badge}>
            <ThemedText type="small">Active</ThemedText>
          </ThemedView>
        ) : null}
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {entry.params} · {entry.quant} · {formatBytes(entry.sizeBytes)}
      </ThemedText>
      {entry.note ? (
        <ThemedText type="small" themeColor="textSecondary">
          {entry.note}
        </ThemedText>
      ) : null}
      {ramVerdict === 'insufficient' ? (
        <ThemedText type="small" themeColor="textSecondary">
          Needs at least {formatBytes(entry.minRamBytes)} of RAM — this device likely doesn&apos;t
          have enough.
        </ThemedText>
      ) : null}
      {storageVerdict === 'insufficient' ? (
        <ThemedText type="small" themeColor="textSecondary">
          Not enough free storage to download this model.
        </ThemedText>
      ) : null}

      {isBusy && progress ? (
        <ProgressBar written={progress.written} total={progress.total} phase={progress.phase} />
      ) : null}

      <View style={styles.rowActions}>
        {downloaded ? (
          <>
            {!isActive ? (
              <Pressable
                onPress={() => onSetActive(downloaded)}
                disabled={isBusy || opInFlight}
                accessibilityRole="button"
                style={[styles.button, (isBusy || opInFlight) && styles.buttonDisabled]}>
                <ThemedText type="smallBold" style={styles.buttonLabel}>
                  Set active
                </ThemedText>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => onDelete(downloaded)}
              disabled={isBusy || opInFlight}
              accessibilityRole="button"
              style={[styles.buttonSecondary, (isBusy || opInFlight) && styles.buttonDisabled]}>
              <ThemedText type="smallBold">Delete</ThemedText>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={onDownload}
            disabled={isBusy || blocked || downloadDisabled}
            accessibilityRole="button"
            style={[styles.button, (isBusy || blocked || downloadDisabled) && styles.buttonDisabled]}>
            <ThemedText type="smallBold" style={styles.buttonLabel}>
              {isBusy ? 'Downloading…' : 'Download'}
            </ThemedText>
          </Pressable>
        )}
      </View>
    </ThemedView>
  );
}

/** One already-downloaded custom (pasted-URL) model row — same actions as a catalog row, no fit gate. */
function DownloadedRow({
  model,
  isActive,
  isBusy,
  opInFlight,
  onDelete,
  onSetActive,
}: {
  model: DownloadedModel;
  isActive: boolean;
  isBusy: boolean;
  /** True while any activate/deactivate/delete op is running (P2-2) — globally disables this row's
   * actions so a second op can't start concurrently. */
  opInFlight: boolean;
  onDelete: () => void;
  onSetActive: () => void;
}) {
  return (
    <ThemedView type="backgroundElement" style={styles.row}>
      <View style={styles.rowHeader}>
        <ThemedText type="smallBold">{model.displayName}</ThemedText>
        {isActive ? (
          <ThemedView type="backgroundSelected" style={styles.badge}>
            <ThemedText type="small">Active</ThemedText>
          </ThemedView>
        ) : null}
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {formatBytes(model.sizeBytes)} · unverified custom model
      </ThemedText>
      <View style={styles.rowActions}>
        {!isActive ? (
          <Pressable
            onPress={onSetActive}
            disabled={isBusy || opInFlight}
            accessibilityRole="button"
            style={[styles.button, (isBusy || opInFlight) && styles.buttonDisabled]}>
            <ThemedText type="smallBold" style={styles.buttonLabel}>
              Set active
            </ThemedText>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onDelete}
          disabled={isBusy || opInFlight}
          accessibilityRole="button"
          style={[styles.buttonSecondary, (isBusy || opInFlight) && styles.buttonDisabled]}>
          <ThemedText type="smallBold">Delete</ThemedText>
        </Pressable>
      </View>
    </ThemedView>
  );
}

/** A minimal determinate progress bar — no extra dependency needed for a filled-width `View`. */
function ProgressBar({
  written,
  total,
  phase = 'download',
}: {
  written: number;
  total: number;
  /** 'verify' = the (now real, P2-4/AF7) post-download SHA-256 streaming pass — shown distinctly so a
   * slow multi-GB hash doesn't look like a hung download. */
  phase?: 'download' | 'verify';
}) {
  const pct = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0;
  const label = phase === 'verify' ? 'Verifying' : 'Downloading';
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${pct}%` }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.progressLabel}>
        {label}: {formatBytes(written)} / {total > 0 ? formatBytes(total) : '?'} ({pct}%)
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.two,
  },
  capabilityCard: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  statusBanner: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  sectionTitle: {
    marginTop: Spacing.three,
  },
  row: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rowActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  badge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Spacing.four,
  },
  button: {
    backgroundColor: '#208AEF',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.five,
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#8b8f97',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.five,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: '#ffffff',
  },
  textInput: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  progressTrack: {
    height: 20,
    borderRadius: Spacing.one,
    backgroundColor: 'rgba(128,128,128,0.2)',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  progressFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#208AEF',
  },
  progressLabel: {
    textAlign: 'center',
  },
});
