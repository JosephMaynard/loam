// Public JS surface of the local `loam-mesh-transport` Expo module (opportunistic-mesh Phase 3 —
// docs/16 §5, docs/17). It wraps a Kotlin module that drives Android BLE discovery (advertise + scan +
// a small GATT control service) and Wi-Fi Aware (NAN) bulk transfer, to carry the mesh's already-built
// sealed-sender blobs between nearby LOAM hosts with NO infrastructure (no AP, no internet).
//
// The native module is Android-only and loaded via `requireOptionalNativeModule`, so importing this on
// iOS/web (or in a build without the module linked) yields a `null` module rather than a crash. Every
// export below guards on that, so callers can use them unconditionally and handle the graceful-
// degradation paths (the whole mesh is optional; the host keeps working without it).
//
// This layer is a THIN, typed pass-through. The transport carries opaque bytes only — it never opens,
// verifies, or reasons about a sealed blob; all crypto/relay rules stay server-side in the existing
// mesh code. The pull/push orchestration lives one level up (src/mesh/mesh-transport.ts + the launcher
// bridge in nodejs-project-template/main.js).
import { Platform } from 'react-native';

import LoamMeshTransportModule from './src/LoamMeshTransportModule';
import type {
  LoamMeshTransportEvents,
  MeshAdvert,
  MeshTransportCapabilities,
} from './src/LoamMeshTransport.types';

export type {
  LoamMeshTransportEvents,
  MeshAdvert,
  MeshPeer,
  MeshTransferReceived,
  MeshTransferResult,
  MeshTransferFailure,
  MeshTransportError,
  MeshTransportCapabilities,
} from './src/LoamMeshTransport.types';

/** The wire-format version this build speaks. Bump on any advert/transfer format change. */
export const MESH_TRANSPORT_PROTOCOL_VERSION = 1;

/** True when the native transport module is present (Android with the module linked). */
export function isMeshTransportSupported(): boolean {
  return Platform.OS === 'android' && LoamMeshTransportModule != null;
}

/**
 * Which physical transports this device can actually use. Returns `{ ble:false, wifiAware:false }`
 * (never throws) when the module is absent, so a caller can branch without a try/catch.
 */
export async function getMeshCapabilities(): Promise<MeshTransportCapabilities> {
  if (!LoamMeshTransportModule) {
    return { ble: false, wifiAware: false };
  }
  try {
    return await LoamMeshTransportModule.getCapabilities();
  } catch {
    return { ble: false, wifiAware: false };
  }
}

/**
 * The BLE + Wi-Fi-Aware runtime permissions this device still needs (empty = ready). Returns `[]`
 * when the module is absent so a caller can branch without a try/catch. The actual OS prompt is issued
 * by the transport layer with `PermissionsAndroid` (see `src/mesh/mesh-transport.ts`).
 */
export async function getMissingMeshPermissions(): Promise<string[]> {
  if (!LoamMeshTransportModule) {
    return [];
  }
  try {
    return await LoamMeshTransportModule.getMissingPermissions();
  } catch {
    return [];
  }
}

/** Start advertising this node's presence beacon. A no-op when unsupported; never throws. */
export function startMeshAdvertising(advert: MeshAdvert): void {
  try {
    LoamMeshTransportModule?.startAdvertising(advert);
  } catch {
    // Best effort — advertising is a background nicety; failing must not disturb hosting.
  }
}

/** Stop advertising. A no-op when unsupported; never throws. */
export function stopMeshAdvertising(): void {
  try {
    LoamMeshTransportModule?.stopAdvertising();
  } catch {
    // Best effort.
  }
}

/** Start scanning for nearby LOAM peers. A no-op when unsupported; never throws. */
export function startMeshDiscovery(): void {
  try {
    LoamMeshTransportModule?.startDiscovery();
  } catch {
    // Best effort.
  }
}

/** Stop scanning. A no-op when unsupported; never throws. */
export function stopMeshDiscovery(): void {
  try {
    LoamMeshTransportModule?.stopDiscovery();
  } catch {
    // Best effort.
  }
}

/**
 * Send one base64 sealed blob to a discovered peer. Rejects on link failure/timeout (mirrored as an
 * `onTransferFailed` event); resolves on transport-level ack. Rejects immediately when unsupported so
 * a caller's promise chain still settles.
 */
export async function sendMeshBlob(peerId: string, base64: string): Promise<void> {
  if (!LoamMeshTransportModule) {
    throw new Error('The mesh transport is only available on the Android host.');
  }
  return LoamMeshTransportModule.sendBlob(peerId, base64);
}

/** Tear down every radio (advertise + scan + open data paths). A no-op when unsupported; never throws. */
export function shutdownMeshTransport(): void {
  try {
    LoamMeshTransportModule?.shutdown();
  } catch {
    // Best effort.
  }
}

/**
 * Subscribe to a native transport event. Returns an unsubscribe function (a no-op when unsupported).
 * Typed against the module's event map so listeners get the right payload shape.
 */
export function addMeshListener<E extends keyof LoamMeshTransportEvents>(
  event: E,
  listener: LoamMeshTransportEvents[E],
): () => void {
  if (!LoamMeshTransportModule) {
    return () => undefined;
  }
  const subscription = LoamMeshTransportModule.addListener(event, listener);
  return () => subscription.remove();
}
