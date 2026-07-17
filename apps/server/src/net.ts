import { networkInterfaces } from "node:os";

/**
 * Interface name prefixes that belong to a VPN/tunnel adapter rather than the physical LAN (F3,
 * docs/15 A7): `tun`/`utun` (OS-level TUN devices, incl. many VPN clients), `tailscale` (Tailscale's
 * `tailscale0`), `wg` (WireGuard), `ppp` (point-to-point links). An address on one of these is
 * reachable only through the tunnel — never to a nearby device scanning the join QR — so picking one
 * for the join host would silently break joining. Matched case-insensitively against the OS-reported
 * interface name.
 */
const TUNNEL_INTERFACE_PREFIXES = ["tun", "utun", "tailscale", "wg", "ppp"];

function isTunnelInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return TUNNEL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// Preference tiers over the private-LAN (RFC1918) ranges, matching the order the Android host's own
// join-QR heuristic uses (`hotspotJoinUrl` in apps/app/src/app/index.tsx): the stock Android
// LocalOnlyHotspot gateway first (the common case on-device), then any 192.168.*, then 10.*/172.16-31.*.
// Kept in sync deliberately — both pick "the address a nearby joiner can actually reach" from the same
// set of live interfaces, just via different OS APIs (RN's `os.networkInterfaces()` vs this module's).
const isHotspotGateway = (address: string): boolean => address.startsWith("192.168.49.");
const isPrivate192 = (address: string): boolean => address.startsWith("192.168.");
const isPrivate10or172 = (address: string): boolean =>
  address.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

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
 * Two refinements (F3) keep it from picking an address a nearby joiner can't actually reach:
 * addresses on a VPN/tunnel interface ({@link TUNNEL_INTERFACE_PREFIXES}) are excluded outright, and
 * among what's left, private-LAN ranges are preferred over anything else (e.g. a carrier-assigned or
 * otherwise public address some interface happens to report) — see the tier functions above for the
 * exact order, matched to the client-side hotspot heuristic.
 *
 * Falls back to `"localhost"` when no such interface exists (e.g. local dev with networking off).
 */
export function resolveLanIPv4(): string {
  const candidates: string[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (isTunnelInterface(name)) {
      continue;
    }

    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push(address.address);
      }
    }
  }

  return (
    candidates.find(isHotspotGateway) ??
    candidates.find(isPrivate192) ??
    candidates.find(isPrivate10or172) ??
    candidates[0] ??
    "localhost"
  );
}
