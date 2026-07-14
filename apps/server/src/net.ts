import { networkInterfaces } from "node:os";

/**
 * Best non-internal IPv4 address across all network interfaces, scanned fresh on every call.
 *
 * Shared by `server.ts` (which resolves it once at boot, for the desktop/Pi CLI where the LAN
 * address is stable before the process starts) and `app.ts` (which — when no explicit `joinHost`
 * override is configured — resolves it again on every `/api/bootstrap` / `/api/config` response, so
 * a join QR generated in the web UI reflects the address that's reachable *right now* rather than
 * one frozen at boot). That distinction matters on the Android host: the Wi-Fi hotspot interface
 * comes up *after* the embedded server starts (docs/04, docs/15 A7), so a boot-time scan can miss it
 * entirely or capture a stale earlier address.
 *
 * Falls back to `"localhost"` when no such interface exists (e.g. local dev with networking off).
 */
export function resolveLanIPv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "localhost";
}
