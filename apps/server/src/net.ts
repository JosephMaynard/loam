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

// Preference tiers over the private-LAN (RFC1918) ranges, to pick "the address a nearby joiner can
// actually reach" on the desktop/Pi host (where the server enumerates its own interfaces): a
// `192.168.49.*` address first (the Wi-Fi Direct group-owner subnet — a laptop sharing over Wi-Fi Direct
// is reached there), then any 192.168.*, then 10.*/172.16-31.*. NOTE: the Android host does NOT use this
// heuristic — Android assigns its LocalOnlyHotspot a random address per start, so the host app discovers
// it natively (apps/app/modules/loam-hotspot `hotspotAddressCandidates` + apps/app/src/lib/hotspot-address.ts)
// and `joinUrl` (apps/app/src/lib/join-url.ts) advertises only that while the hotspot runs.
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
/** `::ffff:10.8.0.2` (an IPv4 peer on a dual-stack listener) → `10.8.0.2`; anything else unchanged. */
function unmapIPv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

/** Loopback in any spelling: `127.0.0.0/8`, `::1`, or the IPv4-mapped form. */
export function isLoopbackPeer(address: string): boolean {
  const plain = unmapIPv4(address);
  return plain === "::1" || plain.startsWith("127.");
}

/**
 * The distinct peer addresses among `peers` that are NOT this host itself: loopback dropped (the Android
 * host's own WebView, a same-host proxy), IPv4-mapped IPv6 unmapped so a joiner shows up once in its
 * dotted form, sorted for a stable answer. This is what the Android share screen turns into "1 phone
 * connected" and uses to confirm which interface the hotspot is on (a joiner's address lies in its subnet).
 */
export function remoteClientAddresses(peers: Iterable<string | undefined>): string[] {
  const distinct = new Set<string>();
  for (const peer of peers) {
    if (typeof peer !== "string" || peer.length === 0 || isLoopbackPeer(peer)) {
      continue;
    }
    distinct.add(unmapIPv4(peer));
  }
  return [...distinct].sort();
}

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
