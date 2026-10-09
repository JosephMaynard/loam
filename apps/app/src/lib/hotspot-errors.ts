// What the operator reads when the hotspot can't start. The Kotlin module (LoamHotspotModule.kt) rejects
// with an explicit `ERR_HOTSPOT_*` code and an English message meant for logcat; this maps the code to the
// host catalog so the share screen shows it in the operator's language. Pure, so it is unit-tested.
import { hotspotAsksForLocation } from './hotspot-permissions';
import type { AppCatalogKey } from './i18n';

/** The catalog key for each code the native module sends. */
const HOTSPOT_ERROR_KEYS: Readonly<Record<string, AppCatalogKey>> = {
  ERR_HOTSPOT_BUSY: 'hotspot.errBusy',
  ERR_HOTSPOT_UNAVAILABLE: 'hotspot.errNoWifi',
  ERR_HOTSPOT_NO_CREDENTIALS: 'hotspot.errNoCredentials',
  ERR_HOTSPOT_NO_CHANNEL: 'hotspot.errNoChannel',
  ERR_HOTSPOT_INCOMPATIBLE_MODE: 'hotspot.errIncompatibleMode',
  ERR_HOTSPOT_TETHERING_DISALLOWED: 'hotspot.errTetheringDisallowed',
  ERR_HOTSPOT_FAILED: 'hotspot.errFailed',
  // JS-side: use-hotspot.ts gives up on a native start that never settles.
  ERR_HOTSPOT_TIMEOUT: 'hotspot.startTimeout',
};

/** An Error carrying one of the codes above, for failures raised on the JS side. */
export function hotspotError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Every code mapped here, for the test that keeps the Kotlin module and this map in step. */
export const HOTSPOT_ERROR_CODES: readonly string[] = [...Object.keys(HOTSPOT_ERROR_KEYS), 'ERR_HOTSPOT_PERMISSION'];

/**
 * The catalog key for a failed `startHotspot`, from the rejection's `code`. A missing permission names the
 * dialog the running API level shows (nearby devices from 33, location before); anything unknown reads as
 * the generic failure, never as raw English.
 */
export function hotspotErrorKey(error: unknown, apiLevel: number): AppCatalogKey {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'ERR_HOTSPOT_PERMISSION') {
    return hotspotAsksForLocation(apiLevel) ? 'hotspot.permissionDenied' : 'hotspot.permissionDeniedNearby';
  }
  return (typeof code === 'string' && HOTSPOT_ERROR_KEYS[code]) || 'hotspot.errFailed';
}
