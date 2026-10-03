// Building the Step-2 join URL a nearby device opens to reach this host.
//
// Extracted from the host screen (`src/app/index.tsx`) so the address-selection logic is unit-testable
// without pulling in the RN / Expo native import graph. Pure — no React, no native modules.

/** The embedded LOAM host server's port (mirrors SERVER_PORT in the host screen and the launcher). */
export const SERVER_PORT = 3000;

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

export type JoinUrlOptions = {
  /** The host's IPv4 addresses as the launcher enumerates them (the shared-WiFi / Pi / laptop case). */
  addresses: string[];
  /** Whether the LocalOnlyHotspot is up — then every joiner is on it and only its address is reachable. */
  hotspotRunning: boolean;
  /**
   * The hotspot's own address once discovered (`src/lib/hotspot-address.ts`). Android assigns it at
   * random per start; there is no fixed gateway to fall back to, so while this is unknown no URL is built.
   */
  hotspotAddress?: string;
  /** The optional transport `#k=` fragment. */
  fragment?: string;
};

/**
 * The full URL (with the optional transport `#k=` fragment) a joiner should open, or `undefined` when no
 * reachable address is known yet — the share screen then says so instead of showing a QR to a guess.
 *
 * `hotspotRunning` is the crux: when the LocalOnlyHotspot is up, EVERY joiner reached us over it, and only
 * its own (randomly assigned) address is reachable from there. The host's other interfaces — e.g. the home
 * WiFi it is simultaneously a client of under STA+AP concurrency — are NOT reachable from the hotspot, so
 * advertising an enumerated LAN address (e.g. `192.168.86.x`) strands the joiner on the wrong network (the
 * 0.4.0 bug), and advertising a fixed `192.168.49.1` strands them on a Wi-Fi Direct address no hotspot
 * ever uses (the 0.5.0 bug). When the hotspot is NOT running (shared-WiFi / Pi / laptop hosting, or a
 * hotspot that failed to start), the real reported LAN address is exactly what a same-network joiner needs.
 */
export function joinUrl(opts: JoinUrlOptions): string | undefined {
  const { addresses, hotspotRunning, hotspotAddress, fragment = '' } = opts;
  const host = hotspotRunning ? hotspotAddress : preferredLanAddress(addresses);
  return host ? `http://${host}:${SERVER_PORT}${fragment}` : undefined;
}

/**
 * The Step-2 display for the host Share overlay: the join URL (if any) plus the addresses to list as
 * "also at" fallbacks. When the hotspot is running, joiners are on it, so the host's other LAN addresses
 * are dropped — they're on the wrong network, and listing them sends a joiner to a dead address. Off the
 * hotspot, the real addresses are the fallbacks a same-network joiner needs. Kept as a pure function so
 * the overlay's derivation is testable without the RN render tree.
 */
export function hostJoinDisplay(opts: JoinUrlOptions): {
  serverUrl: string | undefined;
  addresses: string[];
} {
  return {
    serverUrl: joinUrl(opts),
    addresses: opts.hotspotRunning ? [] : opts.addresses,
  };
}

/**
 * Add the host's invite code (server `invites.ts`) to a join fragment: `#k=<key>&i=<code>`, or `#i=<code>`
 * with no key. The client takes `i=` out before reading `#k=`, then redeems it to skip the approval queue.
 * No code (an open node, or none fetched yet) leaves the fragment as it was.
 */
export function withInviteCode(fragment: string, code: string | undefined): string {
  if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) {
    return fragment;
  }
  return fragment ? `${fragment}&i=${code}` : `#i=${code}`;
}

/**
 * The address to print beside a join QR: the URL without its fragment. The key and invite code (`#k=…&i=…`)
 * only work scanned, and nobody can type them anyway.
 */
export function typedAddress(url: string): string {
  return url.split('#')[0]!;
}
