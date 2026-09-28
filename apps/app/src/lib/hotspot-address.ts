// Finding the local-only hotspot's own address among the host phone's interfaces.
//
// Android assigns a LocalOnlyHotspot a RANDOM IPv4 address on every start — a /24 somewhere in
// 192.168.0.0/16, 172.16.0.0/12 or 10.0.0.0/8 (the last one ~94% of the time since Android 16), host part
// never .0/.1/.255 (packages/modules/Connectivity `PrivateAddressCoordinator`). `192.168.49.1`, which the
// join QR used to assume, is reserved for Wi-Fi Direct group owners and is never a hotspot's address, so a
// joiner got ERR_ADDRESS_UNREACHABLE. There is no API that hands an app the hotspot's address, so the
// native module enumerates every (interface, IPv4) pair with two hints — whether the interface belongs to
// a network the phone is a CLIENT of (`upstream`), and whether the address existed before the hotspot was
// started (`preexisting`) — and this pure, tested module scores them. Kept free of React/native imports.
import type { HotspotAddressCandidate } from '../../modules/loam-hotspot/src/LoamHotspot.types';

import { isPrivate10or172 } from './join-url';

export type { HotspotAddressCandidate } from '../../modules/loam-hotspot/src/LoamHotspot.types';

/**
 * Interface-name prefixes that can never carry a hotspot a nearby phone joins: VPN/tunnel adapters, the
 * cellular radio (`rmnet*`, `ccmni*`, and the 464xlat `clat*`/`v4-*` shims on top of it) and container/
 * virtual devices. Case-insensitive. `bridge*` is deliberately NOT here — some ROMs bridge the AP onto
 * one (docs/25 HW1).
 */
const NEVER_HOTSPOT_PREFIXES = ['tun', 'utun', 'tailscale', 'wg', 'ppp', 'rmnet', 'ccmni', 'clat', 'v4-', 'dummy', 'docker', 'veth'];

/** Interface names Android/OEM Wi-Fi stacks use for the SoftAP: Samsung `swlan0`, AOSP `ap0`/`softap0`,
 * Qualcomm concurrency `wlan1`. `wlan0` is usually the Wi-Fi CLIENT, so it earns nothing here — on a
 * single-interface phone that flips wlan0 into AP mode, the "new since start" signal identifies it. */
const HOTSPOT_LIKE_NAME = /^(swlan|ap\d|softap|wlan1\b|wifi_ap|wl_ap)/i;

/** Score at or above which a candidate is trusted as the hotspot's address (see {@link scoreHotspotCandidate}). */
export const CONFIDENT_SCORE = 3;

/** RFC 1918 private address. */
export function isPrivateIPv4(address: string): boolean {
  return address.startsWith('192.168.') || isPrivate10or172(address);
}

function isNeverHotspotName(name: string): boolean {
  const lower = name.toLowerCase();
  return NEVER_HOTSPOT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Candidates that could be the hotspot at all: not a tunnel/cellular/virtual interface, and not a network
 * the phone is a client of. This is also the list shown to the operator as "this host's addresses" when
 * no single one can be trusted.
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
  /** Its score (≥ {@link CONFIDENT_SCORE}). */
  score: number;
  /** The other eligible candidates, best first. */
  alternatives: HotspotAddressCandidate[];
};

/**
 * The hotspot's address, or `undefined` when none of the candidates can be trusted — the caller then
 * shows the manual fallback (the joiner's Wi-Fi "Gateway" address) rather than a guess presented as ready.
 * Ties keep the input order, which follows the OS enumeration.
 */
export function pickHotspotAddress(candidates: HotspotAddressCandidate[]): HotspotAddressPick | undefined {
  const ranked = eligibleHotspotCandidates(candidates)
    .map((candidate, index) => ({ candidate, score: scoreHotspotCandidate(candidate), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0];
  if (!best || best.score < CONFIDENT_SCORE) {
    return undefined;
  }
  return {
    candidate: best.candidate,
    score: best.score,
    alternatives: ranked.slice(1).map((entry) => entry.candidate),
  };
}

/** `swlan0 10.71.3.140` — one candidate for the operator-facing diagnostics line. */
export function describeHotspotCandidate(candidate: HotspotAddressCandidate): string {
  return `${candidate.name} ${candidate.address}`;
}
