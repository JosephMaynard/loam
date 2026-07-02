// Public JS surface of the local `loam-hotspot` Expo module (docs/04). It wraps a Kotlin module
// that drives `WifiManager.LocalOnlyHotspot` — Android's supported way to bring up a local-only
// (no internet) hotspot and read back its generated SSID + password, exactly LOAM's off-grid model.
//
// The native module is Android-only and loaded via `requireOptionalNativeModule`, so importing this
// on iOS/web (or before linking) yields a `null` module rather than a crash. Every export guards on
// that, so the host UI can call these unconditionally and handle the graceful-degradation paths.
import { Platform } from 'react-native';

import LoamHotspotModule from './src/LoamHotspotModule';
import type { HotspotCredentials } from './src/LoamHotspot.types';

export type { HotspotCredentials } from './src/LoamHotspot.types';

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

/** Stops the hotspot if one is running. A no-op when unsupported, and never throws. */
export function stopHotspot(): void {
  try {
    LoamHotspotModule?.stopHotspot();
  } catch {
    // Best effort: releasing a hotspot that's already gone (or a native hiccup during teardown)
    // must not surface — callers treat stop as fire-and-forget.
  }
}
