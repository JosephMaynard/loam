// Finding the local-only hotspot's own address among the host phone's interfaces.
//
// Android assigns a LocalOnlyHotspot a RANDOM IPv4 address on every start — a /24 somewhere in
// 192.168.0.0/16, 172.16.0.0/12 or 10.0.0.0/8 (the last one ~94% of the time since Android 16), host part
// never .0/.1/.255 (packages/modules/Connectivity `PrivateAddressCoordinator`). `192.168.49.1`, which the
// join QR used to assume, is reserved for Wi-Fi Direct group owners and is never a hotspot's address, so a
// joiner got ERR_ADDRESS_UNREACHABLE. There is no API that hands an app the hotspot's address, so the
// native module enumerates every (interface, IPv4) pair with two hints — whether the interface belongs to
// a network the phone is a CLIENT of (`upstream`), and whether the address existed before the hotspot was
// started (`preexisting`) — the launcher's own enumeration is merged in as a second source, a joiner that
// has actually connected confirms the interface its address falls in, and this pure, tested module scores
// it all. Kept free of React/native imports.
import type { HotspotAddressCandidate } from '../../modules/loam-hotspot/src/LoamHotspot.types';

import { isPrivate10or172 } from './join-url';

export type { HotspotAddressCandidate } from '../../modules/loam-hotspot/src/LoamHotspot.types';

/** An (interface, address) pair as the launcher enumerates it (`loam-hostinfo`). */
export type HostInterface = { name: string; address: string; prefixLength?: number };

/**
 * Interface-name prefixes that can never carry the hotspot a nearby phone joins: VPN/tunnel adapters, the
 * cellular radio (`rmnet*`, `ccmni*`, and the 464xlat `clat*`/`v4-*` shims on top of it), USB tethering
 * (`rndis*`/`usb*`/`ncm*`), Bluetooth tethering (`bt-pan`), Wi-Fi Direct (`p2p*`) and container/virtual
 * devices. Case-insensitive. `bridge*` is deliberately NOT here — some ROMs bridge the AP onto one (docs/25
 * HW1).
 */
const NEVER_HOTSPOT_PREFIXES = [
  'tun',
  'utun',
  'tailscale',
  'wg',
  'ppp',
  'rmnet',
  'ccmni',
  'clat',
  'v4-',
  'rndis',
  'usb',
  'ncm',
  'bt-pan',
  'p2p',
  'dummy',
  'docker',
  'veth',
];

/** Interface names Android/OEM Wi-Fi stacks use for the SoftAP: Samsung `swlan0`, AOSP `ap0`/`softap0`,
 * Qualcomm concurrency `wlan1`. `wlan0` is usually the Wi-Fi CLIENT, so it earns nothing here — on a
 * single-interface phone that flips wlan0 into AP mode, the "new since start" signal identifies it. */
const HOTSPOT_LIKE_NAME = /^(swlan|ap\d|softap|wlan1\b|wifi_ap|wl_ap)/i;

/** Score at or above which a candidate is trusted as the hotspot's address (see {@link scoreHotspotCandidate}). */
export const CONFIDENT_SCORE = 3;

/** Added to a candidate whose subnet a CONNECTED joiner's address falls in — proof, not inference. */
export const CLIENT_CONFIRMED_BONUS = 100;

/** RFC 1918 private address. */
export function isPrivateIPv4(address: string): boolean {
  return address.startsWith('192.168.') || isPrivate10or172(address);
}

function isNeverHotspotName(name: string): boolean {
  const lower = name.toLowerCase();
  return NEVER_HOTSPOT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Dotted IPv4 → unsigned 32-bit integer, or `undefined` for anything else. */
function ipv4ToInt(address: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) {
    return undefined;
  }
  let value = 0;
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(match[index]);
    if (octet > 255) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value;
}

/** Whether `address` lies in the candidate's subnet (its prefix length, or /24 — what Android's tethering
 * assigns — when the source didn't report one). */
