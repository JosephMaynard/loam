import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  LoamMeshTransportEvents,
  MeshAdvert,
  MeshTransportCapabilities,
} from './LoamMeshTransport.types';

declare class LoamMeshTransportModule extends NativeModule<LoamMeshTransportEvents> {
  /**
   * Report whether this device can be discovered (BLE peripheral mode) and can move bulk bytes
   * (Wi-Fi Aware). Cheap and side-effect-free; call before `startDiscovery` to decide whether to
   * degrade to the BLE-only chunked path or skip the mesh entirely.
   */
  getCapabilities(): Promise<MeshTransportCapabilities>;

  /**
   * The Android runtime permissions the transport needs that are NOT currently granted (on API 31+:
   * `BLUETOOTH_ADVERTISE` / `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` / `NEARBY_WIFI_DEVICES`; pre-31:
   * `ACCESS_FINE_LOCATION`). Empty = ready to start. The OS *prompt* itself is issued from JS via
   * React Native's `PermissionsAndroid` (see `src/mesh/mesh-transport.ts`, mirroring the hotspot
   * module) — this is a pure, side-effect-free check the transport layer uses to decide whether to
   * prompt and to verify the result.
   */
  getMissingPermissions(): Promise<string[]>;

  /** Begin advertising this node's presence beacon over BLE (peripheral + GATT control service). */
  startAdvertising(advert: MeshAdvert): void;
  /** Stop the BLE advertisement. Safe to call when not advertising. */
  stopAdvertising(): void;

  /** Begin scanning for LOAM peers. Emits `onPeerDiscovered` for each fresh match. */
  startDiscovery(): void;
  /** Stop scanning. Safe to call when not scanning. */
  stopDiscovery(): void;

  /**
   * Send one sealed blob (base64) to a discovered `peerId`. Establishes a Wi-Fi Aware data path (or
   * falls back to chunked GATT writes) and transfers the bytes. Resolves once the peer acknowledges
   * receipt at the transport level; rejects on timeout / link failure. Also mirrored as
   * `onTransferComplete` / `onTransferFailed` events for fire-and-forget callers.
   */
  sendBlob(peerId: string, base64: string): Promise<void>;

  /** Tear down all radios (advertise + scan + any open data paths). Idempotent. */
  shutdown(): void;
}

// Android-only native module. `requireOptionalNativeModule` returns `null` on iOS/web and any runtime
// where the module isn't linked (e.g. the Expo Go client, or a build predating this module), so the JS
// wrapper in ../index.ts degrades to a no-op instead of throwing at import time. Callers MUST guard on
// `null` — the mesh is an optional capability layered on the Android host.
export default requireOptionalNativeModule<LoamMeshTransportModule>('LoamMeshTransport');
