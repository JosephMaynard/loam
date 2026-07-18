import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
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
  STORAGE_HEADROOM_BYTES,
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
  discardUnregisteredDownload,
  downloadModel,
  prepareCustomModelDownload,
  sanitizeModelFileName,
  sweepOrphanedModelFiles,
} from '@/lib/model-download';
import {
  abortActiveDownload,
  abortDownloadOwnedBy,
  isDownloadActive,
  runDownload,
  subscribeDownloadActive,
} from '@/lib/download-coordinator';
import {
  confirmActiveModelReleased,
  invalidateStaleLoad,
  reconcileActiveModel,
} from '@/lib/on-device-llm';
import { clearActiveModel, setActiveModel, type BridgeChannel } from '@/lib/model-manager-bridge';
import { MODEL_CATALOG, type ModelCatalogEntry } from '@/lib/model-catalog';
import {
  dispositionFromLoad,
  migrateLegacyCustomSourceUrls,
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

/** Runs the legacy custom-`sourceUrl` redaction migration (Finding D) at most once per process — like
 * `orphanSweepDone`, module-level so a remount doesn't re-run it. Strips any credential/`?token=…` an
 * older build persisted verbatim; a no-op when there's nothing to redact. */
let legacyRedactionDone = false;

/** expo-keep-awake tag held for the duration of a model download+verify so the screen doesn't sleep and
 * background (and thereby abort) a long multi-GB download. Distinct from the host's keep-screen-on tag. */
const MODEL_DOWNLOAD_KEEP_AWAKE_TAG = 'loam-model-download';

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
  /** True while ANY download (catalog OR custom) is running ANYWHERE in the process (Sol P2: downloads are
   * serialized by the MODULE-LEVEL `download-coordinator`, not by this component instance). Disables EVERY
   * download entry point — all catalog rows AND the "Add & download" button — for its duration, so two
   * downloads can never run against the same stale free-space snapshot or race the clean-first orphan guard.
   * Seeded from — and kept in sync with — the coordinator (see the subscribe effect below) so a freshly
   * MOUNTED overlay (after a `ready → error → ready` host transition unmounted the previous one) reflects a
   * download a PRIOR overlay instance started and that is still settling, rather than a stale instance-local
   * `false` that would let it start a second concurrent download. */
  const [downloadInFlight, setDownloadInFlight] = useState(isDownloadActive);
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
  /** False once THIS overlay instance has unmounted (Sol P2). The download callbacks below `await`
   * network/hash/persist work that can outlive the overlay — the host can transition `ready → error`
   * and tear this component down mid-download. Every setState reached AFTER an `await` in an async path
   * is guarded on this, so no state update ever runs against an unmounted overlay (React would warn, and
   * more importantly the write is meaningless). */
  const mountedRef = useRef(true);
  /** A STABLE per-instance owner token for the download coordinator (Sol Fable-round-5 P2). The coordinator
   * records it SYNCHRONOUSLY at mutex acquisition (before its orphan-cleanup await), so the unmount effect can
   * `abortDownloadOwnedBy(token)` to cancel a download THIS instance started even if the overlay unmounts
   * during that cleanup window — and can never abort a download some other instance owns. `useRef` with an
   * initializer mints one stable object per mounted instance. */
  const downloadOwnerRef = useRef<object>({});

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
      // The single-actor engine's target-aware synchronization (Fable-round-7). `reconcileActiveModel` is
      // called after every DURABLE activeId outcome (release a now-stale loaded context, converge to the
      // target); `invalidateStaleLoad` runs at persist time BEFORE the fallible bridge (abandon an in-flight
      // load of the old model without releasing the loaded one, so a rollback can't destroy it); and
      // `confirmActiveModelReleased` is the delete BARRIER (release + confirm native disposal before the file
      // is unlinked). All never block the operation mutex beyond a bounded budget and never throw.
      reconcileActiveModel: (nextPath) => reconcileActiveModel(nextPath),
      invalidateStaleLoad: (keepPath) => invalidateStaleLoad(keepPath),
      confirmActiveModelReleased: (modelPath) => confirmActiveModelReleased(modelPath),
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

        // Finding D: durably strip any credential/`?token=…` an older build persisted verbatim in a
        // custom model's `sourceUrl`. Once per process, and a no-op (no write) when nothing needs
        // redacting. `normalizeState` already redacted the in-memory `disposition.state` shown above;
        // this is purely the durable disk rewrite so the plaintext secret is removed on upgrade.
        if (!legacyRedactionDone) {
          legacyRedactionDone = true;
          await migrateLegacyCustomSourceUrls();
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
          // Finding A: preparation failed (probe / read / pending reconciliation / sweep rejected). The
          // `finally` below still flips `sweepReady` true so the "Preparing…" note clears, but a
          // reconciliation that couldn't confirm durable pending intent means destructive operations
          // (activate/deactivate/delete/download) must stay BLOCKED — otherwise they'd become available
          // on top of unresolved intent. Stay FAIL-CLOSED by keeping `pendingUnsettled` true; a later
          // reopen whose reconciliation SUCCEEDS resets it (see the success path above) and restores the
          // ready state.
          setPendingUnsettled(true);
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

  // Cancel the in-flight download/verify when the app is backgrounded, rather than letting it keep
  // running unattended (hash-performance device-verify note): Android can suspend or kill a
  // backgrounded app's JS thread at any time, and a multi-GB hash left running unobserved is exactly
  // the "corrupt state mid-verify" scenario Sol flagged. Aborting routes through the same fail-closed
  // path as a checksum mismatch (see model-download.ts), so it always deletes the partial file rather
  // than leaving something half-verified. Routed through the coordinator (Sol P2) so it aborts the one
  // process-global transaction — without releasing the mutex, which frees only when the aborted
  // transaction settles.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        abortActiveDownload();
      }
    });
    return () => subscription.remove();
  }, []);

  // Keep `downloadInFlight` in sync with the MODULE-LEVEL coordinator (Sol P2) so this overlay's download
  // controls reflect the true process-wide in-flight state — including a transaction a PRIOR overlay
  // instance started and that is still settling after this instance mounted. Reconcile once on mount (the
  // subscription can't replay an event that fired before it existed), then on every change.
  useEffect(() => {
    const sync = () => setDownloadInFlight(isDownloadActive());
    sync();
    return subscribeDownloadActive(sync);
  }, []);

  // On mount SET `mountedRef` true, and on unmount (a `ready → error` host transition tears the whole overlay
  // down — see app/index.tsx) set it false AND abort a download THIS instance owns (Sol P2). Setting true in
  // the effect SETUP (not only the one-time `useRef(true)`) is required for React StrictMode: its dev-mode
  // mount → cleanup → remount replay runs the cleanup (which sets false) and, without this, would leave the
  // remounted overlay permanently `mountedRef=false`, silently swallowing every guarded setState. Aborting by
  // OWNER TOKEN cancels only this instance's transaction, even if the unmount lands during the coordinator's
  // orphan-cleanup window (before the download body starts) — and never a different instance's download.
  // Aborting does NOT release the coordinator mutex; it frees only when the aborted transaction's own
  // `finally` settles, so a freshly-mounted overlay still can't start a second concurrent download.
  useEffect(() => {
    mountedRef.current = true;
    const owner = downloadOwnerRef.current;
    return () => {
      mountedRef.current = false;
      abortDownloadOwnedBy(owner);
    };
  }, []);

  // These three are called from the async download path AFTER `await`s (progress ticks, busy toggles),
  // so each is guarded on `mountedRef` (Sol P2) — a download that outlives the overlay must not push
  // state into an unmounted component.
  const setBusy = (id: string, isBusy: boolean) => {
    if (!mountedRef.current) {
      return;
    }
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
    if (!mountedRef.current) {
      return;
    }
    setProgress((prev) => ({ ...prev, [id]: { written, total, phase } }));
  };

  const clearModelProgress = (id: string) => {
    if (!mountedRef.current) {
      return;
    }
    setProgress((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /** Guarded `setStatusMessage` for the async download paths (Sol P2): a status update reached after an
   * `await` must no-op once the overlay has unmounted. Synchronous (pre-await) status sets call
   * `setStatusMessage` directly — the overlay is definitionally still mounted then. */
  const setStatusMessageIfMounted = (message: string) => {
    if (mountedRef.current) {
      setStatusMessage(message);
    }
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
    // Guarded on `mountedRef` (Sol P2): `persist` is only ever called from the async download bodies, which
    // can outlive this overlay if the host tears it down mid-download — the write still lands on disk
    // (`mutateModelManagerState` is process-global), we just don't push it into an unmounted component.
    if (mountedRef.current) {
      if (persisted) {
        setManagerState(state);
      } else {
        setStatusMessage("Couldn't save that change to the model list — it may not survive an app restart. Try again.");
      }
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

  /**
   * Shared download transaction for BOTH the catalog and custom paths (Sol P2). Serialization now lives in
   * the MODULE-LEVEL `download-coordinator` (`runDownload`) rather than in this component instance, so it
   * survives a `ready → error → ready` host transition that unmounts and remounts the overlay mid-download:
   *   1. `runDownload` REFUSES a second transaction process-wide — a same-tick double tap (another catalog
   *      row, or the custom button) AND a freshly-mounted overlay both get `'busy'` and start nothing, so at
   *      most ONE download ever runs. This is what stops two downloads from passing the same stale free-space
   *      snapshot or racing the clean-first orphan guard.
   *   2. The coordinator cleans EVERY retained orphan FIRST (`clearRetainedOrphans`) inside the coordinated
   *      region and refuses the download (`'orphan-blocked'`) if any still can't be removed — so a prior
   *      failed-cleanup orphan, even one created by an OLDER transaction after this overlay mounted, is
   *      cleaned before this download begins and can never accumulate a second.
   *   3. This `run` body RE-PROBES free storage right now (not the stale overlay-open snapshot) and refuses
   *      if below the floor for `sizeForStorageCheck` (the exact size for a catalog entry; 0 = the headroom
   *      floor for a custom URL whose size isn't known ahead of time).
   *   4. `body` (the actual download + registration) runs inside try/catch/finally so ANY throw still clears
   *      the busy row and progress — the catalog path had no such guard before.
   * `body` receives the transaction's `AbortSignal`; it does the download + registration and returns nothing.
   * The transaction is tagged with this instance's `downloadOwnerRef` token, established SYNCHRONOUSLY by the
   * coordinator, so the unmount effect can abort THIS instance's transaction even if the overlay unmounts
   * during the coordinator's orphan-cleanup window (Sol Fable-round-5 P2).
   */
  const runDownloadTransaction = async (
    id: string,
    sizeForStorageCheck: number,
    body: (signal: AbortSignal, maxBytes: number) => Promise<void>,
  ): Promise<void> => {
    // Keep the screen awake for the WHOLE download + verify (device-test round 2). A multi-GB model takes
    // a long time and the hash pass is slow; if the screen turns off, Android backgrounds the app and the
    // AppState listener above aborts the download — which is exactly why long downloads kept failing.
    // Holding the screen on keeps the app foregrounded so the download actually completes. Best-effort: a
    // keep-awake failure never blocks the download, and it's released when `runDownload` settles.
    await activateKeepAwakeAsync(MODEL_DOWNLOAD_KEEP_AWAKE_TAG).catch(() => undefined);
    const outcome = await runDownload(downloadOwnerRef.current, async (signal) => {
      // Re-probe free storage immediately before the download (Sol P2) rather than trusting the open-time
      // snapshot, which other app activity could have invalidated.
      const caps = await probeDeviceCapabilities();
      if (mountedRef.current) {
        setCapabilities(caps);
      }
      if (storageFit(caps, sizeForStorageCheck) === 'insufficient') {
        setStatusMessageIfMounted(
          `Not enough free storage to download a model (only ${formatBytes(caps.freeStorageBytes)} free).`,
        );
        return;
      }
      // Bound the download by the free space that must remain AFTER the required headroom (Finding B):
      // passed into `downloadModel` so a custom (unpinned) URL — or any oversized/lying response — is
      // stopped before it can fill the device, not just gated up front. `storageFit` already rejected a
      // null `freeStorageBytes` above, so the `?? 0` is a type guard, not a real fallback.
      const maxBytes = Math.max(0, (caps.freeStorageBytes ?? 0) - STORAGE_HEADROOM_BYTES);
      setBusy(id, true);
      try {
        await body(signal, maxBytes);
      } catch (err) {
        // A thrown download/persist (network stack error, storage failure, a rename throw) must surface a
        // failure status rather than silently reject and leave the row stuck. Aborts route through here too.
        setStatusMessageIfMounted(`Model download failed — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearModelProgress(id);
        setBusy(id, false);
      }
    }).finally(() => {
      void deactivateKeepAwake(MODEL_DOWNLOAD_KEEP_AWAKE_TAG).catch(() => undefined);
    });
    // A second entry point (same-tick double tap, or a remounted overlay) was refused globally, or this
    // instance's transaction was aborted (unmount) before the body ever ran — nothing to tear down here,
    // since neither case touched any per-download state in this call.
    if (outcome.status === 'busy' || outcome.status === 'aborted') {
      return;
    }
    if (outcome.status === 'orphan-blocked') {
      setStatusMessageIfMounted(
        `A previous download left a file that still can't be removed (${outcome.error}). Restart the app to clear it before downloading another model.`,
      );
    }
  };

  /** Download one curated catalog entry into `<id>.gguf`, verifying size + (now real — P2-4/AF7)
   * streaming SHA-256, fail-closed on a mismatch or a hashing failure. Runs inside the shared
   * `runDownloadTransaction` (Finding 2): globally serialized, retained-orphan-cleaned, storage re-probed,
   * and its busy/progress/controller state always torn down even on a throw (the catalog path had no such
   * guard before). On a registration failure the just-downloaded file is CHECKED-deleted
   * (`discardUnregisteredDownload`), retaining its URI only if that cleanup itself fails. */
  const handleDownloadCatalogEntry = (entry: ModelCatalogEntry) =>
    runDownloadTransaction(entry.id, entry.sizeBytes, async (signal, maxBytes) => {
      // Catalog ids are hardcoded, known-safe strings — this can't actually fail — but sanitize anyway
      // for consistency with the pasted-URL path and as defense in depth (see model-download.ts).
      const fileName = sanitizeModelFileName(`${entry.id}.gguf`);
      if (!fileName) {
        setStatusMessageIfMounted(`${entry.displayName}: invalid catalog file name.`);
        return;
      }
      setModelProgress(entry.id, 0, entry.sizeBytes, 'download');
      const outcome = await downloadModel(
        entry.url,
        fileName,
        entry.sizeBytes,
        entry.sha256,
        (written, total) => setModelProgress(entry.id, written, total > 0 ? total : entry.sizeBytes, 'download'),
        // Hashing a multi-GB file is slow — show its own progress rather than looking hung once the
        // download bar completes (P2-4/AF7).
        (hashed, total) => setModelProgress(entry.id, hashed, total, 'verify'),
        signal,
        // Bound by remaining free space (Finding B). `storageFit` above already guaranteed
        // `entry.sizeBytes + headroom` fits, so this never wrongly caps a legit catalog download.
        maxBytes,
      );
      if (!outcome.ok) {
        setStatusMessageIfMounted(`${entry.displayName}: download failed — ${outcome.error}`);
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
        setStatusMessageIfMounted(`${entry.displayName} downloaded.`);
        return;
      }
      // Registration failed and the one-per-process orphan sweep already ran, so the just-downloaded file is
      // unreferenced right now. Discard it (CHECKED) so nothing accumulates; if the checked cleanup itself
      // fails, its URI is retained for the next attempt to clean first (Finding 2) — this closes the gap
      // where a catalog persist-failure did no cleanup and retained nothing, orphaning the file.
      const discard = await discardUnregisteredDownload(outcome.uri);
      setStatusMessageIfMounted(
        discard.removed
          ? `${entry.displayName} downloaded but couldn't be saved to the model list — the file was removed. Try again.`
          : `${entry.displayName} downloaded but couldn't be saved to the model list, and removing the leftover file also failed (${discard.error}). It'll be cleared on your next attempt, or restart the app to clear it.`,
      );
    });

  /** Download a user-pasted URL — no size/hash to verify against, so it's always best-effort + warned.
   * URL parsing/authorization/redaction is the pure `prepareCustomModelDownload` (Finding 2 — malformed
   * percent-escapes, userinfo, and credential/token redaction of the persisted `sourceUrl`); the shared
   * `runDownloadTransaction` provides the process-global single-download guard (Sol P2), the clean-first
   * orphan guard, the storage re-probe, and the always-torn-down busy/progress state. A persist failure
   * after a successful download discards the orphaned file with a CHECKED delete
   * (`discardUnregisteredDownload`), retaining its URI to block another download only if that cleanup fails. */
  const handleAddCustomUrl = () => {
    // Validate + mint the id BEFORE entering the transaction: an invalid URL never starts a transaction, and
    // a same-tick double-tap on a valid URL is serialized by the coordinator's process-global mutex (only the
    // first proceeds). All parsing/authorization/redaction lives in the pure `prepareCustomModelDownload`.
    const prepared = prepareCustomModelDownload(customUrl);
    if (!prepared.ok) {
      setStatusMessage(prepared.error);
      return;
    }
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${id}-${prepared.fileName}`;
    // Custom URLs have no known size ahead of time, so the storage gate is the headroom FLOOR (size 0).
    void runDownloadTransaction(id, 0, async (signal, maxBytes) => {
      setModelProgress(id, 0, 0);
      const outcome = await downloadModel(
        prepared.downloadUrl,
        fileName,
        undefined,
        undefined,
        (written, total) => setModelProgress(id, written, total),
        undefined,
        signal,
        // Custom URLs have no pinned size, so this free-space bound is the ONLY upper limit on how much
        // a large/dishonest response can write (Finding B).
        maxBytes,
      );
      if (!outcome.ok) {
        setStatusMessageIfMounted(`Custom model download failed — ${outcome.error}`);
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
        // entered URL so the operator can retry without re-typing it (CodeRabbit). Guarded: this runs after
        // the download `await`, which can outlive the overlay (Sol P2).
        if (mountedRef.current) {
          setCustomUrl('');
        }
        setStatusMessageIfMounted(`${prepared.displayName} downloaded.`);
        return;
      }
      // Registration failed: discard the orphaned final `.gguf` (CHECKED) BEFORE offering retry so no
      // unreferenced model accumulates; if the checked cleanup itself fails the URI is retained to block
      // (and be cleaned first by) the next download (Finding 2).
      const discard = await discardUnregisteredDownload(outcome.uri);
      setStatusMessageIfMounted(
        discard.removed
          ? `${prepared.displayName} downloaded but couldn't be saved to the model list — the file was removed. Try again.`
          : `${prepared.displayName} downloaded but couldn't be saved to the model list, and removing the leftover file also failed (${discard.error}). It'll be cleared on your next attempt, or restart the app to clear it.`,
      );
    });
  };

  /**
   * Delete a downloaded model. The whole persist → bridge → rollback transaction now lives in
   * `model-manager-actions.ts` (`deleteAction`, P2-2), serialized against every other
   * activate/deactivate/delete op by that module's global mutex; here we just run it under
   * `operationInFlight` and surface the outcome. The transaction sequences the metadata removal, the
   * launcher clear (checked), the native-context release, and the IRREVERSIBLE byte delete so a failure
   * at any step leaves a safe, recoverable state — and never deletes the bytes when the launcher clear
   * couldn't be confirmed. Releasing the (multi-GB) native context before the byte delete is now driven
   * from inside the transaction via the delete BARRIER `actionDeps.confirmActiveModelReleased` (Finding 1)
   * — path-aware, and it CONFIRMS native disposal before the unlink — so there is no post-`ok` release here.
   */
  const handleDelete = (model: DownloadedModel) => runOperation(model.id, () => deleteAction(actionDeps, model));

  /**
   * Make `model` the active on-device model. Delegates to `setActiveAction` (P2-2): persist the durable
   * local record FIRST, then mirror it to the launcher config, with a DEFINITE-failure-only conditional
   * rollback and — for a bridge TIMEOUT — no rollback at all (the write may have landed; P2-1). Runs
   * under the global operation mutex so it can't interleave with another op and clobber its selection.
   */
  const handleSetActive = (model: DownloadedModel) => runOperation(model.id, () => setActiveAction(actionDeps, model));

  /** Clear the active model — `deactivateAction` (P2-2), same serialized persist-then-mirror
   * transaction with conditional rollback on a definite failure and no rollback on a timeout. The
   * native-context release is now driven from inside the transaction (`actionDeps.reconcileActiveModel(null)`,
   * Finding 1) after the CONFIRMED launcher clear, so it fires on every confirmed clear (including one
   * that only settles on reconciliation) rather than only on a direct `'ok'` here — no post-`ok` release
   * to do in the component. */
  const handleDeactivate = () => runOperation(undefined, () => deactivateAction(actionDeps));

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
                  downloadDisabled={!sweepReady || actionsBlocked || downloadInFlight}
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
                onPress={() => handleAddCustomUrl()}
                disabled={!customUrl.trim() || !sweepReady || actionsBlocked || downloadInFlight}
                accessibilityRole="button"
                style={[
                  styles.button,
                  (!customUrl.trim() || !sweepReady || actionsBlocked || downloadInFlight) && styles.buttonDisabled,
                ]}>
                <ThemedText type="smallBold" style={styles.buttonLabel}>
                  {downloadInFlight ? 'Downloading…' : 'Add & download'}
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
