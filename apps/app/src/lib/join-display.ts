// What the host Share overlay's Step 2 shows, derived from the hotspot state, the native address findings
// and the launcher's interface list. Pure (type-only imports from the hook/component), so the derivation
// is unit-tested without the RN render tree — `host-share-overlay.tsx` is glue over these two functions.
import type { HostState } from '@/components/host-panel';
import type { HotspotState } from '@/hooks/use-hotspot';

import {
  describeHotspotCandidate,
  eligibleHotspotCandidates,
  pickHotspotAddress,
  type HotspotAddressCandidate,
} from './hotspot-address';
import { hostJoinDisplay } from './join-url';

/** An (interface, address) pair as the launcher enumerates it (`loam-hostinfo`). */
export type HostInterface = { name: string; address: string };

export type JoinDisplay = {
  serverUrl: string | undefined;
  addresses: string[];
  /** `interface address` lines for the manual fallback. */
  detected: string[];
};

/** The `interfaces` field of a `loam-hostinfo` payload, validated entry by entry (malformed ones dropped). */
export function parseHostInterfaces(value: unknown): HostInterface[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: HostInterface[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      typeof (entry as { address?: unknown }).address === 'string'
    ) {
      out.push({ name: (entry as HostInterface).name, address: (entry as HostInterface).address });
    }
  }
  return out;
}

/**
 * Step 2's URL and lists. While the hotspot runs, only its own discovered address is advertised — a
 * joiner on the hotspot can't reach the host's home-WiFi address (the 0.4.0 STA+AP bug) and there is no
 * fixed gateway to guess (the 0.5.0 `192.168.49.1` bug) — so no URL is built until it is known. The
 * launcher's interface list (names only) is the picker's fallback when the native enumeration came back
 * empty: same getifaddrs underneath, so it rarely knows more, but it costs nothing and keeps the
 * diagnostics line populated. Off the hotspot, the launcher's addresses are what a same-network joiner needs.
 */
export function deriveJoinDisplay(opts: {
  hotspot: HotspotState;
  addresses: string[];
  interfaces: HostInterface[];
  fragment: string;
}): JoinDisplay {
  const { hotspot, addresses, interfaces, fragment } = opts;
  const hotspotRunning = hotspot.phase === 'running';
  const nativeCandidates = hotspot.candidates ?? [];
  const launcherCandidates: HotspotAddressCandidate[] = interfaces.map((entry) => ({
    name: entry.name,
    address: entry.address,
  }));
  const fallbackPick =
    hotspotRunning && !hotspot.address && hotspot.addressSearch === 'settled' && nativeCandidates.length === 0
      ? pickHotspotAddress(launcherCandidates)
      : undefined;
  const hotspotAddress = hotspot.address ?? fallbackPick?.candidate.address;
  const { serverUrl, addresses: shownAddresses } = hostJoinDisplay({
    addresses,
    hotspotRunning,
    hotspotAddress,
    fragment,
  });
  const detected = (nativeCandidates.length > 0 ? nativeCandidates : eligibleHotspotCandidates(launcherCandidates)).map(
    describeHotspotCandidate,
  );
  return { serverUrl, addresses: shownAddresses, detected };
}

/** Project the hotspot lifecycle + Step-2 display onto the presentational HostPanel state (docs/04). */
export function toHostPanelState(hotspot: HotspotState, display: JoinDisplay): HostState {
  const { serverUrl, addresses, detected } = display;
  if (hotspot.phase === 'running' && hotspot.credentials) {
    return {
      status: 'running',
      hotspot: hotspot.credentials,
      serverUrl,
      addresses,
      // No URL while running means the hotspot's own address isn't known: still probing, or nothing
      // trustworthy was found and the operator gets the manual route.
      hotspotAddress: serverUrl ? undefined : hotspot.addressSearch === 'settled' ? 'unknown' : 'searching',
      detected,
    };
  }
  if (hotspot.phase === 'error') {
    // Hotspot couldn't start — surface the reason in Step 1 but keep Step 2's URL QR so LOAM stays
    // reachable to anyone already on this network (the graceful-degradation path the emulator hits).
    return { status: 'stopped', hotspotError: hotspot.error, serverUrl, addresses };
  }
  return { status: 'starting', serverUrl, addresses };
}
