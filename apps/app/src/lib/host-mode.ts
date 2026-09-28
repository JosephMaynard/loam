// The Android host's two hosting modes (docs/04 "Hosting modes: hotspot or the phone's Wi-Fi"):
//
//   - `hotspot` (the default): the phone brings up its own LocalOnlyHotspot and joiners scan a Wi-Fi QR,
//     then a URL QR. Works with no router and no internet — LOAM's off-grid identity.
//   - `wifi`: the phone serves on the Wi-Fi network it has already joined (home, office, event router).
//     No hotspot and no location permission; joiners on the same network scan one URL QR.
//
// Pure (type-only imports), so the mode parsing, the Wi-Fi address choice and the panel projection are
// unit-tested without the RN render tree; `use-host-mode.ts` and `host-share-overlay.tsx` are glue.
import type { HostState } from '@/components/host-panel';

import type { WifiStationInfo } from '../../modules/loam-hotspot/src/LoamHotspot.types';
import { isNeverHotspotName, isPrivateIPv4, type HostInterface } from './hotspot-address';
import { preferredLanAddress, SERVER_PORT } from './join-url';

export type { WifiStationInfo } from '../../modules/loam-hotspot/src/LoamHotspot.types';

export type HostMode = 'hotspot' | 'wifi';

/** Hotspot first: it works anywhere, and the mode toggle is the first thing on the share screen. */
export const DEFAULT_HOST_MODE: HostMode = 'hotspot';

/** The expo-secure-store item holding the persisted mode (not secret; stored beside the DB-encryption mode). */
export const HOST_MODE_ITEM = 'loam.hostMode';

/** A stored value → a mode. Anything unknown (absent, garbled, a future mode) falls back to the default. */
export function parseHostMode(raw: unknown): HostMode {
  return raw === 'hotspot' || raw === 'wifi' ? raw : DEFAULT_HOST_MODE;
}

/** Dotted-quad IPv4 that can carry a join URL: not unspecified (0.0.0.0), loopback or link-local. */
function isUsableIpv4(address: unknown): address is string {
  if (typeof address !== 'string') {
    return false;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match || match.slice(1).some((octet) => Number(octet) > 255)) {
    return false;
  }
  return address !== '0.0.0.0' && !address.startsWith('127.') && !address.startsWith('169.254.');
}

/** `wlan0`, `wlan1`… — the Wi-Fi client interface on every Android phone seen so far. */
const WLAN_NAME = /^wlan(\d+)$/i;

/**
 * Addresses the launcher reported that could reach a same-network joiner: usable IPv4, private, and not on
 * an interface that is never a LAN (cellular `rmnet*`/`ccmni*`, tunnels, USB/Bluetooth tethers — carriers
 * hand out 10.x addresses too, so "private" alone would let a mobile-data address onto the join QR).
 */
function lanAddresses(interfaces: HostInterface[], addresses: string[]): string[] {
  const neverLan = new Set(interfaces.filter((entry) => isNeverHotspotName(entry.name)).map((entry) => entry.address));
  return addresses.filter((address) => isUsableIpv4(address) && isPrivateIPv4(address) && !neverLan.has(address));
}

/**
 * The address to advertise in Wi-Fi mode, or `undefined` when the phone is on no Wi-Fi network (then the
 * share screen asks the operator to connect first — no QR to a guess). In order:
 *   1. the native station address — WifiManager's DHCP / connection info, the address the router gave
 *      this phone, the most direct answer there is;
 *   2. else a launcher-reported `wlan<N>` interface with a private address (lowest N first) — the embedded
 *      Node's own enumeration, for a ROM where the WifiManager read comes back empty;
 *   3. else {@link preferredLanAddress} over the launcher's private, non-cellular addresses.
 */
export function pickWifiAddress(opts: {
  station: WifiStationInfo | undefined;
  interfaces: HostInterface[];
  addresses: string[];
}): string | undefined {
  const { station, interfaces, addresses } = opts;
  if (station && isUsableIpv4(station.address)) {
    return station.address;
  }
  const wlan = interfaces
    .map((entry, index) => ({ entry, index, unit: WLAN_NAME.exec(entry.name)?.[1] }))
    .filter(({ entry, unit }) => unit !== undefined && isUsableIpv4(entry.address) && isPrivateIPv4(entry.address))
    .sort((a, b) => Number(a.unit) - Number(b.unit) || a.index - b.index)[0];
  if (wlan) {
    return wlan.entry.address;
  }
  return preferredLanAddress(lanAddresses(interfaces, addresses));
}

export type WifiJoinDisplay = {
  /** The join URL (with the transport `#k=` fragment), or `undefined` when the phone is on no Wi-Fi. */
  serverUrl: string | undefined;
  /** The host's other LAN addresses, for the "also at" line. */
  addresses: string[];
  /** The Wi-Fi network's name when Android let us read it without a prompt. */
  ssid: string | undefined;
  /** Devices connected to the server from off this phone (distinct peer addresses). */
  connectedClients: number;
  /** Whether the native station state has been read at least once since the screen opened. */
  checked: boolean;
};

/** Everything the Wi-Fi-mode panel shows, from the native station read and the launcher's lists. */
export function deriveWifiJoinDisplay(opts: {
  station: WifiStationInfo | undefined;
  interfaces: HostInterface[];
  addresses: string[];
  connectedClients: string[];
  fragment: string;
}): WifiJoinDisplay {
  const { station, interfaces, addresses, connectedClients, fragment } = opts;
  const address = pickWifiAddress({ station, interfaces, addresses });
  return {
    serverUrl: address ? `http://${address}:${SERVER_PORT}${fragment}` : undefined,
    addresses: [...new Set(lanAddresses(interfaces, addresses))].filter((entry) => entry !== address),
    ssid: typeof station?.ssid === 'string' && station.ssid.length > 0 ? station.ssid : undefined,
    connectedClients: new Set(connectedClients).size,
    checked: station !== undefined,
  };
}

/**
 * Project the Wi-Fi display onto the presentational panel: `starting` until the first station read lands,
 * `running` once there is an address to advertise, `stopped` while the phone is on no Wi-Fi network.
 */
export function toWifiPanelState(display: WifiJoinDisplay): HostState {
  const { serverUrl, addresses, ssid, connectedClients, checked } = display;
  const status: HostState['status'] = serverUrl ? 'running' : checked ? 'stopped' : 'starting';
  return {
    mode: 'wifi',
    status,
    serverUrl,
    addresses,
    connectedClients,
    ...(ssid ? { wifiNetwork: ssid } : {}),
  };
}
