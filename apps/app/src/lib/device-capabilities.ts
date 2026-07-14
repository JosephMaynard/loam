// Device capability probe for the on-device LLM model manager (docs/06). Reports the two axes LOAM
// actually enforces as gates — RAM and free storage — and nothing else.
//
// Deliberately NOT reported: a GPU/NPU capability flag. Android exposes no clean public API to
// enumerate an on-device inference accelerator (vendor NNAPI/GPU delegate support varies wildly and
// isn't queryable in a way a generic app can trust), so fabricating a "has GPU" badge would be a lie
// dressed up as a fact. `ACCELERATOR_NOTE` is the honest best-effort substitute — surfaced as plain
// text in the UI, never used as a gate.
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';

export type DeviceCapabilities = {
  /** Total device RAM in bytes, from `expo-device`. `null` when the platform/device doesn't report it
   * (e.g. web, or an OEM that withholds it) — treated as "unknown", never as "zero". */
  totalRamBytes: number | null;
  /** Free internal storage in bytes, from `expo-file-system`. `null` on a read failure. */
  freeStorageBytes: number | null;
  /** Best-effort, honest caveat about hardware acceleration — see the module comment. Always present,
   * never a pass/fail signal. */
  acceleratorNote: string;
};

export const ACCELERATOR_NOTE =
  'GPU/NPU acceleration is best-effort and device-dependent. Android has no public API LOAM can use ' +
  'to confirm a given phone has one, so this is not shown as a capability check — inference may fall ' +
  'back to CPU-only on any device.';

/** Probe RAM + free storage. Never throws — a failed sub-probe just yields `null` for that field. */
export async function probeDeviceCapabilities(): Promise<DeviceCapabilities> {
  const totalRamBytes = typeof Device.totalMemory === 'number' ? Device.totalMemory : null;

  let freeStorageBytes: number | null = null;
  try {
    freeStorageBytes = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    freeStorageBytes = null;
  }

  return { totalRamBytes, freeStorageBytes, acceleratorNote: ACCELERATOR_NOTE };
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

/** Human-readable byte size (binary units — matches how RAM/storage are usually quoted). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return 'unknown';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
