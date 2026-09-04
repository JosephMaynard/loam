/** The credentials for the local-only hotspot, as reported by `WifiManager.LocalOnlyHotspot`. */
export type HotspotCredentials = {
  /** The generated SSID (network name) devices connect to. */
  ssid: string;
  /** The generated WPA2 passphrase. */
  password: string;
};

/** Native → JS events. `onHotspotStopped` fires when the SYSTEM tears the hotspot down (tethering
 * enabled, Wi-Fi toggled, OEM power policy) — never for our own `stopHotspot()`. */
export type LoamHotspotEvents = {
  onHotspotStopped: () => void;
};
