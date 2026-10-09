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
 * A wired adapter: Android's Ethernet stack names them `eth<N>` (a laptop's own port, a USB-C dock), some
 * builds use Linux's `en…` names. `usb<N>`/`rndis<N>` are deliberately NOT wired here: on a phone they are the
 * USB-tethering downstream, reachable only by the tethered computer, so advertising them would mislead. Case-insensitive.
 */
const WIRED_NAME = /^(eth|en)/i;

/** Whether an interface name is a wired adapter's, see {@link WIRED_NAME}. */
export function isWiredName(name: string): boolean {
  return WIRED_NAME.test(name);
}

/** The first launcher-reported wired interface with a usable private address, or `undefined`. */
function wiredAddress(interfaces: HostInterface[]): string | undefined {
  return interfaces.find((entry) => isWiredName(entry.name) && isUsableIpv4(entry.address) && isPrivateIPv4(entry.address))
    ?.address;
}

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
 * The address to advertise in Wi-Fi mode, or `undefined` when the device is on no Wi-Fi or wired network
 * (then the share screen asks the operator to connect first — no QR to a guess). In order:
 *   1. the native station address — WifiManager's DHCP / connection info, the address the router gave
 *      this phone, the most direct answer there is;
 *   2. else, while Android reports NO Wi-Fi network: a launcher-reported wired adapter (`eth*`, `en*`)
 *      with a private address — a laptop docked on Ethernet serves the same people a
 *      Wi-Fi station would; or, when the native read says a wired network exists but the launcher names
 *      its interface differently, {@link preferredLanAddress} over the launcher's private, non-cellular
 *      addresses; else nothing (a VPN tunnel, the phone's own tethering hotspot or a dead LocalOnlyHotspot
 *      interface the launcher hasn't dropped yet must never reach the join QR);
 *   3. else — on Wi-Fi, or before the first native read — a launcher-reported `wlan<N>` interface with a
 *      private address (lowest N first): the embedded Node's own enumeration, for a ROM where the
 *      WifiManager read comes back empty;
 *   4. else a wired adapter as in 2;
 *   5. else {@link preferredLanAddress} over the launcher's private, non-cellular addresses.
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
  const wired = wiredAddress(interfaces);
  if (station && !station.connected) {
    if (wired) {
      return wired;
    }
    return station.wired ? preferredLanAddress(lanAddresses(interfaces, addresses)) : undefined;
  }
  const wlan = interfaces
    .map((entry, index) => ({ entry, index, unit: WLAN_NAME.exec(entry.name)?.[1] }))
    .filter(({ entry, unit }) => unit !== undefined && isUsableIpv4(entry.address) && isPrivateIPv4(entry.address))
    .sort((a, b) => Number(a.unit) - Number(b.unit) || a.index - b.index)[0];
  if (wlan) {
    return wlan.entry.address;
  }
  return wired ?? preferredLanAddress(lanAddresses(interfaces, addresses));
}

export type WifiJoinDisplay = {
  /** The join URL (with the transport `#k=` fragment), or `undefined` when the device is on no network. */
  serverUrl: string | undefined;
  /** The host's other LAN addresses, for the "also at" line. */
  addresses: string[];
  /** The Wi-Fi network's name when Android let us read it without a prompt (never when `wired`). */
  ssid: string | undefined;
  /**
   * Whether the advertised address is a wired adapter's (a laptop docked on Ethernet): the panel then names
   * the connection as wired instead of showing, or asking for, a Wi-Fi network.
   */
  wired: boolean;
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
  // Wired when the address sits on a wired-named interface, or when Android reports no Wi-Fi network but a
  // wired one (then whatever the fallback found is the wired network's).
  const wired =
    address !== undefined &&
    (interfaces.some((entry) => entry.address === address && isWiredName(entry.name)) ||
      (station?.connected === false && station.wired === true));
  return {
    serverUrl: address ? `http://${address}:${SERVER_PORT}${fragment}` : undefined,
    addresses: [...new Set(lanAddresses(interfaces, addresses))].filter((entry) => entry !== address),
    ssid: !wired && typeof station?.ssid === 'string' && station.ssid.length > 0 ? station.ssid : undefined,
    wired,
    connectedClients: new Set(connectedClients).size,
    checked: station !== undefined,
  };
}

/**
 * Project the Wi-Fi display onto the presentational panel: `starting` until the first station read lands,
 * `running` once there is an address to advertise, `stopped` while the device is on no Wi-Fi or wired
 * network.
 */
export function toWifiPanelState(display: WifiJoinDisplay): HostState {
  const { serverUrl, addresses, ssid, wired, connectedClients, checked } = display;
  const status: HostState['status'] = serverUrl ? 'running' : checked ? 'stopped' : 'starting';
  return {
    mode: 'wifi',
    status,
    serverUrl,
    addresses,
    connectedClients,
    ...(ssid ? { wifiNetwork: ssid } : {}),
    ...(wired ? { wired: true } : {}),
  };
}
