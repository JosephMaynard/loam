import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import {
  formatBytes,
  probeDeviceCapabilities,
  ramFit,
  storageFit,
  STORAGE_HEADROOM_BYTES,
  type DeviceCapabilities,
} from '@/lib/device-capabilities';
import { confirmModelDownload } from '@/lib/model-download-disclosure';
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
 * distinguishes the download from the streaming-hash verification pass that
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
 * The sweep is AWAITED before `sweepReady` flips true, and every download button is disabled until
 * `sweepReady` is set (see the `visible` effect and the button `disabled` props below): a download
 * started while the sweep was still running could target a destination not in the `referencedUris`
 * this sweep pass loaded, and be deleted out from under `createDownloadResumable` mid-write. This is a
 * second, independent guard on top of `model-download.ts`'s `.partial`-suffix staging; either alone
 * closes the race. */
let orphanSweepDone = false;

/** Runs the legacy custom-`sourceUrl` redaction migration at most once per process — like
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
  /** True while ANY download (catalog OR custom) is running ANYWHERE in the process (downloads are
   * serialized by the MODULE-LEVEL `download-coordinator`, not by this component instance). Disables EVERY
   * download entry point — all catalog rows AND the "Add & download" button — for its duration, so two
   * downloads can never run against the same stale free-space snapshot or race the clean-first orphan guard.
   * Seeded from — and kept in sync with — the coordinator (see the subscribe effect below) so a freshly
   * MOUNTED overlay (after a `ready → error → ready` host transition unmounted the previous one) reflects a
   * download a PRIOR overlay instance started and that is still settling, rather than a stale instance-local
   * `false` that would let it start a second concurrent download. */
  const [downloadInFlight, setDownloadInFlight] = useState(isDownloadActive);
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  /** Gates every download-start control until the orphan sweep below has actually
   * finished — initialized from the module-level flag so a remount after the sweep already ran once
   * doesn't re-block controls. */
  const [sweepReady, setSweepReady] = useState(orphanSweepDone);
  /** True while ANY activate/deactivate/delete transaction is running. Globally disables the
   * conflicting controls (Set active / Delete / Deactivate on every row, plus downloads) so two
   * transactions can't be started concurrently — a UI-level complement to the mutex in
   * `model-manager-actions.ts` that serializes them even if they somehow both start. */
  const [operationInFlight, setOperationInFlight] = useState(false);
  /** True while durable pending actions remain unsettled after a reconciliation pass — the
   * launcher couldn't be reached to confirm one or more earlier writes. Disables the action controls
   * (like `operationInFlight`) and surfaces a banner, until a later reopen's reconcile settles them. */
  const [pendingUnsettled, setPendingUnsettled] = useState(false);
  /** True when the persisted model list couldn't be READ on open (`readModelManagerState` returned
   * `error` — an I/O failure or corruption that isn't a clean absence). The referenced-file set is
   * unknown, so the destructive orphan sweep is SKIPPED and the destructive controls (delete / set-active
   * / download) are BLOCKED, with a recovery banner — a transient read failure must never let the sweep
   * delete every downloaded `.gguf`. A later reopen retries the read and clears this. */
  const [loadFailed, setLoadFailed] = useState(false);
  /** False once THIS overlay instance has unmounted. The download callbacks below `await`
   * network/hash/persist work that can outlive the overlay — the host can transition `ready → error`
   * and tear this component down mid-download. Every setState reached AFTER an `await` in an async path
   * is guarded on this, so no state update ever runs against an unmounted overlay (React would warn, and
   * more importantly the write is meaningless). */
  const mountedRef = useRef(true);
  /** A STABLE per-instance owner token for the download coordinator. The coordinator
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
      // CHECKED delete: the transaction relies on a byte-delete failure THROWING so it keeps
      // the durable delete-pending and retries, rather than reporting a model deleted while its file
      // silently remains on disk.
      deleteModelFile: deleteModelFileChecked,
      // The single-actor engine's target-aware synchronization. `reconcileActiveModel` is
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
      // The whole open-effect body is wrapped so a rejection from ANY of
      // `probeDeviceCapabilities`/`readModelManagerState`/`reconcilePendingActions`/
      // `sweepOrphanedModelFiles` can't skip the `setSweepReady(true)` below — which would leave every
      // download/action control permanently disabled AND surface an unhandled promise rejection. The
      // `finally` always flips `sweepReady` (the `.partial`-suffix staging in model-download.ts is
      // the independent guard that keeps enabling controls after a FAILED sweep safe).
      try {
        const [caps, loaded] = await Promise.all([probeDeviceCapabilities(), readModelManagerState()]);
        if (!cancelled) {
          setCapabilities(caps);
        }

        // Turn the discriminated load result into a disposition. On `error` (couldn't read the
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

        // Durably strip any credential/`?token=…` an older build persisted verbatim in a
        // custom model's `sourceUrl`. Once per process, and a no-op (no write) when nothing needs
        // redacting. `normalizeState` already redacted the in-memory `disposition.state` shown above;
        // this is purely the durable disk rewrite so the plaintext secret is removed on upgrade.
        if (!legacyRedactionDone) {
          legacyRedactionDone = true;
          await migrateLegacyCustomSourceUrls();
        }

        // Reconcile durable pending actions FIRST, before the orphan sweep runs or any control is
        // enabled: re-send each unconfirmed launcher write (idempotent) and settle it. If every retry
        // still times out, the pending set survives and the affected files stay protected below. `current`
        // is the post-reconcile state the sweep and UI must use.
        let current = disposition.state;
        if ((current.pending ?? []).length > 0) {
          const reconciled = await reconcilePendingActions(actionDeps);
          if (reconciled.unreadable) {
            // Reconcile's OWN state read refused (a transient I/O error / corruption AFTER this
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
          // AWAITED: reclaim any `.gguf` left behind by a download whose verify/registration never
          // finished because the app process was killed mid-way (see model-download.ts). Download controls
          // stay disabled (see `sweepReady` below) until this resolves, so nothing can start a download
          // whose destination this sweep pass might treat as unreferenced. The second arg keeps any
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
          // Preparation failed (probe / read / pending reconciliation / sweep rejected). The
          // `finally` below still flips `sweepReady` true so the "Preparing…" note clears, but a
          // reconciliation that couldn't confirm durable pending intent means destructive operations
          // (activate/deactivate/delete/download) must stay BLOCKED — otherwise they'd become available
          // on top of unresolved intent. Stay FAIL-CLOSED by keeping `pendingUnsettled` true; a later
          // reopen whose reconciliation SUCCEEDS resets it (see the success path above) and restores the
          // ready state.
          setPendingUnsettled(true);
          setStatusMessage(t('model.prepareFailed', { error: error instanceof Error ? error.message : String(error) }));
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
  // running unattended: Android can suspend or kill a backgrounded app's JS thread at any time, and a
  // multi-GB hash left running unobserved risks a corrupt state mid-verify. Aborting routes through the
  // same fail-closed path as a checksum mismatch (see model-download.ts), so it always deletes the partial
  // file rather than leaving something half-verified. Routed through the coordinator so it aborts the one
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

  // Keep `downloadInFlight` in sync with the MODULE-LEVEL coordinator so this overlay's download
  // controls reflect the true process-wide in-flight state — including a transaction a PRIOR overlay
  // instance started and that is still settling after this instance mounted. Reconcile once on mount (the
  // subscription can't replay an event that fired before it existed), then on every change.
  useEffect(() => {
    const sync = () => setDownloadInFlight(isDownloadActive());
    sync();
    return subscribeDownloadActive(sync);
  }, []);

  // On mount SET `mountedRef` true, and on unmount (a `ready → error` host transition tears the whole overlay
  // down — see app/index.tsx) set it false AND abort a download THIS instance owns. Setting true in
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
  // so each is guarded on `mountedRef` — a download that outlives the overlay must not push
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

  /** Guarded `setStatusMessage` for the async download paths: a status update reached after an
   * `await` must no-op once the overlay has unmounted. Synchronous (pre-await) status sets call
   * `setStatusMessage` directly — the overlay is definitionally still mounted then. */
  const setStatusMessageIfMounted = (message: string) => {
    if (mountedRef.current) {
      setStatusMessage(message);
    }
  };

  /**
   * Apply `mutate` on top of whatever is CURRENTLY persisted — never on top of this component's
   * possibly-stale `managerState` snapshot, since two downloads/activations finishing back-to-back
   * would otherwise each build their next state from the state captured when THEIR OWN async op
   * started, and the last one to finish would silently erase the other's write.
   * `mutateModelManagerState` serializes this against every other in-flight mutation and writes
   * atomically; a failed write is surfaced here (not swallowed) rather than letting the caller report
   * success on a change that never landed.
   *
   * Only adopts the mutated result into the component's `managerState` when the write actually
   * landed, so a failed disk write never leaves the screen showing an optimistic (never-persisted)
   * mutation. Every caller already bails out on `!persisted` before doing anything further, so leaving
   * `managerState` untouched here is enough to keep the UI honest.
   */
  const persist = async (mutate: (current: ModelManagerState) => ModelManagerState): Promise<boolean> => {
    const { state, persisted } = await mutateModelManagerState(mutate);
    // Guarded on `mountedRef`: `persist` is only ever called from the async download bodies, which
    // can outlive this overlay if the host tears it down mid-download — the write still lands on disk
    // (`mutateModelManagerState` is process-global), we just don't push it into an unmounted component.
    if (mountedRef.current) {
      if (persisted) {
        setManagerState(state);
      } else {
        setStatusMessage(t('model.persistFailed'));
      }
    }
    return persisted;
  };

  /** Run one serialized activate/deactivate/delete transaction (see `model-manager-actions.ts`),
   * flipping `operationInFlight` (and the acting row's `busy`) around it and adopting the resulting
   * state + status message. All rollback / timeout-ambiguity handling lives in the transaction; here we
   * only surface its outcome. Returns the transaction's `ModelActionResult`; the native-context release
   * after a deactivate/delete runs inside the transaction, so no caller needs to act on it. */
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
        // An ambiguous op leaves a durable pending action; reflect that so the controls gate and
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
   * Shared download transaction for BOTH the catalog and custom paths. Serialization lives in
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
   *      the busy row and progress.
   * `body` receives the transaction's `AbortSignal`; it does the download + registration and returns nothing.
   * The transaction is tagged with this instance's `downloadOwnerRef` token, established SYNCHRONOUSLY by the
   * coordinator, so the unmount effect can abort THIS instance's transaction even if the overlay unmounts
   * during the coordinator's orphan-cleanup window.
   */
  const runDownloadTransaction = async (
    id: string,
    sizeForStorageCheck: number,
    body: (signal: AbortSignal, maxBytes: number) => Promise<void>,
  ): Promise<void> => {
    const outcome = await runDownload(downloadOwnerRef.current, async (signal) => {
      // Keep the screen awake for the WHOLE accepted download + verify: a multi-GB download plus a slow
      // hash pass, and if the screen sleeps Android backgrounds the app and the AppState listener above
      // aborts the download. Activate
      // INSIDE the accepted callback (not before `runDownload`): the keep-awake tag is shared and NOT
      // ref-counted, so a REFUSED same-tick double-tap / remounted overlay — whose transaction never runs —
      // must not toggle it; otherwise that loser's release (a plain `.finally`) would clear the tag out from
      // under the running download and let the screen sleep → abort. Best-effort: a keep-awake failure never
      // blocks the download; it's released in the `finally` below when THIS accepted download settles.
      await activateKeepAwakeAsync(MODEL_DOWNLOAD_KEEP_AWAKE_TAG).catch(() => undefined);
      try {
        // Re-probe free storage immediately before the download rather than trusting the open-time
        // snapshot, which other app activity could have invalidated.
        const caps = await probeDeviceCapabilities();
        if (mountedRef.current) {
          setCapabilities(caps);
        }
        if (storageFit(caps, sizeForStorageCheck) === 'insufficient') {
          setStatusMessageIfMounted(t('model.noStorage', { free: formatBytes(caps.freeStorageBytes) }));
          return;
        }
        // Bound the download by the free space that must remain AFTER the required headroom:
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
          setStatusMessageIfMounted(t('model.downloadFailed', { error: err instanceof Error ? err.message : String(err) }));
        } finally {
          clearModelProgress(id);
          setBusy(id, false);
        }
      } finally {
        void deactivateKeepAwake(MODEL_DOWNLOAD_KEEP_AWAKE_TAG).catch(() => undefined);
      }
    });
    // A second entry point (same-tick double tap, or a remounted overlay) was refused globally, or this
    // instance's transaction was aborted (unmount) before the body ever ran — nothing to tear down here,
    // since neither case touched any per-download state in this call.
    if (outcome.status === 'busy' || outcome.status === 'aborted') {
      return;
    }
    if (outcome.status === 'orphan-blocked') {
      setStatusMessageIfMounted(t('model.orphanBlocked', { error: outcome.error }));
    }
  };

  /** Download one curated catalog entry into `<id>.gguf`, verifying size + streaming SHA-256,
   * fail-closed on a mismatch or a hashing failure. Runs inside the shared `runDownloadTransaction`:
   * globally serialized, retained-orphan-cleaned, storage re-probed, and its busy/progress/controller
   * state always torn down even on a throw. On a registration failure the just-downloaded file is CHECKED-deleted
   * (`discardUnregisteredDownload`), retaining its URI only if that cleanup itself fails. */
  const handleDownloadCatalogEntry = (entry: ModelCatalogEntry) =>
    runDownloadTransaction(entry.id, entry.sizeBytes, async (signal, maxBytes) => {
      // Catalog ids are hardcoded, known-safe strings — this can't actually fail — but sanitize anyway
      // for consistency with the pasted-URL path and as defense in depth (see model-download.ts).
      const fileName = sanitizeModelFileName(`${entry.id}.gguf`);
      if (!fileName) {
        setStatusMessageIfMounted(t('model.invalidFileName', { name: entry.displayName }));
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
        // download bar completes.
        (hashed, total) => setModelProgress(entry.id, hashed, total, 'verify'),
        signal,
        // Bound by remaining free space. `storageFit` above already guaranteed
        // `entry.sizeBytes + headroom` fits, so this never wrongly caps a legit catalog download.
        maxBytes,
      );
      if (!outcome.ok) {
        setStatusMessageIfMounted(t('model.entryDownloadFailed', { name: entry.displayName, error: outcome.error }));
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
        setStatusMessageIfMounted(t('model.downloaded', { name: entry.displayName }));
        return;
      }
      // Registration failed and the one-per-process orphan sweep already ran, so the just-downloaded file is
      // unreferenced right now. Discard it (CHECKED) so nothing accumulates; if the checked cleanup itself
      // fails, its URI is retained for the next attempt to clean first, so the file is never orphaned.
      const discard = await discardUnregisteredDownload(outcome.uri);
      setStatusMessageIfMounted(unregisteredMessage(entry.displayName, discard));
    });

  /** Download a user-pasted URL — no size/hash to verify against, so it's always best-effort + warned.
   * URL parsing/authorization/redaction is the pure `prepareCustomModelDownload` (malformed
   * percent-escapes, userinfo, and credential/token redaction of the persisted `sourceUrl`); the shared
   * `runDownloadTransaction` provides the process-global single-download guard, the clean-first
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
        // a large/dishonest response can write.
        maxBytes,
      );
      if (!outcome.ok) {
        setStatusMessageIfMounted(t('model.customDownloadFailed', { error: outcome.error }));
        return;
      }
      const model: DownloadedModel = {
        id,
        displayName: prepared.displayName,
        uri: outcome.uri,
        sizeBytes: outcome.sizeBytes,
        isCustom: true,
        // REDACTED: origin+pathname only — never the pasted URL's credentials/query/hash.
        sourceUrl: prepared.sourceUrl,
        downloadedAt: Date.now(),
      };
      const persisted = await persist((current) => ({ ...current, downloaded: [...current.downloaded, model] }));
      if (persisted) {
        // Clear the input only on a fully successful download+persist — a persistence failure keeps the
        // entered URL so the operator can retry without re-typing it. Guarded: this runs after
        // the download `await`, which can outlive the overlay.
        if (mountedRef.current) {
          setCustomUrl('');
        }
        setStatusMessageIfMounted(t('model.downloaded', { name: prepared.displayName }));
        return;
      }
      // Registration failed: discard the orphaned final `.gguf` (CHECKED) BEFORE offering retry so no
      // unreferenced model accumulates; if the checked cleanup itself fails the URI is retained to block
      // (and be cleaned first by) the next download.
      const discard = await discardUnregisteredDownload(outcome.uri);
      setStatusMessageIfMounted(unregisteredMessage(prepared.displayName, discard));
    });
  };

  /** Show the size + Wi-Fi/metered-data disclosure (docs/30 H4) and start the download only on an explicit
   * confirm. `sizeBytes` undefined = unknown up front (a custom URL). */
  const confirmThenDownload = (name: string, sizeBytes: number | undefined, start: () => void) =>
    confirmModelDownload(Alert.alert, name, sizeBytes === undefined ? undefined : formatBytes(sizeBytes), start);

  /** The "Add & download" button: validate the URL first (so a bad one errors without a prompt), then
   * confirm, then run the real download (which re-validates — `prepareCustomModelDownload` is pure). */
  const handleAddCustomUrlPress = () => {
    const prepared = prepareCustomModelDownload(customUrl);
    if (!prepared.ok) {
      setStatusMessage(prepared.error);
      return;
    }
    confirmThenDownload(prepared.displayName, undefined, handleAddCustomUrl);
  };

  /**
   * Delete a downloaded model. The whole persist → bridge → rollback transaction lives in
   * `model-manager-actions.ts` (`deleteAction`), serialized against every other
   * activate/deactivate/delete op by that module's global mutex; here we just run it under
   * `operationInFlight` and surface the outcome. The transaction sequences the metadata removal, the
   * launcher clear (checked), the native-context release, and the IRREVERSIBLE byte delete so a failure
   * at any step leaves a safe, recoverable state — and never deletes the bytes when the launcher clear
   * couldn't be confirmed. Releasing the (multi-GB) native context before the byte delete is driven
   * from inside the transaction via the delete BARRIER `actionDeps.confirmActiveModelReleased`
   * — path-aware, and it CONFIRMS native disposal before the unlink — so there is no post-`ok` release here.
   */
  const handleDelete = (model: DownloadedModel) => runOperation(model.id, () => deleteAction(actionDeps, model));

  /**
   * Make `model` the active on-device model. Delegates to `setActiveAction`: persist the durable
   * local record FIRST, then mirror it to the launcher config, with a DEFINITE-failure-only conditional
   * rollback and — for a bridge TIMEOUT — no rollback at all (the write may have landed). Runs
   * under the global operation mutex so it can't interleave with another op and clobber its selection.
   */
  const handleSetActive = (model: DownloadedModel) => runOperation(model.id, () => setActiveAction(actionDeps, model));

  /** Clear the active model — `deactivateAction`, same serialized persist-then-mirror
   * transaction with conditional rollback on a definite failure and no rollback on a timeout. The
   * native-context release is driven from inside the transaction (`actionDeps.reconcileActiveModel(null)`)
   * after the CONFIRMED launcher clear, so it fires on every confirmed clear (including one
   * that only settles on reconciliation) rather than only on a direct `'ok'` here — no post-`ok` release
   * to do in the component. */
  const handleDeactivate = () => runOperation(undefined, () => deactivateAction(actionDeps));

  const customModels = managerState.downloaded.filter((model) => model.isCustom);
  /** Activate/deactivate/delete + download controls are disabled while an op is in flight OR
   * while durable pending actions remain unsettled — reconciliation couldn't reach the launcher,
   * so starting a NEW change (which could contradict an unconfirmed one) is gated until a reopen settles
   * them — OR when the persisted model list couldn't be read (`loadFailed`): acting destructively
   * on an unknown model set risks deleting a file the launcher still points at. */
  const actionsBlocked = operationInFlight || pendingUnsettled || loadFailed;
  /** "Add & download" (the button and the URL field's Enter key alike): nothing typed, or any gate above. */
  const customDownloadDisabled = !customUrl.trim() || !sweepReady || actionsBlocked || downloadInFlight;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <ThemedView style={styles.header}>
              <ThemedText type="subtitle">{t('model.title')}</ThemedText>
              <Pressable onPress={onClose} accessibilityRole="button" hitSlop={Spacing.two}>
                <ThemedText type="link">{t('share.done')}</ThemedText>
              </Pressable>
            </ThemedView>
            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <ThemedText type="small" themeColor="textSecondary">
                {t('model.intro')}
              </ThemedText>

              {capabilities ? (
                <ThemedView type="backgroundElement" style={styles.capabilityCard}>
                  <ThemedText type="smallBold">{t('model.thisDevice')}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {t('model.deviceStats', {
                      ram: formatBytes(capabilities.totalRamBytes),
                      free: formatBytes(capabilities.freeStorageBytes),
                    })}
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
                    {t('model.activeName', {
                      name: managerState.downloaded.find((m) => m.id === managerState.activeId)?.displayName ?? managerState.activeId,
                    })}
                  </ThemedText>
                  <Pressable
                    onPress={() => void handleDeactivate()}
                    disabled={actionsBlocked}
                    accessibilityRole="button"
                    style={actionsBlocked ? styles.buttonDisabled : undefined}>
                    <ThemedText type="link">{t('model.deactivate')}</ThemedText>
                  </Pressable>
                </ThemedView>
              ) : null}

              <ThemedText type="smallBold" style={styles.sectionTitle}>
                {t('model.catalog')}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {t('model.catalogNote', {
                  min: formatBytes(Math.min(...MODEL_CATALOG.map((e) => e.sizeBytes))),
                  max: formatBytes(Math.max(...MODEL_CATALOG.map((e) => e.sizeBytes))),
                })}
              </ThemedText>
              {!sweepReady ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {t('model.preparing')}
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
                  onDownload={() =>
                    confirmThenDownload(entry.displayName, entry.sizeBytes, () => void handleDownloadCatalogEntry(entry))
                  }
                  onDelete={(model) => void handleDelete(model)}
                  onSetActive={(model) => void handleSetActive(model)}
                />
              ))}

              <ThemedText type="smallBold" style={styles.sectionTitle}>
                {t('model.addByUrl')}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {t('model.addByUrlNote')}
              </ThemedText>
              <TextInput
                value={customUrl}
                onChangeText={setCustomUrl}
                placeholder="https://…/model.gguf"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={() => {
                  if (!customDownloadDisabled) {
                    handleAddCustomUrlPress();
                  }
                }}
                style={[styles.textInput, { color: theme.text, borderColor: theme.textSecondary }]}
              />
              <Pressable
                onPress={() => handleAddCustomUrlPress()}
                disabled={customDownloadDisabled}
                accessibilityRole="button"
                style={[styles.button, customDownloadDisabled && styles.buttonDisabled]}>
                <ThemedText type="smallBold" style={styles.buttonLabel}>
                  {downloadInFlight ? t('model.downloading') : t('model.addAndDownload')}
                </ThemedText>
              </Pressable>

              {customModels.length > 0 ? (
                <>
                  <ThemedText type="smallBold" style={styles.sectionTitle}>
                    {t('model.customModels')}
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
  /** True while the orphan sweep is still in flight, the action controls are blocked (`actionsBlocked`:
   * an op in flight, unsettled pending actions, or an unreadable model list), or another download is
   * running — disables starting a NEW download (a fresh `createDownloadResumable` could race the sweep,
   * and a new download shouldn't start on top of an in-flight op). */
  downloadDisabled: boolean;
  /** The manager's `actionsBlocked` (an activate/deactivate/delete transaction running anywhere, unsettled
   * pending actions, or an unreadable model list) — disables this row's Set-active/Delete. */
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
            <ThemedText type="small">{t('model.activeBadge')}</ThemedText>
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
          {t('model.ramInsufficient', { ram: formatBytes(entry.minRamBytes) })}
        </ThemedText>
      ) : null}
      {storageVerdict === 'insufficient' ? (
        <ThemedText type="small" themeColor="textSecondary">
          {t('model.storageInsufficient')}
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
                  {t('model.setActive')}
                </ThemedText>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => onDelete(downloaded)}
              disabled={isBusy || opInFlight}
              accessibilityRole="button"
              style={[styles.buttonSecondary, (isBusy || opInFlight) && styles.buttonDisabled]}>
              <ThemedText type="smallBold">{t('model.delete')}</ThemedText>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={onDownload}
            disabled={isBusy || blocked || downloadDisabled}
            accessibilityRole="button"
            style={[styles.button, (isBusy || blocked || downloadDisabled) && styles.buttonDisabled]}>
            <ThemedText type="smallBold" style={styles.buttonLabel}>
              {isBusy ? t('model.downloading') : t('model.download')}
            </ThemedText>
          </Pressable>
        )}
      </View>
    </ThemedView>
  );
}

