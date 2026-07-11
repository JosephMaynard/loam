export type QRVersion = 4 | 5 | 6;

/**
 * Error correction level. `H` (~30% recovery) is the long-standing default for LOAM's small
 * join-link QRs. `M` (~15% recovery) roughly doubles byte capacity at each version — used for the
 * WiFi payload, whose SSID + passphrase can otherwise exceed version 6-H (docs/15 #10). `L`/`Q`
 * are not implemented (no capacity/format-info tables for them yet).
 */
export type QRErrorCorrectionLevel = "M" | "H";

export type QRMatrix = {
  version: QRVersion;
  size: number;
  data: boolean[];
};

export type InternalMatrix = {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
};

export type EncodeOptions = {
  version?: QRVersion;
  /** Error correction level; defaults to `"H"` (unchanged behaviour for existing callers). */
  ecLevel?: QRErrorCorrectionLevel;
};