export function subnetContains(candidate: HotspotAddressCandidate, address: string): boolean {
  const base = ipv4ToInt(candidate.address);
  const target = ipv4ToInt(address);
  if (base === undefined || target === undefined) {
    return false;
  }
  const prefix = candidate.prefixLength ?? 24;
  if (prefix <= 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return ((base & mask) >>> 0) === ((target & mask) >>> 0);
}

/**
 * Candidates that could be the hotspot at all: not a tunnel/cellular/USB/Bluetooth/virtual interface, and
 * not a network the phone is a client of. This is also the list shown to the operator as "this host's
 * addresses" when no single one can be trusted.
 */
export function eligibleHotspotCandidates(candidates: HotspotAddressCandidate[]): HotspotAddressCandidate[] {
  return candidates.filter(
    (candidate) =>
      typeof candidate.address === 'string' &&
      candidate.address.length > 0 &&
      typeof candidate.name === 'string' &&
      candidate.name.length > 0 &&
      !isNeverHotspotName(candidate.name) &&
      candidate.upstream !== true,
  );
}

/**
 * One list from both enumerations. The native module's entries win (they carry the upstream/pre-existing
 * hints); the launcher's `os.networkInterfaces()` view adds any pair the native side missed — a different
 * code path to the same kernel data, so it survives a Java-side `SocketException` on an odd ROM — with
 * `preexisting` judged against `launcherSnapshot`, the launcher's list as it stood just before the hotspot
 * was started (`undefined` when none had arrived by then: then the launcher can't tell, and says so).
 */
export function mergeHotspotCandidates(
  native: HotspotAddressCandidate[],
  launcher: HostInterface[],
  launcherSnapshot: string[] | undefined,
): HotspotAddressCandidate[] {
  const merged = new Map<string, HotspotAddressCandidate>();
  for (const candidate of native) {
    merged.set(`${candidate.name}|${candidate.address}`, candidate);
  }
  for (const entry of launcher) {
    const key = `${entry.name}|${entry.address}`;
    const existing = merged.get(key);
    const fromSnapshot = launcherSnapshot ? launcherSnapshot.includes(entry.address) : null;
    if (existing) {
      // Fill hints the native side couldn't give.
      if (existing.preexisting == null && fromSnapshot !== null) {
        merged.set(key, { ...existing, preexisting: fromSnapshot });
      }
      if (existing.prefixLength === undefined && entry.prefixLength !== undefined) {
        merged.set(key, { ...merged.get(key)!, prefixLength: entry.prefixLength });
      }
      continue;
    }
    merged.set(key, {
      name: entry.name,
      address: entry.address,
      ...(entry.prefixLength !== undefined ? { prefixLength: entry.prefixLength } : {}),
      preexisting: fromSnapshot,
    });
  }
  return [...merged.values()];
}

/**
 * How strongly a candidate looks like the hotspot's own address. Two strong signals — the address
 * appeared with the hotspot (+4), or the interface is named like a SoftAP (+3) — each clear
 * {@link CONFIDENT_SCORE} alone; an address that existed before the hotspot started can't be its (−4); a
 * private address is a mild plus, a non-private one a mild minus. Deliberately additive so a device that
 * lacks one signal (an OEM-named AP, a snapshot that couldn't be taken) still resolves on the other.
 */
export function scoreHotspotCandidate(candidate: HotspotAddressCandidate): number {
  let score = 0;
  if (candidate.preexisting === false) {
    score += 4;
  } else if (candidate.preexisting === true) {
    score -= 4;
  }
  if (HOTSPOT_LIKE_NAME.test(candidate.name)) {
    score += 3;
  }
  score += isPrivateIPv4(candidate.address) ? 1 : -1;
  return score;
}

export type HotspotAddressPick = {
  /** The chosen hotspot address. */
  candidate: HotspotAddressCandidate;
  /** Its score, including the client-confirmation bonus when one applied. */
  score: number;
  /** True when a connected joiner's address lies in this candidate's subnet — the path is proven. */
  confirmed: boolean;
  /** The other eligible candidates, best first. */
  alternatives: HotspotAddressCandidate[];
};

/**
 * The hotspot's address, or `undefined` when none of the candidates can be trusted — the caller then
 * shows the manual fallback (the joiner's Wi-Fi "Gateway" address) rather than a guess presented as ready.
 *
 * Decision, in order: a candidate whose subnet contains a connected joiner (`clientAddresses`) wins
 * outright — that interface is demonstrably serving joiners; then the best score at or above
 * {@link CONFIDENT_SCORE}; then, when the phone's own networks were positively ruled out (`upstream ===
 * false` comes only from a successful native check) and exactly ONE private, not-known-pre-existing
 * candidate is left, that one — on a phone with no other Wi-Fi, the sole leftover is the hotspot even if
 * its interface has an unfamiliar name. Confirmation only ever reorders ELIGIBLE candidates: a laptop on
 * the host's home Wi-Fi must not turn that (upstream) interface into the advertised address. Ties keep the
 * input order, which follows the OS enumeration.
 */
export function pickHotspotAddress(
  candidates: HotspotAddressCandidate[],
  options: { clientAddresses?: string[] } = {},
): HotspotAddressPick | undefined {
  const clients = options.clientAddresses ?? [];
  const eligible = eligibleHotspotCandidates(candidates);
  const ranked = eligible
    .map((candidate, index) => {
      // The server already drops the host's own addresses; guard again here so a self-connection can never
      // confirm anything even if that changes.
      const confirmed = clients.some((client) => client !== candidate.address && subnetContains(candidate, client));
      return { candidate, confirmed, score: scoreHotspotCandidate(candidate) + (confirmed ? CLIENT_CONFIRMED_BONUS : 0), index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0];
  if (!best) {
    return undefined;
  }
  const soleHintedLeftover =
    eligible.length === 1 &&
    best.candidate.upstream === false &&
    best.candidate.preexisting !== true &&
    isPrivateIPv4(best.candidate.address);
  if (!best.confirmed && best.score < CONFIDENT_SCORE && !soleHintedLeftover) {
    return undefined;
  }
  return {
    candidate: best.candidate,
    score: best.score,
    confirmed: best.confirmed,
    alternatives: ranked.slice(1).map((entry) => entry.candidate),
  };
}

/** `swlan0 10.71.3.140` — one candidate for the operator-facing diagnostics line. */
export function describeHotspotCandidate(candidate: HotspotAddressCandidate): string {
  return `${candidate.name} ${candidate.address}`;
}
