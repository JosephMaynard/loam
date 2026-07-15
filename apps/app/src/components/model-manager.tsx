import { useEffect, useRef, useState } from 'react';
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
import { deleteModelFile, downloadModel, sanitizeModelFileName, sweepOrphanedModelFiles } from '@/lib/model-download';
import { clearActiveModel, setActiveModel, type BridgeChannel } from '@/lib/model-manager-bridge';
import { MODEL_CATALOG, type ModelCatalogEntry } from '@/lib/model-catalog';
import {
  loadModelManagerState,
  mutateModelManagerState,
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
 * doc comment for why an orphan is safe to delete blindly (it was never registered as active). */
let orphanSweepDone = false;

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
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  // Every in-flight download/verify's `AbortController`, keyed by the same id used in `busyIds`/
  // `progress` — lets the AppState listener below cancel everything at once on backgrounding.
  const activeDownloads = useRef<Map<string, AbortController>>(new Map());

  // Refresh the probe + persisted state every time the manager is opened — storage/RAM and the
  // downloaded-file list can both change between visits.
  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [caps, loaded] = await Promise.all([probeDeviceCapabilities(), loadModelManagerState()]);
      if (!cancelled) {
        setCapabilities(caps);
        setManagerState(loaded);
      }
      if (!orphanSweepDone) {
        orphanSweepDone = true;
        // Best-effort: reclaim any `.gguf` left behind by a download whose verify/registration never
        // finished because the app process was killed mid-way (hash-performance device-verify note —
        // see model-download.ts). Safe here specifically because this only runs on the FIRST open of
        // a fresh process, before any download in this session could possibly be in flight.
        void sweepOrphanedModelFiles(loaded.downloaded.map((model) => model.uri));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

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
   */
  const persist = async (mutate: (current: ModelManagerState) => ModelManagerState): Promise<boolean> => {
    const { state, persisted } = await mutateModelManagerState(mutate);
    setManagerState(state);
    if (!persisted) {
      setStatusMessage("Couldn't save that change to the model list — it may not survive an app restart. Try again.");
    }
    return persisted;
  };

  /** Download one curated catalog entry into `<id>.gguf`, verifying size + (now real — P2-4/AF7)
   * streaming SHA-256, fail-closed on a mismatch or a hashing failure. */
  const handleDownloadCatalogEntry = async (entry: ModelCatalogEntry) => {
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

  /** Download a user-pasted URL — no size/hash to verify against, so it's always best-effort + warned. */
  const handleAddCustomUrl = async () => {
    const trimmed = customUrl.trim();
    if (!trimmed) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setStatusMessage("That doesn't look like a valid URL.");
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      setStatusMessage('Only http/https URLs are supported.');
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
    // decodeURIComponent must run BEFORE sanitizing — an encoded `%2F`/`%2E%2E` only becomes a real
    // `/`/`..` after decoding, and a naive split-then-decode order is exactly what lets a crafted URL
    // (e.g. `.../foo%2F..%2F..%2Fbar.gguf`) smuggle a path-traversal segment past a pre-decode split.
    const decodedName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'model') || 'model';
    const guessedName = sanitizeModelFileName(decodedName);
    if (!guessedName) {
      setStatusMessage("That URL's file name isn't safe to use — try a direct link with a plain file name.");
      return;
    }
    const fileName = `${id}-${guessedName.toLowerCase().endsWith('.gguf') ? guessedName : `${guessedName}.gguf`}`;

    setBusy(id, true);
    setModelProgress(id, 0, 0);
    const controller = new AbortController();
    activeDownloads.current.set(id, controller);
    const outcome = await downloadModel(
      trimmed,
      fileName,
      undefined,
      undefined,
      (written, total) => setModelProgress(id, written, total),
      undefined,
      controller.signal,
    );
    activeDownloads.current.delete(id);
    clearModelProgress(id);
    setBusy(id, false);

    if (!outcome.ok) {
      setStatusMessage(`Custom model download failed — ${outcome.error}`);
      return;
    }
    const model: DownloadedModel = {
      id,
      displayName: guessedName,
      uri: outcome.uri,
      sizeBytes: outcome.sizeBytes,
      isCustom: true,
      sourceUrl: trimmed,
      downloadedAt: Date.now(),
    };
    const persisted = await persist((current) => ({ ...current, downloaded: [...current.downloaded, model] }));
    setCustomUrl('');
    if (persisted) {
      setStatusMessage(`${guessedName} downloaded.`);
    }
  };

  /**
   * Delete a downloaded model (P2-4). Sequenced so a failure at any step leaves a SAFE, recoverable
   * state rather than the old order (clear config → ignore its result → delete the GGUF bytes → THEN
   * persist metadata), which could leave metadata pointing at a file that no longer exists if the
   * process died between the delete and the persist.
   *
   * The RN-local `model-manager-store.json` is the authoritative record of what's downloaded/active
   * (see `model-manager-bridge.ts`'s doc comment — `on-device-llm.ts` reads it directly); the
   * launcher-config write (`clearActiveModel`) is only a best-effort mirror for the host's cosmetic
   * `enabled`/`model` label, so it's fine for it to lag briefly behind a warning rather than block the
   * deletion. Order: (1) persist metadata FIRST — once this lands, nothing in local state references
   * the file any more, so it's safe to delete the bytes even if a later step fails; (2) THEN clear the
   * launcher's active pointer if this was the active model, checking (not ignoring) the result; (3)
   * only THEN delete the file bytes, since step 1 already made that irreversible step safe to take.
   */
  const handleDelete = async (model: DownloadedModel) => {
    setBusy(model.id, true);

    let wasActive = false;
    const persisted = await persist((current) => {
      wasActive = current.activeId === model.id;
      return {
        downloaded: current.downloaded.filter((existing) => existing.id !== model.id),
        activeId: wasActive ? undefined : current.activeId,
      };
    });
    if (!persisted) {
      setBusy(model.id, false);
      // `persist` already surfaced why — don't touch the bridge or the file on top of a failed write.
      return;
    }

    let bridgeWarning: string | undefined;
    if (wasActive) {
      const result = await clearActiveModel(channel);
      if (!result.ok) {
        // Local state is already consistent (nothing references this model any more) — it's the
        // host's live config mirror that's stale, so warn instead of silently discarding the result
        // the way the old code did.
        bridgeWarning = `the host app's active-model config couldn't be cleared (${result.error ?? 'unknown error'}) — restart the LOAM host app`;
      }
    }

    await deleteModelFile(model.uri);
    setBusy(model.id, false);
    setStatusMessage(
      bridgeWarning ? `${model.displayName} deleted, but ${bridgeWarning}.` : `${model.displayName} deleted.`,
    );
  };

  /**
   * Make `model` the active on-device model (P2-4). Persists the durable local record FIRST, then
   * mirrors it to the launcher config — the reverse of the old order (bridge write, then persist),
   * which could leave the running host pointed at a model `model-manager-store.json` didn't know
   * about if the persist failed after the bridge call already succeeded. Since `on-device-llm.ts`
   * reads `activeId` from local state directly (see `model-manager-bridge.ts`), persisting first means
   * a failed mirror write still leaves the REAL selection correct — only the host's cosmetic label is
   * stale, which is surfaced rather than reported as a silent success.
   */
  const handleSetActive = async (model: DownloadedModel) => {
    setBusy(model.id, true);

    const persisted = await persist((current) => ({ ...current, activeId: model.id }));
    if (!persisted) {
      setBusy(model.id, false);
      return;
    }

    const result = await setActiveModel(channel, { modelPath: model.uri, model: model.displayName });
    setBusy(model.id, false);
    if (!result.ok) {
      setStatusMessage(
        `${model.displayName} is saved as the active model, but the host app's config couldn't be refreshed (${result.error ?? 'unknown error'}) — restart the LOAM host app to pick it up.`,
      );
      return;
    }
    setStatusMessage(`${model.displayName} is now the active model. Restart the LOAM host app to load it.`);
  };

  /** Clear the active model (P2-4) — same persist-then-mirror ordering as `handleSetActive` above. */
  const handleDeactivate = async () => {
    const persisted = await persist((current) => ({ ...current, activeId: undefined }));
    if (!persisted) {
      return;
    }

    const result = await clearActiveModel(channel);
    if (!result.ok) {
      setStatusMessage(
        `On-device model deactivated locally, but the host app's config couldn't be refreshed (${result.error ?? 'unknown error'}) — restart the LOAM host app to apply it.`,
      );
      return;
    }
    setStatusMessage('On-device model deactivated. Restart the LOAM host app to apply it.');
  };

  const customModels = managerState.downloaded.filter((model) => model.isCustom);

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
                  <Pressable onPress={() => void handleDeactivate()} accessibilityRole="button">
                    <ThemedText type="link">Deactivate</ThemedText>
                  </Pressable>
                </ThemedView>
              ) : null}

              <ThemedText type="smallBold" style={styles.sectionTitle}>
                Catalog
              </ThemedText>
              {MODEL_CATALOG.map((entry) => (
                <CatalogRow
                  key={entry.id}
                  entry={entry}
                  capabilities={capabilities}
                  downloaded={managerState.downloaded.find((model) => model.id === entry.id)}
                  isActive={managerState.activeId === entry.id}
                  isBusy={busyIds.has(entry.id)}
                  progress={progress[entry.id]}
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
                disabled={!customUrl.trim()}
                accessibilityRole="button"
                style={[styles.button, !customUrl.trim() && styles.buttonDisabled]}>
                <ThemedText type="smallBold" style={styles.buttonLabel}>
                  Add &amp; download
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
                disabled={isBusy}
                accessibilityRole="button"
                style={[styles.button, isBusy && styles.buttonDisabled]}>
                <ThemedText type="smallBold" style={styles.buttonLabel}>
                  Set active
                </ThemedText>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => onDelete(downloaded)}
              disabled={isBusy}
              accessibilityRole="button"
              style={[styles.buttonSecondary, isBusy && styles.buttonDisabled]}>
              <ThemedText type="smallBold">Delete</ThemedText>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={onDownload}
            disabled={isBusy || blocked}
            accessibilityRole="button"
            style={[styles.button, (isBusy || blocked) && styles.buttonDisabled]}>
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
  onDelete,
  onSetActive,
}: {
  model: DownloadedModel;
  isActive: boolean;
  isBusy: boolean;
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
            disabled={isBusy}
            accessibilityRole="button"
            style={[styles.button, isBusy && styles.buttonDisabled]}>
            <ThemedText type="smallBold" style={styles.buttonLabel}>
              Set active
            </ThemedText>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onDelete}
          disabled={isBusy}
          accessibilityRole="button"
          style={[styles.buttonSecondary, isBusy && styles.buttonDisabled]}>
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
