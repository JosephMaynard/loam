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

/** Persist the manager state. Best-effort — a failed write just means it won't survive a restart. */
export async function saveModelManagerState(state: ModelManagerState): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(STATE_PATH, JSON.stringify(state));
  } catch {
    // best-effort
  }
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
