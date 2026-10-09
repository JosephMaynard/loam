// Public JS surface of the local `loam-hotspot` Expo module (docs/04). It wraps a Kotlin module
// that drives `WifiManager.LocalOnlyHotspot` — Android's supported way to bring up a local-only
// (no internet) hotspot and read back its generated SSID + password, exactly LOAM's off-grid model.
//
// The native module is Android-only and loaded via `requireOptionalNativeModule`, so importing this
// on iOS/web (or before linking) yields a `null` module rather than a crash. Every export guards on
// that, so the host UI can call these unconditionally and handle the graceful-degradation paths.
import { Platform } from 'react-native';

import LoamHotspotModule from './src/LoamHotspotModule';
import type {
  HostServiceLabels,
  HotspotAddressCandidate,
  HotspotCredentials,
  WifiStationInfo,
} from './src/LoamHotspot.types';

export type {
  HostServiceLabels,
  HotspotAddressCandidate,
  HotspotCredentials,
  WifiStationInfo,
} from './src/LoamHotspot.types';

/** True when the native hotspot module is present (Android with the module linked). */
export function isHotspotSupported(): boolean {
  return Platform.OS === 'android' && LoamHotspotModule != null;
}

/**
 * Starts the local-only hotspot and resolves with its generated credentials. Rejects with a clear
 * message when unsupported (non-Android / not linked) or when the native start fails — callers
 * render that message and still show the LOAM-URL QR (docs/04 graceful degradation).
 */
export async function startHotspot(): Promise<HotspotCredentials> {
  if (!LoamHotspotModule) {
    throw new Error('The hotspot is only available on the Android host.');
  }
  return LoamHotspotModule.startHotspot();
}

/**
 * Subscribe to the system stopping the hotspot out from under us — see
 * `LoamHotspotEvents.onHotspotStopped`. Returns an unsubscribe; a no-op subscription when unsupported.
 */
export function addHotspotStoppedListener(handler: () => void): () => void {
  if (!LoamHotspotModule) {
    return () => undefined;
  }
  try {
    const subscription = LoamHotspotModule.addListener('onHotspotStopped', handler);
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}

/**
 * The host's current IPv4 addresses, annotated for the hotspot-address picker (`src/lib/hotspot-address.ts`).
 * Resolves with `[]` when unsupported or when the native enumeration fails — never rejects — so the share
 * screen degrades to its "couldn't detect the address" hint rather than an error.
 */
export async function readHotspotAddressCandidates(): Promise<HotspotAddressCandidate[]> {
  if (!LoamHotspotModule) {
    return [];
  }
  try {
    const candidates = await LoamHotspotModule.hotspotAddressCandidates();
    return Array.isArray(candidates) ? candidates : [];
  } catch {
    return [];
  }
}

/**
 * The phone's Wi-Fi client state for Wi-Fi hosting mode (docs/04 "Hosting modes"). Resolves
 * `{ connected: false }` when unsupported, when the native read fails, or when it answers with something
 * malformed — never rejects — so the share screen shows "connect to Wi-Fi or a wired network first", not an
 * error. Never asks for a permission.
 */
export async function readWifiStationInfo(): Promise<WifiStationInfo> {
  if (!LoamHotspotModule) {
    return { connected: false };
  }
  try {
    const info = (await LoamHotspotModule.wifiStationInfo()) as Partial<WifiStationInfo> | null | undefined;
    if (!info || typeof info !== 'object') {
      return { connected: false };
    }
    return {
      connected: info.connected === true,
      address: typeof info.address === 'string' && info.address.length > 0 ? info.address : null,
      ssid: typeof info.ssid === 'string' && info.ssid.length > 0 ? info.ssid : null,
      wired: info.wired === true,
    };
  } catch {
    return { connected: false };
  }
}

/** Stops the hotspot if one is running. A no-op when unsupported, and never throws. */
export function stopHotspot(): void {
  try {
    LoamHotspotModule?.stopHotspot();
  } catch {
    // Best effort: releasing a hotspot that's already gone (or a native hiccup during teardown)
    // must not surface — callers treat stop as fire-and-forget.
  }
}

/**
 * Start a foreground service so the host keeps serving while the screen is off / the app is
 * backgrounded (docs/04). Idempotent. Returns whether the start went through (false when unsupported or
 * refused — API 31+ refuses from the background); never throws. `labels` is the notification's text in
 * the app's language (a repeat start re-posts the notification with the labels it carries). Prefer
 * `ensureHostService` (src/lib/host-service.ts), which also handles the notification permission and
 * foreground timing and supplies the labels.
 */
export function startHostService(labels?: HostServiceLabels): boolean {
  try {
    if (!LoamHotspotModule) {
      return false;
    }
    return (labels ? LoamHotspotModule.startHostService(labels) : LoamHotspotModule.startHostService()) === true;
  } catch {
    // Best effort — the host still works while foregrounded even if the service can't start.
    return false;
  }
}

/** Stop the foreground host service. A no-op when unsupported; never throws. */
export function stopHostService(): void {
  try {
    LoamHotspotModule?.stopHostService();
  } catch {
    // Best effort.
  }
}

/**
 * Enter kiosk mode: pin the app via Android screen pinning (lock-task) so it can't be left without
 * the device's screen-lock PIN. A no-op when unsupported; never throws.
 */
export function startKiosk(): void {
  try {
    LoamHotspotModule?.startKiosk();
  } catch {
    // Best effort — kiosk is optional; hosting continues regardless.
  }
}

/**
 * Close LOAM completely (hotspot, host service, screen pinning, task and process), so the next launch is a
 * clean start on the setup screens. Used after an Emergency reset. A no-op when unsupported; never throws.
 */
export function closeApp(): void {
  try {
    LoamHotspotModule?.closeApp();
  } catch {
    // Best effort.
  }
}

/** Leave kiosk mode (unpin the app). A no-op when unsupported; never throws. */
export function stopKiosk(): void {
  try {
    LoamHotspotModule?.stopKiosk();
  } catch {
    // Best effort.
  }
}
