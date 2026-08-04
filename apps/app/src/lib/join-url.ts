// Building the Step-2 join URL a nearby device opens to reach this host.
//
// Extracted from the host screen (`src/app/index.tsx`) so the address-selection logic is unit-testable
// without pulling in the RN / Expo native import graph. Pure — no React, no native modules.

/** The embedded LOAM host server's port (mirrors SERVER_PORT in the host screen and the launcher). */
export const SERVER_PORT = 3000;

/**
 * Stock-Android LocalOnlyHotspot gateway. The SoftAP interface is NOT visible to the embedded Node's
 * `os.networkInterfaces()` (it lives in a different network namespace), so the launcher can never
 * enumerate it — but LocalOnlyHotspot and Wi-Fi tethering use 192.168.49.1 as the gateway on stock
 * Android. Not guaranteed on every OEM, but the de-facto default; a device that differs would need the
 * native module to report its actual AP address (future work).
 */
export const HOTSPOT_GATEWAY = '192.168.49.1';

/** RFC-1918 10.0.0.0/8 or 172.16.0.0/12 (192.168.* is handled separately by the caller). */
export function isPrivate10or172(address: string): boolean {
  return address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/**
 * Preferred LAN address for shared-network hosting — host and joiners on the same existing WiFi, or a
 * Pi/laptop host: a `192.168.*` address first, then a 10/172 private address, then whatever was
 * reported. Returns `undefined` when nothing usable was reported.
 */
export function preferredLanAddress(addresses: string[]): string | undefined {
  return (
    addresses.find((address) => address.startsWith('192.168.')) ??
    addresses.find(isPrivate10or172) ??
    addresses[0]
  );
}

/**
 * The full URL (with the optional transport `#k=` fragment) a joiner should open.
 *
 * `hotspotRunning` is the crux, and the fix for the STA+AP dual-connection bug: when the LocalOnlyHotspot
 * is up, EVERY joiner reached us over that hotspot, whose gateway is {@link HOTSPOT_GATEWAY}. The host's
 * other interfaces — e.g. the home WiFi it is simultaneously connected to under STA+AP concurrency
 * (Pixel and other modern flagships) — are NOT reachable from the hotspot, and the embedded Node can't
 * even see the AP interface, so advertising an enumerated LAN address (e.g. `192.168.86.x`) strands the
 * joiner on the wrong network. When the hotspot is NOT running (shared-WiFi / Pi / laptop hosting, or a
 * hotspot that failed to start), the real reported LAN address is exactly what a same-network joiner
 * needs, so we use it.
 */
export function joinUrl(opts: { addresses: string[]; hotspotRunning: boolean; fragment?: string }): string {
  const { addresses, hotspotRunning, fragment = '' } = opts;
  const host = hotspotRunning ? HOTSPOT_GATEWAY : (preferredLanAddress(addresses) ?? HOTSPOT_GATEWAY);
  return `http://${host}:${SERVER_PORT}${fragment}`;
}
