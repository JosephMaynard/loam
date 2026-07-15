// Local persistence for the on-device model manager: which GGUF files have been downloaded (catalog
// picks + pasted-URL customs) and which one is active. Lives entirely in this app's own Expo sandbox
// (`documentDirectory`) — independent of the embedded Node process's own data dir (see
// `model-manager-bridge.ts` for why those two storage areas are deliberately kept separate). A plain
// JSON file is enough here (small, infrequently written); no AsyncStorage dependency needed.
import * as FileSystem from 'expo-file-system/legacy';

export type DownloadedModel = {
  /** Catalog id for a curated pick, or a generated id for a pasted-URL custom model. */
  id: string;
  displayName: string;
  /** Absolute `file://` URI where the GGUF lives on-device. */
  uri: string;
  sizeBytes: number;
  sha256?: string;
  isCustom: boolean;
  sourceUrl: string;
  downloadedAt: number;
};

export type ModelManagerState = {
  downloaded: DownloadedModel[];
  /** id of the model currently pushed to `llm.onDevice` (see model-manager-bridge.ts), if any. */
  activeId?: string;
};

const STATE_PATH = `${FileSystem.documentDirectory}loam-model-manager.json`;

const EMPTY_STATE: ModelManagerState = { downloaded: [] };

/** Load the persisted manager state. Never throws — a missing/corrupt file just yields empty state. */
export async function loadModelManagerState(): Promise<ModelManagerState> {
  try {
    const info = await FileSystem.getInfoAsync(STATE_PATH);
    if (!info.exists) {
      return EMPTY_STATE;
    }
    const raw = await FileSystem.readAsStringAsync(STATE_PATH);
    return normalizeState(JSON.parse(raw));
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * Persist the manager state ATOMICALLY (P2-4): write to a temp file, delete any stale destination,
 * then move the temp file into place. `expo-file-system/legacy` has no single atomic-rename primitive
 * that's guaranteed to overwrite an existing destination on every platform, so this composes
 * `writeAsStringAsync` (into a throwaway temp path) + `deleteAsync` + `moveAsync` — from any reader's
 * perspective (`loadModelManagerState` above) `STATE_PATH` is always either the complete OLD file or
 * the complete NEW one, never a partial write from a crash/kill mid-write.
 *
 * Returns whether the write actually landed. Unlike the old best-effort-and-swallow version, callers
 * MUST check this (see `mutateModelManagerState` below) — silently reporting success on a failed
 * persist is exactly the kind of bug that made P2-4 possible in the first place (an operator sees
 * "model set active" when the change never made it to disk).
 */
export async function saveModelManagerState(state: ModelManagerState): Promise<boolean> {
  const tmpPath = `${STATE_PATH}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await FileSystem.writeAsStringAsync(tmpPath, JSON.stringify(state));
    await FileSystem.deleteAsync(STATE_PATH, { idempotent: true });
    await FileSystem.moveAsync({ from: tmpPath, to: STATE_PATH });
    return true;
  } catch {
    await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => undefined);
    return false;
  }
}

/**
 * Serialized read-modify-write queue for the manager state (P2-4): each call reloads the CURRENT
 * persisted state, applies `mutate` on top of it, and persists the result — chained through this
 * module-level promise so concurrent callers (e.g. two catalog downloads finishing back-to-back) can
 * never each build their next state from a snapshot captured back when their own async download
 * started. Before this, the LAST completion's `{...staleManagerState, downloaded: [...]}` merge would
 * silently overwrite whatever an earlier-starting, later-finishing download had just persisted — the
 * mutation queue below is what actually fixes that, not just the atomic write.
 *
 * Every caller in `model-manager.tsx` should go through this instead of composing
 * `loadModelManagerState`/`saveModelManagerState` with locally-held React state.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

export type MutateResult = { state: ModelManagerState; persisted: boolean };

export function mutateModelManagerState(
  mutate: (current: ModelManagerState) => ModelManagerState,
): Promise<MutateResult> {
  const run = mutationChain.then(async (): Promise<MutateResult> => {
    const current = await loadModelManagerState();
    const next = mutate(current);
    const persisted = await saveModelManagerState(next);
    return { state: next, persisted };
  });
  // Keep the chain alive regardless of outcome — a rejected mutation must not wedge every later one
  // behind a permanently-broken promise.
  mutationChain = run.catch(() => undefined);
  return run;
}

function normalizeState(value: unknown): ModelManagerState {
  if (!value || typeof value !== 'object') {
    return EMPTY_STATE;
  }
  const record = value as { downloaded?: unknown; activeId?: unknown };
  const downloaded = Array.isArray(record.downloaded) ? record.downloaded.filter(isDownloadedModel) : [];
  const activeId = typeof record.activeId === 'string' ? record.activeId : undefined;
  return { downloaded, activeId };
}

function isDownloadedModel(value: unknown): value is DownloadedModel {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.uri === 'string' &&
    typeof record.sizeBytes === 'number' &&
    typeof record.isCustom === 'boolean' &&
    typeof record.sourceUrl === 'string' &&
    typeof record.downloadedAt === 'number' &&
    (record.sha256 === undefined || typeof record.sha256 === 'string')
  );
}
