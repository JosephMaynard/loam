/** The credentials for the local-only hotspot, as reported by `WifiManager.LocalOnlyHotspot`. */
export type HotspotCredentials = {
  /** The generated SSID (network name) devices connect to. */
  ssid: string;
  /** The generated WPA2 passphrase. */
  password: string;
};
