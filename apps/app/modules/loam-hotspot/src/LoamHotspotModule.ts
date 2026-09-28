import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  HotspotAddressCandidate,
  HotspotCredentials,
  LoamHotspotEvents,
  WifiStationInfo,
} from './LoamHotspot.types';

declare class LoamHotspotModule extends NativeModule<LoamHotspotEvents> {
  /**
   * Starts a `WifiManager.LocalOnlyHotspot` and resolves with its generated credentials.
   * Rejects (code `ERR_HOTSPOT`) if the hotspot can't start — no WiFi hardware (emulator),
   * missing location permission, or a driver failure.
   */
  startHotspot(): Promise<HotspotCredentials>;
  /** Closes the hotspot reservation. Safe to call when no hotspot is running. */
  stopHotspot(): void;
  /**
   * Every IPv4 address the device holds right now, annotated so JS can tell the hotspot's own interface
   * from the phone's other networks (see `HotspotAddressCandidate`). Resolves with an empty list — never
   * rejects — when enumeration fails.
   */
  hotspotAddressCandidates(): Promise<HotspotAddressCandidate[]>;
  /**
   * The Wi-Fi network the phone is a client of (`connected`, station `address`, `ssid`), for Wi-Fi hosting
   * mode. Never requests a permission; resolves `{ connected: false }` — never rejects — on any failure.
   */
  wifiStationInfo(): Promise<WifiStationInfo>;
  /** Start a foreground service so the host survives screen-off / backgrounding. Best-effort; returns
   * false when the platform refused (e.g. API 31+ while the app is in the background). */
  startHostService(): boolean;
  /** Stop the foreground host service. */
  stopHostService(): void;
  /** Pin the app (Android screen pinning / lock-task) so it can't be left without the device PIN. */
  startKiosk(): void;
  /** Unpin the app (leave lock-task mode). */
  stopKiosk(): void;
}

// Android-only native module: `requireOptionalNativeModule` returns `null` on iOS/web (and any
// runtime where the module isn't linked) instead of throwing at import time, so the JS wrapper in
// index.ts can degrade gracefully. Callers must guard on `null`.
export default requireOptionalNativeModule<LoamHotspotModule>('LoamHotspot');
