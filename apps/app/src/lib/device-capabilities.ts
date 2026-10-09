// Device capability probe for the on-device LLM model manager (docs/06). Reports the two axes LOAM
// actually enforces as gates — RAM and free storage — and nothing else.
//
// Deliberately NOT reported: a GPU/NPU capability flag. Android exposes no clean public API to
// enumerate an on-device inference accelerator (vendor NNAPI/GPU delegate support varies wildly and
// isn't queryable in a way a generic app can trust), so fabricating a "has GPU" badge would be a lie
// dressed up as a fact. The catalog's `model.acceleratorNote` is the honest best-effort substitute,
// shown as plain text in the UI (model-manager.tsx) and never used as a gate.
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';

export type DeviceCapabilities = {
  /** Total device RAM in bytes, from `expo-device`. `null` when the platform/device doesn't report it
   * (e.g. web, or an OEM that withholds it) — treated as "unknown", never as "zero". */
  totalRamBytes: number | null;
  /** Free internal storage in bytes, from `expo-file-system`. `null` on a read failure. */
  freeStorageBytes: number | null;
};

/** Probe RAM + free storage. Never throws — a failed sub-probe just yields `null` for that field. */
export async function probeDeviceCapabilities(): Promise<DeviceCapabilities> {
  const totalRamBytes = typeof Device.totalMemory === 'number' ? Device.totalMemory : null;

  let freeStorageBytes: number | null = null;
  try {
    freeStorageBytes = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    freeStorageBytes = null;
  }

  return { totalRamBytes, freeStorageBytes };
}

/** Fit verdict for one axis: known-good, known-bad, or "can't tell" (never hard-blocks on unknown). */
export type FitVerdict = 'fits' | 'insufficient' | 'unknown';

/** RAM hard-gate: a model whose `minRamBytes` exceeds the device's reported RAM is `insufficient`. */
export function ramFit(capabilities: DeviceCapabilities, minRamBytes: number): FitVerdict {
  if (capabilities.totalRamBytes === null) {
    return 'unknown';
  }
  return capabilities.totalRamBytes >= minRamBytes ? 'fits' : 'insufficient';
}

/** Extra free space required beyond the model's own bytes (temp download buffer + breathing room). */
export const STORAGE_HEADROOM_BYTES = 512 * 1024 * 1024;

/** Storage gate: blocks a download when free space wouldn't cover the file plus headroom. */
export function storageFit(
  capabilities: DeviceCapabilities,
  sizeBytes: number,
  headroomBytes: number = STORAGE_HEADROOM_BYTES,
): FitVerdict {
  if (capabilities.freeStorageBytes === null) {
    return 'unknown';
  }
  return capabilities.freeStorageBytes >= sizeBytes + headroomBytes ? 'fits' : 'insufficient';
}

export { formatBytes } from './format-bytes';
