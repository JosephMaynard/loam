// The runtime permissions behind `WifiManager.startLocalOnlyHotspot` (docs/04), as a pure decision so the
// request list and the grant rule are unit-tested without React Native. `src/hooks/use-hotspot.ts` maps the
// names onto `PermissionsAndroid` and shows the dialog; the manifest side is `plugins/with-loam-host.js`.
//
// The rule, per API level:
//
//   - API 33+ (Android 13): `startLocalOnlyHotspot` is gated on NEARBY_WIFI_DEVICES, which the manifest
//     marks `neverForLocation`, so that is the ONLY permission requested: no location dialog, and no
//     "Approximate" choice to get wrong. This is what lets the manifest cap ACCESS_FINE_LOCATION and
//     ACCESS_COARSE_LOCATION at `maxSdkVersion="32"`, since nothing asks for them on 33+ (a request for a
//     permission the manifest doesn't declare at the running level auto-denies with no dialog).
//   - API 31-32 (Android 12): location-gated, and FINE is required. Android 12 needs a fine request to carry
//     coarse in the same dialog (some releases ignore a fine-only request outright: no dialog, logcat
//     "ACCESS_FINE_LOCATION must be requested with ACCESS_COARSE_LOCATION"), so both are requested. A user
//     who picks "Approximate" grants coarse only, which is a denial for the hotspot.
//   - Below 31: the same fine + coarse request (one permission group there) and the same FINE rule.

/** A permission the hotspot flow requests, by its `PermissionsAndroid.PERMISSIONS` key. */
export type HotspotPermission = 'ACCESS_FINE_LOCATION' | 'ACCESS_COARSE_LOCATION' | 'NEARBY_WIFI_DEVICES';

/** First API level (Android 13) where NEARBY_WIFI_DEVICES exists and gates `startLocalOnlyHotspot`. */
export const NEARBY_WIFI_DEVICES_API_LEVEL = 33;

/** The last API level the hotspot asks for location on. The manifest caps both location permissions here
 * (`android:maxSdkVersion`), so the two move together; a plugin test checks they agree. */
export const LOCATION_PERMISSION_MAX_SDK = NEARBY_WIFI_DEVICES_API_LEVEL - 1;

/**
 * What to put in the one `requestMultiple` call for a device on `apiLevel`: NEARBY_WIFI_DEVICES alone from
 * API 33, fine and coarse location together below it. An unknown level (0) is treated as pre-33.
 */
export function hotspotPermissionsToRequest(apiLevel: number): HotspotPermission[] {
  return apiLevel >= NEARBY_WIFI_DEVICES_API_LEVEL
    ? ['NEARBY_WIFI_DEVICES']
    : ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'];
}

/**
 * Whether the permissions in `granted` let `startLocalOnlyHotspot` run on `apiLevel`: NEARBY_WIFI_DEVICES
 * from API 33, ACCESS_FINE_LOCATION before it. Coarse location alone is never enough.
 */
export function hotspotStartPermitted(apiLevel: number, granted: ReadonlySet<HotspotPermission>): boolean {
  return apiLevel >= NEARBY_WIFI_DEVICES_API_LEVEL
    ? granted.has('NEARBY_WIFI_DEVICES')
    : granted.has('ACCESS_FINE_LOCATION');
}

/** Whether the hotspot asks for location on `apiLevel` (else for nearby Wi-Fi devices). The share screen's
 * explanation and the "permission denied" message follow this, so neither names the wrong dialog. */
export function hotspotAsksForLocation(apiLevel: number): boolean {
  return apiLevel < NEARBY_WIFI_DEVICES_API_LEVEL;
}

/** The running device's API level on Android, 0 when unknown (treated as pre-33 everywhere above). */
export function androidApiLevel(version: unknown): number {
  return typeof version === 'number' ? version : 0;
}
