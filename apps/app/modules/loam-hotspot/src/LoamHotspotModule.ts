import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { HotspotCredentials } from './LoamHotspot.types';

declare class LoamHotspotModule extends NativeModule {
  /**
   * Starts a `WifiManager.LocalOnlyHotspot` and resolves with its generated credentials.
   * Rejects (code `ERR_HOTSPOT`) if the hotspot can't start — no WiFi hardware (emulator),
   * missing location permission, or a driver failure.
   */
  startHotspot(): Promise<HotspotCredentials>;
  /** Closes the hotspot reservation. Safe to call when no hotspot is running. */
  stopHotspot(): void;
  /** Start a foreground service so the host survives screen-off / backgrounding. Best-effort. */
  startHostService(): void;
  /** Stop the foreground host service. */
  stopHostService(): void;
}

// Android-only native module: `requireOptionalNativeModule` returns `null` on iOS/web (and any
// runtime where the module isn't linked) instead of throwing at import time, so the JS wrapper in
// index.ts can degrade gracefully. Callers must guard on `null`.
export default requireOptionalNativeModule<LoamHotspotModule>('LoamHotspot');
