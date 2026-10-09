// The runtime permissions behind `WifiManager.startLocalOnlyHotspot` (docs/04), as a pure decision so the
// request list and the grant rule are unit-tested without React Native. `src/hooks/use-hotspot.ts` maps the
// names onto `PermissionsAndroid` and shows the dialog; the manifest side is `plugins/with-loam-host.js`.
//
// Two Android rules shape this:
//
//   - Android 12+ (API 31) requires an app that asks for ACCESS_FINE_LOCATION to ask for
//     ACCESS_COARSE_LOCATION in the same request, and on some Android 12 releases a fine-only request is
//     ignored outright (no dialog, logcat "ACCESS_FINE_LOCATION must be requested with
//     ACCESS_COARSE_LOCATION"), so a fresh install there could never start the hotspot. Both are therefore
//     requested together on every API level; below 31 they are one permission group anyway.
//   - Below API 33 LocalOnlyHotspot is location-gated and needs FINE location: a user who picks
//     "Approximate" on the dialog grants coarse only, which is a denial for the hotspot. From API 33 the
//     call is gated on NEARBY_WIFI_DEVICES instead; the manifest marks it `neverForLocation`, so the
//     location answer does not decide the outcome there.

/** A permission the hotspot flow requests, by its `PermissionsAndroid.PERMISSIONS` key. */
export type HotspotPermission = 'ACCESS_FINE_LOCATION' | 'ACCESS_COARSE_LOCATION' | 'NEARBY_WIFI_DEVICES';

/** First API level (Android 13) where NEARBY_WIFI_DEVICES exists and gates `startLocalOnlyHotspot`. */
export const NEARBY_WIFI_DEVICES_API_LEVEL = 33;

/**
 * What to put in the one `requestMultiple` call for a device on `apiLevel`: fine and coarse location
 * together on every level, plus NEARBY_WIFI_DEVICES from API 33. An unknown level (0) is treated as
 * pre-33, which asks for the smaller set and applies the stricter rule.
 */
export function hotspotPermissionsToRequest(apiLevel: number): HotspotPermission[] {
  const wanted: HotspotPermission[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'];
  if (apiLevel >= NEARBY_WIFI_DEVICES_API_LEVEL) {
    wanted.push('NEARBY_WIFI_DEVICES');
  }
  return wanted;
}

/**
 * Whether the permissions in `granted` let `startLocalOnlyHotspot` run on `apiLevel`: NEARBY_WIFI_DEVICES
 * from API 33, ACCESS_FINE_LOCATION before it. Coarse location alone is never enough, and on API 33+ the
 * location permissions are not consulted at all.
 */
export function hotspotStartPermitted(apiLevel: number, granted: ReadonlySet<HotspotPermission>): boolean {
  return apiLevel >= NEARBY_WIFI_DEVICES_API_LEVEL
    ? granted.has('NEARBY_WIFI_DEVICES')
    : granted.has('ACCESS_FINE_LOCATION');
}
