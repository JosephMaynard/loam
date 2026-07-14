// Shared types for the `loam-mesh-transport` Expo module (opportunistic-mesh Phase 3 — docs/16 §5,
// docs/17). These describe the wire between JS and the Kotlin BLE / Wi-Fi-Aware transport; they are
// deliberately small — BLE advertisements are ~23 usable bytes, so the advert is a couple of flags
// plus a short group hint, never the sealed payload itself (that rides the Wi-Fi-Aware data path).

/** Which physical transports this device actually supports (checked at runtime — not all phones have
 * Wi-Fi Aware / NAN hardware; some lack BLE peripheral/advertise mode). */
export type MeshTransportCapabilities = {
  /** BLE is present AND the adapter supports peripheral (advertise) mode — required to be discovered. */
  ble: boolean;
  /** `PackageManager.FEATURE_WIFI_AWARE` is present — required for the bulk data-path transfer. When
   * false the module falls back to chunking blobs over a GATT characteristic (slow; see the Kotlin). */
  wifiAware: boolean;
};

/**
 * The tiny presence beacon a host advertises over BLE. It fits a legacy BLE advertisement's service
 * data: a protocol version, a "I'm holding sealed mail worth syncing" hint (so a peer knows a data-path
 * handshake is worthwhile), and a short opaque group hint (e.g. the first bytes of a hash of the shared
 * `sync.token`, so two unrelated LOAM meshes in the same room don't try to pair). NONE of this reveals
 * who the mail is for — routing tags stay inside the sealed relay.
 */
export type MeshAdvert = {
  /** Transport protocol version (bump on any wire-format change so mixed builds can refuse politely). */
  version: number;
  /** True when this node currently holds live sealed blobs it would hand to a peer. */
  haveMail: boolean;
  /** Short base64url group hint (≤ 8 chars) or empty for "any LOAM mesh". Not secret, not addressable. */
  meshHint: string;
};

/** A nearby LOAM host discovered over BLE. `peerId` is an opaque, session-scoped handle the native
 * layer uses to open a data path / send a blob — it is NOT a stable identity and carries no PII. */
export type MeshPeer = {
  peerId: string;
  haveMail: boolean;
  meshHint: string;
  /** Signal strength (dBm) if the scanner reported it, else undefined — a proximity hint only. */
  rssi?: number;
};

/** A sealed blob received from a peer over the transport, base64-encoded for the JS bridge. The JS
 * side does NOT open it — it hands the bytes straight to `POST /api/mesh/inbound`, which runs the
 * existing relay/deliver logic. */
export type MeshTransferReceived = {
  peerId: string;
  /** base64 of the sealed `SealedMessage` JSON as it was transferred. */
  base64: string;
};

/** Outcome events for an outbound `sendBlob`. `transferId` echoes any id the caller threaded through. */
export type MeshTransferResult = {
  peerId: string;
  transferId?: string;
};

export type MeshTransferFailure = {
  peerId: string;
  transferId?: string;
  error: string;
};

export type MeshTransportError = {
  error: string;
};

/** The event map exposed by the native module (Expo `NativeModule<Events>`). */
export type LoamMeshTransportEvents = {
  onPeerDiscovered: (event: MeshPeer) => void;
  onTransferReceived: (event: MeshTransferReceived) => void;
  onTransferComplete: (event: MeshTransferResult) => void;
  onTransferFailed: (event: MeshTransferFailure) => void;
  onTransportError: (event: MeshTransportError) => void;
};
