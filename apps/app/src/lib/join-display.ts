// What the host Share overlay's Step 2 shows, derived from the hotspot state (which already folds in the
// native candidates, the launcher's interfaces and the connected joiners — see use-hotspot.ts) and the
// launcher's flat address list. Pure (type-only imports from the hook/component), so the derivation is
// unit-tested without the RN render tree — `host-share-overlay.tsx` is glue over these functions.
import type { HostState } from '@/components/host-panel';
import type { HotspotState } from '@/hooks/use-hotspot';

import { describeHotspotCandidate, type HostInterface } from './hotspot-address';
import { hostJoinDisplay } from './join-url';

export type { HostInterface } from './hotspot-address';

export type JoinDisplay = {
  serverUrl: string | undefined;
  addresses: string[];
  /** `interface address` lines for the manual fallback. */
  detected: string[];
  /** Devices connected to the server from off this phone (distinct peer addresses). */
  connectedClients: number;
  /** The transport `#k=` fragment, so the manual route can carry it too. */
  fragment: string;
};

/** The `interfaces` field of a `loam-hostinfo` payload, validated entry by entry (malformed ones dropped). */
export function parseHostInterfaces(value: unknown): HostInterface[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: HostInterface[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { name, address, prefixLength } = entry as { name?: unknown; address?: unknown; prefixLength?: unknown };
    if (typeof name !== 'string' || typeof address !== 'string') {
      continue;
    }
    const parsed: HostInterface = { name, address };
    if (typeof prefixLength === 'number' && Number.isInteger(prefixLength) && prefixLength >= 0 && prefixLength <= 32) {
      parsed.prefixLength = prefixLength;
    }
    out.push(parsed);
  }
  return out;
}

/** The `clients` field of a `loam-hostinfo` payload: the connected peers' addresses, or `undefined` when
 * the launcher couldn't ask the server this tick (the previous answer then stands). */
export function parseHostClients(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Step 2's URL and lists. While the hotspot runs, only its own discovered address is advertised — a
 * joiner on the hotspot can't reach the host's home-WiFi address (the 0.4.0 STA+AP bug) and there is no
 * fixed gateway to guess (the 0.5.0 `192.168.49.1` bug) — so no URL is built until it is known. Off the
 * hotspot, the launcher's addresses are what a same-network joiner needs.
 */
export function deriveJoinDisplay(opts: {
  hotspot: HotspotState;
  addresses: string[];
  connectedClients: string[];
  fragment: string;
}): JoinDisplay {
  const { hotspot, addresses, connectedClients, fragment } = opts;
  const hotspotRunning = hotspot.phase === 'running';
  const { serverUrl, addresses: shownAddresses } = hostJoinDisplay({
    addresses,
    hotspotRunning,
    hotspotAddress: hotspot.address,
    fragment,
  });
  return {
    serverUrl,
    addresses: shownAddresses,
    detected: (hotspot.candidates ?? []).map(describeHotspotCandidate),
    connectedClients: new Set(connectedClients).size,
    fragment,
  };
}

/** Project the hotspot lifecycle + Step-2 display onto the presentational HostPanel state (docs/04). */
export function toHostPanelState(hotspot: HotspotState, display: JoinDisplay): HostState {
  const { serverUrl, addresses, detected, connectedClients, fragment } = display;
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
      connectedClients,
      manualFragment: fragment,
    };
  }
  if (hotspot.phase === 'error') {
    // Hotspot couldn't start — surface the reason in Step 1 but keep Step 2's URL QR so LOAM stays
    // reachable to anyone already on this network (the graceful-degradation path the emulator hits).
    return { status: 'stopped', hotspotError: hotspot.error, serverUrl, addresses, connectedClients };
  }
  return { status: 'starting', serverUrl, addresses, connectedClients };
}
