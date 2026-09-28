/** The credentials for the local-only hotspot, as reported by `WifiManager.LocalOnlyHotspot`. */
export type HotspotCredentials = {
  /** The generated SSID (network name) devices connect to. */
  ssid: string;
  /** The generated WPA2 passphrase. */
  password: string;
};

/**
 * One (interface, IPv4 address) pair the host device holds, as enumerated natively by
 * `hotspotAddressCandidates` (loopback and link-local excluded). Android gives the local-only hotspot a
 * RANDOM address per start, so the hotspot's own address has to be found among these — see
 * `src/lib/hotspot-address.ts` for the scoring that picks it.
 */
export type HotspotAddressCandidate = {
  /** OS interface name: `wlan0` (usually the Wi-Fi client), `swlan0`/`ap0`/`wlan1` (usually the hotspot). */
  name: string;
  /** Dotted IPv4 address. */
  address: string;
  /** IPv4 prefix length of the interface (e.g. 24). Absent when the source didn't report one. */
  prefixLength?: number;
  /**
   * True when the interface belongs to a network the phone is a client of with internet capability (home
   * Wi-Fi, mobile data, VPN), or the address is the Wi-Fi client's own per WifiManager — never the hotspot
   * the phone serves. False when the native check ran and cleared it. `null`/absent when unknown: the
   * check failed, or the address came from the embedded Node's enumeration instead of the native module.
   */
  upstream?: boolean | null;
  /**
   * Whether the address already existed just before the hotspot was last started; the hotspot's own
   * address is the one that is NOT pre-existing. `null`/absent when no start happened in this process or
   * the source can't tell.
   */
  preexisting?: boolean | null;
};

/**
 * The Wi-Fi network the phone is a CLIENT of (station mode), as `wifiStationInfo` reports it — what Wi-Fi
 * hosting mode advertises (docs/04 "Hosting modes"). Read without any permission prompt.
 */
export type WifiStationInfo = {
  /** True when the phone holds a Wi-Fi network (any, not only the default one) or a Wi-Fi DHCP address. */
  connected: boolean;
  /** The station's own IPv4 address per WifiManager (DHCP / connection info); null/absent when none. */
  address?: string | null;
  /** The network name, or null/absent — Android redacts it unless location permission was already granted. */
  ssid?: string | null;
};

/** Native → JS events. `onHotspotStopped` fires when the SYSTEM tears the hotspot down (tethering
 * enabled, Wi-Fi toggled, OEM power policy) — never for our own `stopHotspot()`. */
export type LoamHotspotEvents = {
  onHotspotStopped: () => void;
};