/**
 * The status after a download whose registration in the model list failed: the file was removed, or
 * removing it failed too and it stays retained for the next attempt to clear first.
 */
function unregisteredMessage(name: string, discard: { removed: boolean; error?: string }): string {
  return discard.removed
    ? t('model.unregisteredRemoved', { name })
    : t('model.unregisteredKept', { name, error: discard.error ?? t('common.unknownError') });
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
  /** The manager's `actionsBlocked` (any activate/deactivate/delete op running, unsettled pending actions,
   * or an unreadable model list) — disables this row's actions. */
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
            <ThemedText type="small">{t('model.activeBadge')}</ThemedText>
          </ThemedView>
        ) : null}
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {t('model.customSize', { size: formatBytes(model.sizeBytes) })}
      </ThemedText>
      <View style={styles.rowActions}>
        {!isActive ? (
          <Pressable
            onPress={onSetActive}
            disabled={isBusy || opInFlight}
            accessibilityRole="button"
            style={[styles.button, (isBusy || opInFlight) && styles.buttonDisabled]}>
            <ThemedText type="smallBold" style={styles.buttonLabel}>
              {t('model.setActive')}
            </ThemedText>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onDelete}
          disabled={isBusy || opInFlight}
          accessibilityRole="button"
          style={[styles.buttonSecondary, (isBusy || opInFlight) && styles.buttonDisabled]}>
          <ThemedText type="smallBold">{t('model.delete')}</ThemedText>
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
  /** 'verify' = the post-download SHA-256 streaming pass — shown distinctly so a
   * slow multi-GB hash doesn't look like a hung download. */
  phase?: 'download' | 'verify';
}) {
  const pct = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0;
  const label = phase === 'verify' ? t('model.verifying') : t('model.downloadingLabel');
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${pct}%` }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.progressLabel}>
        {t('model.progress', { label, written: formatBytes(written), total: total > 0 ? formatBytes(total) : '?', pct })}
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
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
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
